// The API platforms call (server-to-server, with their API key).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requirePlatform } from '../middleware/platformAuth.js';
import { validate } from '../middleware/validate.js';
import { PAYMENT_STATUSES, Payment } from '../models/Payment.js';
import { checkPayment, createPayment } from '../services/payments.js';
import { badRequest, notFound } from '../utils/httpError.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();

router.use(requirePlatform);
router.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    keyGenerator: (req) => req.platform.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests from this platform, slow down a little' },
    skip: () => env.nodeEnv === 'test',
  }),
);

// A platform's payment page polls GET /v1/payments/:id. When Safaricom's callback is late,
// ask Safaricom directly, but not more often than this.
const POLL_CHECK_AFTER_MS = 20_000;
const POLL_CHECK_GAP_MS = 10_000;

// What a platform needs to show "or pay from the M-Pesa menu" instructions.
router.get('/config', (req, res) => {
  const { platform } = req;
  const till = platform.till;
  res.json({
    platform: { id: platform.id, name: platform.name, slug: platform.slug },
    till: till
      ? {
          kind: till.kind,
          payNumber: till.payNumber,
          accountNumber: till.kind === 'paybill' ? platform.accountReference || platform.name.slice(0, 12) : null,
          environment: till.environment,
          active: till.active,
        }
      : null,
    limits: { minAmount: env.minAmount, maxAmount: env.maxAmount, currency: 'KES' },
  });
});

const metadataSchema = z
  .record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  // Plain names only: MongoDB rejects keys starting with $ or containing dots.
  .refine((value) => Object.keys(value).every((key) => /^[A-Za-z0-9_-]+$/.test(key)), 'metadata keys: letters, digits, dashes and underscores only')
  .refine((value) => Object.keys(value).length <= 20, 'metadata can have at most 20 keys')
  .refine((value) => JSON.stringify(value).length <= 2000, 'metadata is too large (2,000 characters max)');

const createSchema = z.object({
  phone: z.string().trim().min(1, 'phone is required').max(20),
  amount: z.coerce
    .number()
    .int('amount must be a whole number of shillings')
    .min(env.minAmount, `amount must be at least KES ${env.minAmount}`)
    .max(env.maxAmount, `amount can be at most KES ${env.maxAmount}`),
  reference: z.string().trim().min(1, 'reference is required (your order or booking id)').max(64),
  purpose: z
    .string()
    .trim()
    .max(40)
    .regex(/^[\w.-]+$/, 'purpose: letters, digits, dots, dashes and underscores only')
    .optional(),
  description: z.string().trim().max(100).optional(),
  metadata: metadataSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
});

const view = (req, payment) => payment.toPlatform(req.platform.slug);

// Starts a payment: Safaricom sends the PIN prompt to `phone`. Pass an Idempotency-Key header
// (e.g. your order id plus attempt number) so a retried request can't prompt the payer twice.
router.post('/payments', validate(createSchema), async (req, res) => {
  const body = req.valid.body;
  const phone = normalizePhone(body.phone);
  if (!phone) throw badRequest('phone must be a Kenyan mobile number, e.g. 0712345678 or 254712345678');
  const idempotencyKey = req.get('idempotency-key')?.trim().slice(0, 100) || body.idempotencyKey;

  const { payment, replayed, error } = await createPayment(req.platform, { ...body, phone, idempotencyKey });
  if (error) return res.status(502).json({ error, payment: view(req, payment) });
  res.status(replayed ? 200 : 201).json({ payment: view(req, payment), replayed });
});

const listSchema = z.object({
  reference: z.string().trim().max(64).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/payments', validate(listSchema, 'query'), async (req, res) => {
  const { reference, status, limit } = req.valid.query;
  const filter = { platform: req.platform._id };
  if (reference) filter.reference = reference;
  if (status) filter.status = status;
  const payments = await Payment.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ payments: payments.map((p) => view(req, p)) });
});

router.get('/payments/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw notFound('Payment not found');
  let payment = await Payment.findOne({ _id: req.params.id, platform: req.platform._id });
  if (!payment) throw notFound('Payment not found');

  if (payment.status === 'pending' && Date.now() - payment.createdAt.getTime() > POLL_CHECK_AFTER_MS) {
    ({ payment } = await checkPayment(payment, { source: 'poll', minGapMs: POLL_CHECK_GAP_MS }));
  }
  res.json({ payment: view(req, payment) });
});

export default router;
