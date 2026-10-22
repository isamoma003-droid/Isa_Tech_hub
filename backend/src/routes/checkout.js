import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { Payment } from '../models/Payment.js';
import { PaymentLink } from '../models/PaymentLink.js';
import { assertCanTakePayments } from '../services/billing.js';
import { checkPayment, createPayment } from '../services/payments.js';
import { badRequest, notFound, HttpError } from '../utils/httpError.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();

router.use(
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many checkout attempts. Please wait and try again.' },
    skip: () => env.nodeEnv === 'test',
  }),
);

async function loadLink(slug, activeOnly = true) {
  const link = await PaymentLink.findOne({ slug, ...(activeOnly ? { status: 'active' } : {}) }).populate({
    path: 'platform',
    populate: [{ path: 'till' }, { path: 'owner', select: 'role active approval' }],
  });
  if (!link?.platform || (activeOnly && link.platform.status !== 'active') || (link.platform.owner && !link.platform.owner.active)) {
    throw notFound('This payment link is not available');
  }
  return link;
}

function assertApproved(platform) {
  const owner = platform.owner;
  if (owner?.role !== 'merchant' || owner.approval?.status === 'approved' || platform.till?.environment === 'sandbox') return;
  throw new HttpError(
    403,
    owner.approval?.status === 'rejected'
      ? 'This business is not approved for live payments yet.'
      : 'This business is still being reviewed. Live payments are not available yet.',
  );
}

router.get('/:slug', async (req, res) => {
  const link = await loadLink(req.params.slug);
  res.json({
    paymentLink: link.toPublic(),
    platform: { name: link.platform.name },
  });
});

router.get('/:slug/payments/:id', async (req, res) => {
  const link = await loadLink(req.params.slug, false);
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Payment not found');
  let payment = await Payment.findOne({ _id: req.params.id, paymentLink: link._id });
  if (!payment) throw notFound('Payment not found');
  if (payment.status === 'pending' && Date.now() - payment.createdAt.getTime() > 20_000) {
    ({ payment } = await checkPayment(payment, { source: 'poll', minGapMs: 10_000 }));
  }
  res.json({
    payment: {
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      message: payment.message,
      mpesaReceipt: payment.receipt || null,
    },
  });
});

const checkoutSchema = z.object({
  phone: z.string().trim().min(1).max(20),
  amount: z.coerce.number().int().min(env.minAmount).max(env.maxAmount),
  name: z.string().trim().max(80).optional(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().max(120).email()]).optional(),
  requestId: z.string().uuid(),
});

router.post('/:slug/pay', validate(checkoutSchema), async (req, res) => {
  const link = await loadLink(req.params.slug);
  const platform = link.platform;
  const body = req.valid.body;
  const phone = normalizePhone(body.phone);
  if (!phone) throw badRequest('Enter a valid Kenyan mobile number, such as 0712345678');
  if (link.amountType === 'fixed' && body.amount !== link.amount) throw badRequest('This link requires its listed amount');
  if (link.amountType === 'customer' && (body.amount < link.minAmount || body.amount > link.maxAmount)) {
    throw badRequest(`Enter an amount between KES ${link.minAmount} and KES ${link.maxAmount}`);
  }
  if (link.collectName && !body.name?.trim()) throw badRequest('Enter your name');
  if (link.collectEmail && !body.email?.trim()) throw badRequest('Enter your email address');
  assertApproved(platform);
  await assertCanTakePayments(platform);

  const idempotencyKey = `checkout:${link.id}:${body.requestId}`;
  if (link.usage === 'single-use') {
    const reserved = await PaymentLink.findOneAndUpdate(
      {
        _id: link._id,
        status: 'active',
        $or: [{ checkoutLock: { $exists: false } }, { checkoutLock: idempotencyKey }],
      },
      { $set: { checkoutLock: idempotencyKey } },
    );
    if (!reserved) throw new HttpError(409, 'A payment is already in progress for this link. Check the payer phone or try again shortly.');
  }

  let result;
  try {
    result = await createPayment(platform, {
      phone,
      amount: body.amount,
      reference: `link-${link.slug}`,
      purpose: 'payment-link',
      description: link.title.slice(0, 100),
      idempotencyKey,
      paymentLink: link._id,
      singleUseLink: link.usage === 'single-use',
      customerName: body.name?.trim(),
      customerEmail: body.email?.trim(),
    });
  } catch (err) {
    if (link.usage === 'single-use') {
      await PaymentLink.updateOne({ _id: link._id, checkoutLock: idempotencyKey }, { $unset: { checkoutLock: 1 } });
    }
    throw err;
  }
  const { payment, replayed, error } = result;
  if (link.usage === 'single-use' && (error || payment.status !== 'pending')) {
    await PaymentLink.updateOne({ _id: link._id, checkoutLock: idempotencyKey }, { $unset: { checkoutLock: 1 } });
  }
  if (error) return res.status(502).json({ error, payment: payment.toPlatform(platform.slug) });
  res.status(replayed ? 200 : 201).json({
    payment: { id: payment.id, amount: payment.amount, currency: payment.currency, status: payment.status, message: payment.message },
    replayed,
  });
});

export default router;
