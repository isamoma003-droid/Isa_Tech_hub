/**
 * How IsaPay earns money from the platforms that use it.
 *
 *   - Your own platforms (ownership "own") pay nothing.
 *   - A platform on an ISA till pays a percentage of what it receives. The money is already in
 *     your till, so the fee is kept at once and the rest is owed to the partner as a payout.
 *   - A partner on its own till pays a monthly subscription, invoiced after the month ends and
 *     collected with an M-Pesa prompt into an ISA till. Unpaid past the grace period, the
 *     platform can't start new payments until it pays.
 *   - The first `freeAmount` shillings each month are free: no percentage on them, and no
 *     subscription for a month that stays under it.
 */
import { env } from '../config/env.js';
import { AuditLog } from '../models/AuditLog.js';
import { Invoice } from '../models/Invoice.js';
import { Payment } from '../models/Payment.js';
import { Platform } from '../models/Platform.js';
import { Till } from '../models/Till.js';
import { HttpError, badRequest } from '../utils/httpError.js';
import { normalizePhone } from '../utils/phone.js';
import { kenyaMonth, monthRange, previousMonth } from '../utils/time.js';
import { audit } from './audit.js';
import { createPayment } from './payments.js';

const DAY = 24 * 3600_000;
const BILLING_SLUG = 'isapay-billing';
const BY = 'IsaPay billing';

/** The plan and prices that apply to `platform` (its till populated, or passed as `till`). */
export function resolvePlan(platform, till = platform.till) {
  const own = platform.billing || {};
  let plan = own.plan || 'auto';
  if (plan === 'auto') {
    if (platform.system || platform.ownership !== 'partner') plan = 'exempt';
    else plan = till?.owner === 'partner' ? 'subscription' : 'percent';
  }
  return {
    plan,
    automatic: (own.plan || 'auto') === 'auto',
    percent: own.percent ?? env.billing.percent,
    monthlyFee: own.monthlyFee ?? env.billing.monthlyFee,
    freeAmount: own.freeAmount ?? env.billing.freeAmount,
  };
}

/** What the platform received in `period` (paid payments, by M-Pesa's amount). */
export async function usage(platformId, period) {
  const { start, end } = monthRange(period);
  const [row] = await Payment.aggregate([
    { $match: { platform: platformId, status: 'paid', paidAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, amount: { $sum: { $ifNull: ['$paidAmount', '$amount'] } }, count: { $sum: 1 } } },
  ]);
  return { amount: row?.amount || 0, count: row?.count || 0 };
}

/** IsaPay's fee for a month with `volume`, under `pricing`. */
export function feeFor(pricing, volume) {
  if (pricing.plan === 'percent') return Math.round((Math.max(0, volume.amount - pricing.freeAmount) * pricing.percent) / 100);
  if (pricing.plan === 'subscription') return volume.amount <= pricing.freeAmount ? 0 : Math.round(pricing.monthlyFee);
  return 0;
}

/** The month so far: volume and what the fee would be if the month ended now. */
export async function estimate(platform, period = kenyaMonth()) {
  const pricing = resolvePlan(platform);
  const volume = await usage(platform._id, period);
  return { period, pricing, volume, fee: feeFor(pricing, volume) };
}

async function nextNumber(period) {
  const count = await Invoice.countDocuments({ period });
  return `ISP-${period.replace('-', '')}-${String(count + 1).padStart(4, '0')}`;
}

/**
 * Writes the invoice for `platform` and `period` (once; later calls return the existing one).
 * Returns null for platforms that pay nothing, or that didn't exist yet in that month.
 */
export async function invoiceMonth(platform, period) {
  const existing = await Invoice.findOne({ platform: platform._id, period });
  if (existing) return existing;
  const { start, end } = monthRange(period);
  if (platform.createdAt && platform.createdAt >= end) return null;
  if (!platform.till?.owner) await platform.populate('till');

  const pricing = resolvePlan(platform);
  if (pricing.plan === 'exempt') return null;
  const volume = await usage(platform._id, period);
  const fee = feeFor(pricing, volume);
  const base = {
    platform: platform._id,
    period,
    volume,
    freeAmount: pricing.freeAmount,
    fee,
  };
  const fields =
    pricing.plan === 'subscription'
      ? {
          ...base,
          kind: 'subscription',
          monthlyFee: pricing.monthlyFee,
          status: fee > 0 ? 'open' : 'waived',
          dueAt: new Date(end.getTime() + env.billing.dueDays * DAY),
          note: fee > 0 ? undefined : `Under the free KES ${pricing.freeAmount} for the month`,
        }
      : {
          ...base,
          kind: 'commission',
          percent: pricing.percent,
          // Kept from the money already in your till.
          status: 'paid',
          paidAt: end,
          payout: volume.amount - fee,
          payoutStatus: volume.amount - fee > 0 ? 'pending' : 'none',
        };

  for (let attempt = 0; ; attempt += 1) {
    try {
      const invoice = await Invoice.create({ ...fields, number: await nextNumber(period) });
      await audit(BY, 'invoice.created', { type: 'platform', id: platform.id, label: platform.slug }, {
        number: invoice.number,
        period,
        kind: invoice.kind,
        fee,
        volume: volume.amount,
        from: start.toISOString(),
      });
      return invoice;
    } catch (err) {
      if (err?.code !== 11000 || attempt >= 4) throw err;
      // Another server wrote the same invoice, or took the same number.
      const raced = await Invoice.findOne({ platform: platform._id, period });
      if (raced) return raced;
    }
  }
}

/**
 * The first month IsaPay invoices: BILLING_START_MONTH, or the month billing first ran here
 * (remembered in the audit log), so nobody is billed for months before billing existed.
 */
export async function billingStartMonth() {
  if (env.billing.startMonth) return env.billing.startMonth;
  const started = await AuditLog.findOne({ action: 'billing.started' }).sort({ createdAt: 1 });
  if (started?.details?.period) return started.details.period;
  const period = kenyaMonth();
  await audit(BY, 'billing.started', { type: 'billing', id: period, label: period }, { period });
  return period;
}

/** Invoices every billable platform for `period` (by default last month). */
export async function closeMonth(period = previousMonth(kenyaMonth())) {
  if (period < (await billingStartMonth())) return [];
  const platforms = await Platform.find({ system: { $ne: true } }).populate('till');
  const invoices = [];
  for (const platform of platforms) {
    const invoice = await invoiceMonth(platform, period);
    if (invoice) invoices.push(invoice);
  }
  return invoices;
}

/**
 * Whether the platform may start payments. "suspended" once a subscription invoice is more than
 * the grace period overdue, unless an admin extended the platform's grace.
 */
export async function billingStanding(platform, now = new Date()) {
  const open = await Invoice.find({ platform: platform._id, kind: 'subscription', status: 'open' }).sort({ dueAt: 1 });
  const overdue = open.filter((invoice) => invoice.dueAt && invoice.dueAt < now);
  if (!overdue.length) return { state: open.length ? 'open' : 'ok', open, overdue };
  const suspendAt = new Date(overdue[0].dueAt.getTime() + env.billing.graceDays * DAY);
  const extended = platform.billing?.graceUntil && platform.billing.graceUntil > now;
  return { state: suspendAt <= now && !extended ? 'suspended' : 'overdue', open, overdue, suspendAt };
}

/** Throws 402 when the platform is suspended for an unpaid subscription. */
export async function assertCanTakePayments(platform) {
  if (platform.system) return;
  const standing = await billingStanding(platform);
  if (standing.state !== 'suspended') return;
  const [first] = standing.overdue;
  throw new HttpError(
    402,
    `This platform's IsaPay subscription is overdue (invoice ${first.number}, KES ${first.fee}). Pay it to start taking payments again.`,
    { invoice: first.number, amount: first.fee },
  );
}

/** The platform IsaPay collects its own invoices through, created on first use. */
export async function billingPlatform() {
  const existing = await Platform.findOne({ slug: BILLING_SLUG }).populate('till');
  if (existing?.till?.active && existing.till.owner !== 'partner') return existing;

  const till = await Till.findOne({ active: true, owner: { $ne: 'partner' } }).sort({ slot: 1, createdAt: 1 });
  if (!till) throw badRequest('Add an active ISA till first: subscriptions are paid into one of your tills.');
  if (existing) {
    existing.till = till._id;
    await existing.save();
    return existing.populate('till');
  }
  const platform = new Platform({
    name: 'IsaPay billing',
    slug: BILLING_SLUG,
    ownership: 'own',
    accountReference: 'IsaPay',
    till: till._id,
    system: true,
    billing: { plan: 'exempt' },
    notes: 'Used by IsaPay to collect subscription invoices. Created automatically.',
  });
  try {
    await platform.save();
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  return Platform.findOne({ slug: BILLING_SLUG }).populate('till');
}

/**
 * Sends the M-Pesa prompt for an open subscription invoice. When it's paid, payments.js marks the
 * invoice paid (the payment carries the invoice id).
 */
export async function collectInvoice(invoice, { phone, by = BY } = {}) {
  if (invoice.kind !== 'subscription' || invoice.status !== 'open') throw badRequest('Only an open subscription invoice can be paid');
  const platform = await Platform.findById(invoice.platform);
  const given = phone || platform?.billing?.phone || platform?.contact?.phone;
  if (!given) throw badRequest('Add the platform’s billing phone number first (Platforms → Billing)');
  const to = normalizePhone(given);
  if (!to) throw badRequest(`${given} isn't a Kenyan mobile number`);
  const collector = await billingPlatform();
  const result = await createPayment(collector, {
    phone: to,
    amount: invoice.fee,
    reference: invoice.number,
    purpose: 'isapay-subscription',
    description: `IsaPay ${invoice.period}`,
    metadata: { invoiceId: invoice.id, platform: platform?.slug || '' },
  });
  await audit(by, 'invoice.collect_requested', { type: 'platform', id: String(invoice.platform), label: platform?.slug }, {
    number: invoice.number,
    amount: invoice.fee,
    payment: result.payment?.id,
  });
  return result;
}
