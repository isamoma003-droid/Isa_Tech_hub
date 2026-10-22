/**
 * The one place a payment changes state.
 *
 * Three paths can learn how an STK push ended: Safaricom's callback, a platform polling
 * GET /v1/payments/:id, and the background sweep. Every transition below is a single
 * conditional update that only matches a payment not already in the target state, so exactly
 * one path wins and each platform hears about each outcome once (the pattern egertickets'
 * paymentStatusService uses).
 *
 * Transitions:
 *   pending → paid | failed | disputed
 *   failed  → paid | disputed      (a late success: the money really moved, so it wins)
 */
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';
import { PaymentLink } from '../models/PaymentLink.js';
import { Till } from '../models/Till.js';
import { HttpError } from '../utils/httpError.js';
import { DarajaError, stkPush, stkQuery } from './daraja.js';
import { audit } from './audit.js';
import { mailEnabled, sendMail } from './mailer.js';
import { emailTemplate } from './emailTemplate.js';
import { enqueuePaymentEvent } from './webhooks.js';

const TILL_SECRETS = '+consumerKey +consumerSecret +passkey +callbackSecret';
export const loadTill = (id) => Till.findById(id).select(TILL_SECRETS);

// One STK prompt per phone at a time: Safaricom rejects a second one anyway.
const PHONE_BUSY_MS = 60_000;
// After this long with no answer, a payment counts as failed (a late success still wins).
export const GIVE_UP_MS = 10 * 60_000;
// A push that never got a CheckoutRequestID (the server stopped mid-request) is failed after this.
const ORPHAN_MS = 2 * 60_000;
const MAX_EVENTS = 50;
const RECEIPT_EMAIL_RETRY_MS = 30_000;
const logPayment = (level, event, details) => console[level](JSON.stringify({ service: 'isapay', event, ...details }));

const pushEvent = (type, source, extra = {}) => ({
  $push: { events: { $each: [{ at: new Date(), type, source, ...extra }], $slice: -MAX_EVENTS } },
});

const isDuplicateKey = (err) => err?.code === 11000;

/**
 * Starts a payment: records it, then asks Safaricom to send the PIN prompt.
 * @returns {Promise<{ payment, replayed: boolean, error?: string }>}
 */
export async function createPayment(platform, { phone, amount, reference, purpose, description, metadata, idempotencyKey, paymentLink, singleUseLink, customerName, customerEmail }) {
  // Same key, same answer: a platform retrying after a timeout must not prompt the payer twice.
  if (idempotencyKey) {
    const existing = await Payment.findOne({ platform: platform._id, idempotencyKey });
    if (existing) return { payment: existing, replayed: true };
  }

  const till = await loadTill(platform.till?._id || platform.till);
  if (!till?.active) throw new HttpError(503, "This platform's till is not available right now");

  const busy = await Payment.exists({ phone, status: 'pending', createdAt: { $gt: new Date(Date.now() - PHONE_BUSY_MS) } });
  if (busy) throw new HttpError(409, 'A payment request was just sent to this phone. Check it, or try again in a minute.');

  let payment;
  try {
    payment = await Payment.create({
      platform: platform._id,
      paymentLink,
      singleUseLink,
      till: till._id,
      reference,
      idempotencyKey,
      purpose,
      description,
      metadata,
      phone,
      customerName,
      customerEmail,
      amount,
      events: [{ type: 'created', source: 'api' }],
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      if (idempotencyKey) {
        const existing = await Payment.findOne({ platform: platform._id, idempotencyKey });
        if (existing) return { payment: existing, replayed: true };
      }
      if (paymentLink) throw new HttpError(409, 'A payment is already in progress for this link. Check the payer phone or try again shortly.');
    }
    throw err;
  }

  try {
    const result = await stkPush(till, {
      phone,
      amount,
      accountReference: platform.accountReference || platform.name,
      description: description || platform.name,
    });
    const updated = await Payment.findByIdAndUpdate(
      payment._id,
      {
        $set: { checkoutRequestId: result.checkoutRequestId, merchantRequestId: result.merchantRequestId },
        ...pushEvent('stk.sent', 'daraja', { data: { checkoutRequestId: result.checkoutRequestId } }),
      },
      { returnDocument: 'after' },
    );
    return { payment: updated, replayed: false };
  } catch (err) {
    if (!(err instanceof DarajaError)) throw err;
    console.warn(`STK push for payment ${payment.id} refused: ${err.message}`);
    // Refused before a prompt was sent: nothing can settle it later, so it fails now. The platform
    // gets the error in the response, not a webhook.
    const failed = await Payment.findByIdAndUpdate(
      payment._id,
      {
        $set: { status: 'failed', failedAt: new Date(), resultDesc: err.message },
        ...pushEvent('stk.refused', 'daraja', { note: err.message }),
      },
      { returnDocument: 'after' },
    );
    await releasePaymentLink(failed);
    return { payment: failed, replayed: false, error: "We couldn't reach M-Pesa. Please try again in a moment." };
  }
}

/** Records a confirmed payment. Amount differences are parked as "disputed" for a person to look at. */
export async function markPaid(payment, { receipt, paidAmount, source, note }) {
  const now = new Date();
  const mismatch = paidAmount !== undefined && paidAmount !== null && Math.round(paidAmount) !== Math.round(payment.amount);
  const set = {
    status: mismatch ? 'disputed' : 'paid',
    paidAt: now,
    paidAmount: paidAmount ?? payment.amount,
    resultCode: 0,
    resultDesc: mismatch ? `M-Pesa reported KES ${paidAmount}, expected KES ${payment.amount}` : 'Payment received',
  };
  if (receipt) {
    set.receipt = receipt;
    if (payment.paymentLink && payment.customerEmail) set.receiptEmailQueuedAt = now;
  }

  const apply = (fields, eventNote) =>
    Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['pending', 'failed'] } },
      { $set: fields, $unset: { failedAt: 1 }, ...pushEvent(`status.${fields.status}`, source, { note: eventNote, data: { receipt } }) },
      { returnDocument: 'after' },
    );

  let updated;
  try {
    updated = await apply(set, note);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    logPayment('error', 'payment.receipt_conflict', { paymentId: payment.id, source, reason: 'duplicate_receipt' });
    // The receipt is already on another payment: never count one M-Pesa transaction twice.
    delete set.receipt;
    delete set.receiptEmailQueuedAt;
    updated = await apply({ ...set, status: 'disputed', resultDesc: `Receipt ${receipt} is already recorded on another payment` }, note);
  }

  if (updated) {
    if (receipt && updated.receipt === receipt) {
      logPayment('info', 'payment.receipt_saved', { paymentId: updated.id, source, receiptPresent: true, status: updated.status });
    } else if (receipt) {
      logPayment('error', 'payment.receipt_not_saved', { paymentId: updated.id, source, reason: 'duplicate_receipt' });
    }
    if (updated.status === 'paid' && updated.metadata?.invoiceId) await settleInvoice(updated);
    if (updated.status === 'paid' && updated.paymentLink) {
      const update = { $inc: { successfulPayments: 1 } };
      if (updated.singleUseLink) {
        update.$set = { status: 'paid' };
        update.$unset = { checkoutLock: 1 };
      }
      const link = await PaymentLink.findByIdAndUpdate(updated.paymentLink, update);
      if (link && updated.customerEmail && updated.receipt) await deliverReceiptEmail(updated._id);
    }
    await enqueuePaymentEvent(updated, updated.status === 'paid' ? 'payment.paid' : 'payment.disputed');
    return { outcome: updated.status, payment: updated };
  }

  // Already settled. A status check can confirm a payment before its callback brings the receipt.
  if (receipt) {
    let receiptAdded = false;
    let receiptConflict = false;
    try {
      const result = await Payment.updateOne(
        { _id: payment._id, status: 'paid', receipt: { $exists: false } },
        {
          $set: {
            receipt,
            ...(payment.paymentLink && payment.customerEmail ? { receiptEmailQueuedAt: new Date() } : {}),
          },
        },
      );
      receiptAdded = result.modifiedCount > 0;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      receiptConflict = true;
    }
    if (receiptAdded) {
      const updated = await Payment.findById(payment._id);
      if (updated) {
        logPayment('info', 'payment.receipt_saved', { paymentId: updated.id, source, receiptPresent: true, status: updated.status, lateCallback: true });
        await enqueuePaymentEvent(updated, 'payment.paid');
        if (updated.paymentLink && updated.customerEmail) await deliverReceiptEmail(updated._id);
      }
    } else {
      const current = await Payment.findById(payment._id);
      if (current?.receipt === receipt) {
        logPayment('info', 'payment.receipt_already_saved', { paymentId: payment.id, source, status: current.status });
      } else {
        logPayment(receiptConflict ? 'error' : 'warn', 'payment.receipt_not_saved', {
          paymentId: payment.id,
          source,
          status: current?.status,
          reason: receiptConflict ? 'duplicate_receipt' : 'payment_not_paid',
        });
      }
    }
  }
  return { outcome: 'unchanged', payment: (await Payment.findById(payment._id)) || payment };
}

async function deliverReceiptEmail(paymentId) {
  if (!mailEnabled()) {
    logPayment('error', 'payment.receipt_email_disabled', { paymentId: String(paymentId), reason: 'configure_BREVO_API_KEY_or_SMTP_URL' });
    return false;
  }
  const now = new Date();
  const eligible = {
    _id: paymentId,
    status: 'paid',
    paymentLink: { $exists: true },
    customerEmail: { $type: 'string' },
    receipt: { $type: 'string' },
    receiptEmailQueuedAt: { $exists: true },
    receiptEmailSentAt: { $exists: false },
    $or: [{ receiptEmailNextAttemptAt: { $exists: false } }, { receiptEmailNextAttemptAt: { $lte: now } }],
  };
  const payment = await Payment.findOneAndUpdate(
    eligible,
    { $set: { receiptEmailNextAttemptAt: new Date(now.getTime() + 60_000) }, $inc: { receiptEmailAttempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!payment) return false;

  const receipt = payment.receipt;
  logPayment('info', 'payment.receipt_email_attempt', {
    paymentId: payment.id,
    attempt: payment.receiptEmailAttempts,
    receiptPresent: true,
  });
  const sent = await sendMail({
    to: payment.customerEmail,
    subject: `Payment received by ${payment.description || 'IsaPay'}`,
    text: `Hello${payment.customerName ? ` ${payment.customerName}` : ''},\n\nYour M-Pesa payment of KES ${payment.paidAmount ?? payment.amount} has been confirmed.\nM-Pesa confirmation code (receipt): ${receipt}\nReference: ${payment.reference}\n`,
    html: emailTemplate({
      preheader: `Your payment of KES ${payment.paidAmount ?? payment.amount} was received.`,
      title: 'Payment received',
      greeting: `Hello${payment.customerName ? ` ${payment.customerName}` : ''},`,
      paragraphs: ['Your M-Pesa payment has been confirmed. Thank you.'],
      details: [
        { label: 'Amount received', value: `KES ${payment.paidAmount ?? payment.amount}` },
        { label: 'Reference', value: payment.reference },
        { label: 'M-Pesa confirmation code (receipt)', value: receipt },
      ],
      closing: `Payment processed securely by IsaPay for ${payment.description || 'the merchant'}.`,
    }),
  });
  if (sent) {
    await Payment.updateOne(
      { _id: payment._id, receiptEmailSentAt: { $exists: false } },
      { $set: { receiptEmailSentAt: new Date() }, $unset: { receiptEmailNextAttemptAt: 1 } },
    );
    logPayment('info', 'payment.receipt_email_sent', { paymentId: payment.id, attempt: payment.receiptEmailAttempts });
    return true;
  }
  const retryMs = Math.min(15 * 60_000, RECEIPT_EMAIL_RETRY_MS * 2 ** Math.min(payment.receiptEmailAttempts - 1, 5));
  await Payment.updateOne(
    { _id: payment._id, receiptEmailSentAt: { $exists: false } },
    { $set: { receiptEmailNextAttemptAt: new Date(Date.now() + retryMs) } },
  );
  logPayment('error', 'payment.receipt_email_failed', {
    paymentId: payment.id,
    attempt: payment.receiptEmailAttempts,
    retryAfterMs: retryMs,
  });
  return false;
}

export async function deliverReceiptEmails({ limit = 50 } = {}) {
  if (!mailEnabled()) return { scanned: 0, sent: 0 };
  const now = new Date();
  const due = await Payment.find({
    status: 'paid',
    paymentLink: { $exists: true },
    customerEmail: { $type: 'string' },
    receipt: { $type: 'string' },
    receiptEmailQueuedAt: { $exists: true },
    receiptEmailSentAt: { $exists: false },
    $or: [{ receiptEmailNextAttemptAt: { $exists: false } }, { receiptEmailNextAttemptAt: { $lte: now } }],
  })
    .sort({ paidAt: 1 })
    .limit(limit)
    .select('_id');
  let sent = 0;
  for (const payment of due) {
    if (await deliverReceiptEmail(payment._id)) sent += 1;
  }
  return { scanned: due.length, sent };
}

// An IsaPay subscription invoice paid by M-Pesa prompt (services/billing.js).
async function settleInvoice(payment) {
  const invoice = await Invoice.findOneAndUpdate(
    { _id: payment.metadata.invoiceId, status: 'open' },
    { $set: { status: 'paid', paidAt: payment.paidAt, receipt: payment.receipt, payment: payment._id } },
    { returnDocument: 'after' },
  ).catch(() => null);
  if (invoice) {
    await audit('IsaPay billing', 'invoice.paid', { type: 'platform', id: String(invoice.platform), label: invoice.number }, {
      number: invoice.number,
      amount: invoice.fee,
      receipt: payment.receipt || null,
    });
  }
}

async function releasePaymentLink(payment) {
  if (!payment?.singleUseLink || !payment.paymentLink || !payment.idempotencyKey) return;
  await PaymentLink.updateOne(
    { _id: payment.paymentLink, checkoutLock: payment.idempotencyKey },
    { $unset: { checkoutLock: 1 } },
  );
}

export async function markFailed(payment, { resultCode, resultDesc, source, note }) {
  const updated = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'pending' },
    {
      $set: { status: 'failed', failedAt: new Date(), resultCode: resultCode ?? null, resultDesc },
      ...pushEvent('status.failed', source, { note: note || resultDesc }),
    },
    { returnDocument: 'after' },
  );
  if (updated) {
    await releasePaymentLink(updated);
    await enqueuePaymentEvent(updated, 'payment.failed');
    return { outcome: 'failed', payment: updated };
  }

  return { outcome: 'unchanged', payment: (await Payment.findById(payment._id)) || payment };
}

/**
 * Handles a parsed STK callback for `till`.
 *
 * A success callback is never trusted on its own, even on the secret URL: Safaricom is asked
 * directly before the payment counts as paid. If that check can't be made right now, the
 * callback's receipt and amount are kept and the background sweep finishes the job.
 */
export async function handleCallback(till, result, onReceived = () => {}) {
  const payment = await Payment.findOne({ checkoutRequestId: result.checkoutRequestId, till: till._id });
  if (!payment) {
    onReceived();
    logPayment('warn', 'payment.callback_unknown_request', {
      checkoutRequestId: result.checkoutRequestId,
      tillId: till.id,
      receiptPresent: Boolean(result.receipt),
    });
    return { outcome: 'unknown_request' };
  }

  const receivedPayment = await Payment.findOneAndUpdate(
    { _id: payment._id },
    {
      $set: {
        callback: { resultCode: result.resultCode, receipt: result.receipt, amount: result.amount, phone: result.phone, receivedAt: new Date() },
      },
      ...pushEvent('callback', 'safaricom', {
        note: result.resultDesc,
        data: { resultCode: result.resultCode, receipt: result.receipt, amount: result.amount },
      }),
    },
    { returnDocument: 'after' },
  );
  if (!receivedPayment) {
    logPayment('error', 'payment.callback_not_persisted', {
      paymentId: payment.id,
      checkoutRequestId: result.checkoutRequestId,
      reason: 'payment_disappeared_before_callback_update',
    });
    throw new Error(`Payment ${payment.id} disappeared while saving Safaricom callback`);
  }
  logPayment('info', 'payment.callback_persisted', {
    paymentId: receivedPayment.id,
    checkoutRequestId: result.checkoutRequestId,
    resultCode: result.resultCode,
    receiptPresent: Boolean(result.receipt),
    statusBeforeConfirmation: receivedPayment.status,
  });
  onReceived();

  if (result.resultCode !== 0) {
    return markFailed(payment, { resultCode: result.resultCode, resultDesc: result.resultDesc, source: 'callback' });
  }
  if (!result.receipt) {
    logPayment('warn', 'payment.callback_missing_receipt', {
      paymentId: payment.id,
      checkoutRequestId: result.checkoutRequestId,
      reason: 'successful_callback_has_no_MpesaReceiptNumber',
    });
  }
  // A status query may have settled this payment before Safaricom's callback arrived. Its
  // successful status is already verified, so attach the late callback receipt without another
  // status query (which may be unavailable or no longer report success).
  if (
    receivedPayment?.status === 'paid' &&
    result.receipt &&
    (result.amount === undefined || Math.round(result.amount) === Math.round(receivedPayment.amount))
  ) {
    return markPaid(receivedPayment, { receipt: result.receipt, paidAmount: result.amount, source: 'callback' });
  }

  let check;
  try {
    check = await stkQuery(till, result.checkoutRequestId);
  } catch (err) {
    logPayment('warn', 'payment.callback_verification_failed', {
      paymentId: payment.id,
      checkoutRequestId: result.checkoutRequestId,
      errorType: err?.name || 'Error',
      retry: 'background_sweep',
    });
    return { outcome: 'unconfirmed' };
  }
  if (check.state === 'success') {
    const settled = await markPaid(payment, { receipt: result.receipt, paidAmount: result.amount, source: 'callback' });
    logPayment('info', 'payment.callback_confirmed', {
      paymentId: payment.id,
      checkoutRequestId: result.checkoutRequestId,
      status: settled.payment?.status,
      receiptPresent: Boolean(settled.payment?.mpesaReceipt),
    });
    return settled;
  }
  if (check.state === 'failed') {
    return markFailed(payment, {
      resultCode: check.resultCode,
      resultDesc: check.resultDesc,
      source: 'callback',
      note: `The callback said paid, but Safaricom says: ${check.resultDesc}`,
    });
  }
  logPayment('warn', 'payment.callback_unconfirmed', {
    paymentId: payment.id,
    checkoutRequestId: result.checkoutRequestId,
    safaricomState: check.state,
    resultCode: check.resultCode,
  });
  return { outcome: 'unconfirmed' };
}

/**
 * Asks Safaricom about a pending payment and applies the answer.
 * `minGapMs` keeps polling pages and the sweep from asking about the same payment too often.
 */
export async function checkPayment(payment, { source, minGapMs = 0 } = {}) {
  const now = Date.now();
  const age = now - payment.createdAt.getTime();

  if (!payment.checkoutRequestId) {
    if (payment.status === 'pending' && age > ORPHAN_MS) {
      return markFailed(payment, { resultDesc: 'The payment request never reached M-Pesa', source });
    }
    return { outcome: 'unchanged', payment };
  }

  // Claim the check so concurrent pollers and sweeps don't all call Daraja.
  const claimed = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      status: 'pending',
      $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lte: new Date(now - minGapMs) } }],
    },
    { $set: { lastCheckedAt: new Date(now) }, $inc: { checks: 1 } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { outcome: 'unchanged', payment };

  const till = await loadTill(claimed.till);
  if (!till) return { outcome: 'unchanged', payment: claimed };

  let check;
  try {
    check = await stkQuery(till, claimed.checkoutRequestId);
  } catch (err) {
    console.warn(`Status check for payment ${claimed.id} failed: ${err.message}`);
    check = { state: 'unknown', resultCode: null, resultDesc: err.message };
  }

  if (check.state === 'success') {
    return markPaid(claimed, { receipt: claimed.callback?.receipt, paidAmount: claimed.callback?.amount, source });
  }
  if (check.state === 'failed') {
    return markFailed(claimed, { resultCode: check.resultCode, resultDesc: check.resultDesc, source });
  }
  if (age > GIVE_UP_MS) {
    return markFailed(claimed, { resultDesc: 'No answer from M-Pesa', source, note: `Last check: ${check.resultDesc || check.state}` });
  }
  return { outcome: 'unchanged', payment: claimed };
}

let sweeping = false;

/**
 * Settles pending payments whose callback is late or lost. Runs every SWEEP_EVERY_MS.
 * Young payments are skipped (the payer may still be typing their PIN).
 */
export async function sweepPendingPayments({ minAgeMs = 45_000, minGapMs = 25_000, limit = 50 } = {}) {
  const summary = { scanned: 0, paid: 0, failed: 0, pending: 0, errors: 0 };
  if (sweeping) return { ...summary, skipped: true };
  sweeping = true;
  try {
    const now = Date.now();
    const due = await Payment.find({
      status: 'pending',
      createdAt: { $lte: new Date(now - minAgeMs), $gte: new Date(now - 24 * 3600_000) },
      $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lte: new Date(now - minGapMs) } }],
    })
      .sort({ createdAt: 1 })
      .limit(limit);
    summary.scanned = due.length;

    // One at a time: Daraja rate-limits, and a backlog is rare.
    for (const payment of due) {
      try {
        const { payment: after } = await checkPayment(payment, { source: 'sweep', minGapMs });
        if (after.status === 'paid' || after.status === 'disputed') summary.paid += 1;
        else if (after.status === 'failed') summary.failed += 1;
        else summary.pending += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(`Sweep could not check payment ${payment.id}:`, err.message);
      }
    }
    return summary;
  } finally {
    sweeping = false;
  }
}
