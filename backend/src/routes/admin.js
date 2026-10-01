// The dashboard's API. Every change is written to the audit log.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAdmin, requireRole, signAdminToken } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { AdminUser } from '../models/AdminUser.js';
import { AuditLog } from '../models/AuditLog.js';
import { PAYMENT_STATUSES, Payment } from '../models/Payment.js';
import { Platform } from '../models/Platform.js';
import { Till } from '../models/Till.js';
import { WebhookDelivery } from '../models/WebhookDelivery.js';
import { audit } from '../services/audit.js';
import { checkPayment } from '../services/payments.js';
import { resendPaymentWebhook, sendTestWebhook } from '../services/webhooks.js';
import { HttpError, badRequest, conflict, notFound, unauthorized } from '../utils/httpError.js';
import { maskPhone, normalizePhone } from '../utils/phone.js';
import { TIME_ZONE, startOfKenyaDay } from '../utils/time.js';

const router = Router();
const adminOnly = requireRole('admin');
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = (id, what = 'Not found') => {
  if (!mongoose.isValidObjectId(id)) throw notFound(what);
  return id;
};
// Money that counts as received: what M-Pesa says was paid.
const received = { $ifNull: ['$paidAmount', '$amount'] };

// --- Sign-in ---------------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts, please wait 15 minutes' },
  skip: () => env.nodeEnv === 'test',
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter your email address'),
  password: z.string().min(1, 'Enter your password').max(200),
});

router.post('/auth/login', loginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = req.valid.body;
  const admin = await AdminUser.findOne({ email }).select('+passwordHash');
  if (!admin?.active || !(await admin.checkPassword(password))) throw unauthorized('Wrong email or password');
  admin.lastLoginAt = new Date();
  await admin.save();
  req.admin = admin;
  await audit(req, 'auth.login', { type: 'admin', id: admin.id, label: admin.email });
  res.json({ token: signAdminToken(admin), admin: admin.toPublic() });
});

router.use(requireAdmin);

router.get('/auth/me', (req, res) => res.json({ admin: req.admin.toPublic() }));

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
});

router.post('/auth/password', validate(passwordSchema), async (req, res) => {
  const admin = await AdminUser.findById(req.admin._id).select('+passwordHash');
  if (!(await admin.checkPassword(req.valid.body.currentPassword))) throw badRequest('Your current password is wrong');
  await admin.setPassword(req.valid.body.newPassword);
  admin.tokenVersion += 1; // signs out every other session
  await admin.save();
  await audit(req, 'auth.password_changed', { type: 'admin', id: admin.id, label: admin.email });
  res.json({ token: signAdminToken(admin), admin: admin.toPublic() });
});

// --- Overview --------------------------------------------------------------------------------

router.get('/stats', async (_req, res) => {
  const since = { today: startOfKenyaDay(0), week: startOfKenyaDay(6), month: startOfKenyaDay(29) };
  const sumSince = (from) =>
    Payment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: from } } },
      { $group: { _id: null, amount: { $sum: received }, count: { $sum: 1 } } },
    ]).then(([row]) => ({ amount: row?.amount || 0, count: row?.count || 0 }));

  const [today, week, month, allTime, daily, byPlatform, outcomes, pending, disputed, failedWebhooks, recent] = await Promise.all([
    sumSince(since.today),
    sumSince(since.week),
    sumSince(since.month),
    sumSince(new Date(0)),
    Payment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: since.month } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$paidAt', timezone: TIME_ZONE } },
          amount: { $sum: received },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: { status: 'paid', paidAt: { $gte: since.month } } },
      { $group: { _id: '$platform', amount: { $sum: received }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Payment.aggregate([
      { $match: { createdAt: { $gte: since.week }, status: { $ne: 'pending' } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Payment.countDocuments({ status: 'pending' }),
    Payment.countDocuments({ status: 'disputed' }),
    WebhookDelivery.countDocuments({ status: 'failed' }),
    Payment.find().sort({ createdAt: -1 }).limit(8).populate('platform', 'name slug'),
  ]);

  const platforms = await Platform.find({ _id: { $in: byPlatform.map((row) => row._id) } }).select('name slug');
  const names = new Map(platforms.map((p) => [String(p._id), p]));
  const outcome = Object.fromEntries(outcomes.map((row) => [row._id, row.count]));
  const settled = (outcome.paid || 0) + (outcome.failed || 0) + (outcome.disputed || 0);

  // One entry per Kenyan day, including days with no payments.
  const byDay = new Map(daily.map((row) => [row._id, row]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(since.month.getTime() + (i * 24 + 12) * 3600_000).toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
    return { date, amount: byDay.get(date)?.amount || 0, count: byDay.get(date)?.count || 0 };
  });

  res.json({
    totals: { today, week, month, allTime },
    days,
    byPlatform: byPlatform.map((row) => ({
      platform: { id: String(row._id), name: names.get(String(row._id))?.name || 'Deleted platform', slug: names.get(String(row._id))?.slug || '' },
      amount: row.amount,
      count: row.count,
    })),
    successRate: settled ? (outcome.paid || 0) / settled : null,
    attention: { pending, disputed, failedWebhooks },
    recent: recent.map((p) => p.toAdminRow()),
  });
});

// --- Payments --------------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2026-10-01');
const paymentsQuery = z.object({
  platform: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  from: day.optional(),
  to: day.optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// Kenya's YYYY-MM-DD → the UTC instant its midnight falls on.
const kenyaMidnight = (date) => new Date(`${date}T00:00:00+03:00`);

// Built with real ObjectIds because it also feeds aggregate(), which doesn't cast strings.
function paymentFilter({ platform, status, q, from, to }) {
  const filter = {};
  if (platform) filter.platform = new mongoose.Types.ObjectId(platform);
  if (status) filter.status = status;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = kenyaMidnight(from);
    if (to) filter.createdAt.$lt = new Date(kenyaMidnight(to).getTime() + 24 * 3600_000);
  }
  if (q) {
    const or = [{ reference: new RegExp(`^${escapeRegex(q)}`, 'i') }, { receipt: q.toUpperCase() }];
    const phone = normalizePhone(q);
    if (phone) or.push({ phone });
    or.push({ checkoutRequestId: q });
    if (/^[a-f0-9]{24}$/i.test(q)) or.push({ _id: new mongoose.Types.ObjectId(q) });
    filter.$or = or;
  }
  return filter;
}

const PAGE_SIZE = 50;

router.get('/payments', validate(paymentsQuery, 'query'), async (req, res) => {
  const { page } = req.valid.query;
  const filter = paymentFilter(req.valid.query);
  const [payments, total, paid] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate('platform', 'name slug'),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: filter },
      { $match: { status: 'paid' } },
      { $group: { _id: null, amount: { $sum: received }, count: { $sum: 1 } } },
    ]),
  ]);
  res.json({
    payments: payments.map((p) => p.toAdminRow()),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    paid: { amount: paid[0]?.amount || 0, count: paid[0]?.count || 0 },
  });
});

const csvCell = (value) => {
  const text = value === undefined || value === null ? '' : String(value);
  // Quote everything, and stop spreadsheet apps from running cell text as a formula.
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};
const kenyaTime = (date) =>
  date ? new Date(date).toLocaleString('sv-SE', { timeZone: TIME_ZONE }).slice(0, 16) : '';

router.get('/payments/export.csv', validate(paymentsQuery, 'query'), async (req, res) => {
  const payments = await Payment.find(paymentFilter(req.valid.query))
    .sort({ createdAt: -1 })
    .limit(10_000)
    .populate('platform', 'name slug');
  const header = ['Created (Kenya)', 'Paid (Kenya)', 'Platform', 'Reference', 'Purpose', 'Phone', 'Amount', 'Paid amount', 'Status', 'M-Pesa receipt', 'Payment id'];
  const rows = payments.map((p) => [
    kenyaTime(p.createdAt),
    kenyaTime(p.paidAt),
    p.platform?.slug || '',
    p.reference,
    p.purpose || '',
    maskPhone(p.phone),
    p.amount,
    p.paidAmount ?? '',
    p.status,
    p.receipt || '',
    p.id,
  ]);
  await audit(req, 'payments.exported', { type: 'payments', label: `${payments.length} rows` }, req.valid.query);
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="isa-hub-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
  const bom = '\uFEFF'; // lets Excel open the file as UTF-8
  res.send(`${bom}${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`);
});

async function paymentDetail(req, payment) {
  const [platform, till, deliveries] = await Promise.all([
    Platform.findById(payment.platform).populate('till'),
    Till.findById(payment.till),
    WebhookDelivery.find({ payment: payment._id }).sort({ createdAt: -1 }).limit(20).select('-body'),
  ]);
  return {
    payment: {
      ...payment.toPlatform(platform?.slug),
      phone: req.admin.role === 'admin' ? payment.phone : maskPhone(payment.phone),
      checkoutRequestId: payment.checkoutRequestId || null,
      merchantRequestId: payment.merchantRequestId || null,
      resultDesc: payment.resultDesc || null,
      idempotencyKey: payment.idempotencyKey || null,
      checks: payment.checks,
      lastCheckedAt: payment.lastCheckedAt || null,
      events: payment.events,
    },
    platform: platform?.toPublic() || null,
    till: till?.toPublic() || null,
    deliveries,
  };
}

router.get('/payments/:id', async (req, res) => {
  const payment = await Payment.findById(objectId(req.params.id, 'Payment not found'));
  if (!payment) throw notFound('Payment not found');
  res.json(await paymentDetail(req, payment));
});

// Asks Safaricom right now how a pending payment ended.
router.post('/payments/:id/check', adminOnly, async (req, res) => {
  const payment = await Payment.findById(objectId(req.params.id, 'Payment not found'));
  if (!payment) throw notFound('Payment not found');
  if (payment.status !== 'pending') throw conflict(`This payment is already ${payment.status}`);
  const result = await checkPayment(payment, { source: 'admin' });
  await audit(req, 'payment.checked', { type: 'payment', id: payment.id, label: payment.reference }, { outcome: result.outcome });
  res.json(await paymentDetail(req, result.payment));
});

router.post('/payments/:id/resend-webhook', adminOnly, async (req, res) => {
  const payment = await Payment.findById(objectId(req.params.id, 'Payment not found'));
  if (!payment) throw notFound('Payment not found');
  const delivery = await resendPaymentWebhook(payment);
  if (!delivery) throw conflict(payment.status === 'pending' ? 'Nothing to send until the payment is settled' : 'This platform has no webhook URL');
  await audit(req, 'payment.webhook_resent', { type: 'payment', id: payment.id, label: payment.reference }, { event: delivery.event });
  res.status(202).json(await paymentDetail(req, payment));
});

// --- Platforms -------------------------------------------------------------------------------

const webhookUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      const local = ['localhost', '127.0.0.1'].includes(url.hostname);
      return url.protocol === 'https:' || (url.protocol === 'http:' && (local || env.nodeEnv !== 'production'));
    } catch {
      return false;
    }
  }, 'Webhook URL must be a full https:// address');

const platformFields = {
  name: z.string().trim().min(2, 'Name is required').max(60),
  website: z.string().trim().max(200).optional(),
  till: z.string().regex(/^[a-f0-9]{24}$/i, 'Choose a till'),
  ownership: z.enum(['own', 'partner']).optional(),
  contact: z
    .object({
      name: z.string().trim().max(80).optional(),
      email: z.union([z.literal(''), z.string().trim().email('Contact email looks wrong')]).optional(),
      phone: z.string().trim().max(20).optional(),
    })
    .optional(),
  notes: z.string().trim().max(1000).optional(),
  accountReference: z.string().trim().max(12, 'Account reference: 12 characters max').optional(),
  webhookUrl: webhookUrl.optional(),
};

const createPlatformSchema = z.object({
  ...platformFields,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,29}$/, 'Slug: 2–30 lowercase letters, digits or dashes'),
});
const updatePlatformSchema = z
  .object({ ...platformFields, status: z.enum(['active', 'disabled']) })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

async function requireTill(id) {
  const till = await Till.findById(id);
  if (!till) throw badRequest('That till does not exist');
  return till;
}

async function platformStats(ids) {
  const since = startOfKenyaDay(29);
  const [money, lastPayments, failedWebhooks] = await Promise.all([
    Payment.aggregate([
      { $match: { platform: { $in: ids }, status: 'paid', paidAt: { $gte: since } } },
      { $group: { _id: '$platform', amount: { $sum: received }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([{ $match: { platform: { $in: ids } } }, { $group: { _id: '$platform', at: { $max: '$createdAt' } } }]),
    WebhookDelivery.aggregate([{ $match: { platform: { $in: ids }, status: 'failed' } }, { $group: { _id: '$platform', count: { $sum: 1 } } }]),
  ]);
  const byId = (rows) => new Map(rows.map((row) => [String(row._id), row]));
  const [m, l, f] = [byId(money), byId(lastPayments), byId(failedWebhooks)];
  return (id) => ({
    month: { amount: m.get(String(id))?.amount || 0, count: m.get(String(id))?.count || 0 },
    lastPaymentAt: l.get(String(id))?.at || null,
    failedWebhooks: f.get(String(id))?.count || 0,
  });
}

router.get('/platforms', async (_req, res) => {
  const platforms = await Platform.find().sort({ createdAt: 1 }).populate('till');
  const stats = await platformStats(platforms.map((p) => p._id));
  res.json({ platforms: platforms.map((p) => ({ ...p.toPublic(), stats: stats(p._id) })) });
});

router.get('/platforms/:id', async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found')).populate('till');
  if (!platform) throw notFound('Platform not found');
  const stats = await platformStats([platform._id]);
  const [deliveries, failedDeliveries] = await Promise.all([
    WebhookDelivery.find({ platform: platform._id }).sort({ createdAt: -1 }).limit(8).select('-body -history'),
    WebhookDelivery.find({ platform: platform._id, status: 'failed' }).sort({ createdAt: -1 }).limit(20).select('-body -history'),
  ]);
  res.json({ platform: { ...platform.toPublic(), stats: stats(platform._id) }, deliveries, failedDeliveries });
});

router.post('/platforms', adminOnly, validate(createPlatformSchema), async (req, res) => {
  const body = req.valid.body;
  const till = await requireTill(body.till);
  if (await Platform.exists({ slug: body.slug })) throw conflict(`The slug "${body.slug}" is taken`);

  const platform = new Platform({ ...body, till: till._id });
  const apiKey = platform.issueApiKey();
  const webhookSecret = platform.issueWebhookSecret();
  await platform.save();
  await platform.populate('till');
  await audit(req, 'platform.created', { type: 'platform', id: platform.id, label: platform.slug }, { till: till.name, ownership: platform.ownership });
  res.status(201).json({ platform: platform.toPublic(), apiKey, webhookSecret });
});

router.patch('/platforms/:id', adminOnly, validate(updatePlatformSchema), async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found'));
  if (!platform) throw notFound('Platform not found');
  const body = req.valid.body;
  if (body.till) await requireTill(body.till);

  const before = platform.toPublic();
  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    const old = key === 'till' ? String(platform.till) : key === 'contact' ? before.contact : before[key];
    if (JSON.stringify(old) !== JSON.stringify(value)) changes[key] = { from: old, to: value };
  }
  platform.set(body);
  await platform.save();
  await platform.populate('till');
  // Moving a platform to another till changes where customers' money goes: make it stand out.
  const action = changes.till ? 'platform.till_changed' : changes.status ? `platform.${body.status === 'disabled' ? 'disabled' : 'enabled'}` : 'platform.updated';
  await audit(req, action, { type: 'platform', id: platform.id, label: platform.slug }, changes);
  res.json({ platform: platform.toPublic() });
});

router.post('/platforms/:id/api-key', adminOnly, async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found'));
  if (!platform) throw notFound('Platform not found');
  const apiKey = platform.issueApiKey();
  await platform.save();
  await audit(req, 'platform.api_key_rotated', { type: 'platform', id: platform.id, label: platform.slug });
  res.json({ apiKey, apiKeyHint: platform.apiKeyHint });
});

router.post('/platforms/:id/webhook-secret', adminOnly, async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found'));
  if (!platform) throw notFound('Platform not found');
  const webhookSecret = platform.issueWebhookSecret();
  await platform.save();
  await audit(req, 'platform.webhook_secret_rotated', { type: 'platform', id: platform.id, label: platform.slug });
  res.json({ webhookSecret });
});

router.post('/platforms/:id/test-webhook', adminOnly, async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found')).select('+webhookSecret');
  if (!platform) throw notFound('Platform not found');
  res.json({ result: await sendTestWebhook(platform) });
});

// --- Tills (read-only here; managed with scripts/till.js) ------------------------------------

router.get('/tills', async (_req, res) => {
  const tills = await Till.find().sort({ createdAt: 1 }).select('+consumerKey +consumerSecret +passkey');
  const counts = await Platform.aggregate([{ $group: { _id: '$till', count: { $sum: 1 } } }]);
  const byTill = new Map(counts.map((row) => [String(row._id), row.count]));
  res.json({
    tills: tills.map((till) => ({
      ...till.toPublic(),
      hasCredentials: Boolean(till.consumerKey && till.consumerSecret && till.passkey),
      callbackUrl: `${env.publicUrl}/mpesa/callback/${till.id}/••••••`,
      platforms: byTill.get(till.id) || 0,
    })),
  });
});

// --- Audit log -------------------------------------------------------------------------------

const auditQuery = z.object({
  target: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

router.get('/audit', validate(auditQuery, 'query'), async (req, res) => {
  const { target, page } = req.valid.query;
  const filter = target ? { 'target.id': target } : {};
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ entries, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
});

router.use((req, _res, next) => next(new HttpError(404, `No route for ${req.method} ${req.originalUrl}`)));

export default router;
