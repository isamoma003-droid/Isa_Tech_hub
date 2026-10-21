// The dashboard's API. Every change is written to the audit log.
// Signing in and your own account are in routes/auth.js. ISA Tech staff (admin, viewer) see
// everything; a merchant sees and changes only its own platforms and tills, and the payments,
// invoices and webhooks of those platforms: every query below is scoped with mine() / within().
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAdmin, requireRole } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { AdminUser, STAFF_ROLES } from '../models/AdminUser.js';
import { AuditLog } from '../models/AuditLog.js';
import { INVOICE_STATUSES, Invoice } from '../models/Invoice.js';
import { PAYMENT_STATUSES, Payment } from '../models/Payment.js';
import { PaymentLink } from '../models/PaymentLink.js';
import { Platform } from '../models/Platform.js';
import { Till, envSuffix } from '../models/Till.js';
import { WebhookDelivery } from '../models/WebhookDelivery.js';
import { notifyApprovalDecision } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { billingStanding, closeMonth, collectInvoice, estimate, resolvePlan } from '../services/billing.js';
import { checkCredentials } from '../services/daraja.js';
import { checkPayment } from '../services/payments.js';
import { resendPaymentWebhook, sendTestWebhook } from '../services/webhooks.js';
import { randomToken } from '../utils/crypto.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../utils/httpError.js';
import { isPublicHttpsUrl } from '../utils/network.js';
import { maskPhone, normalizePhone } from '../utils/phone.js';
import { TIME_ZONE, kenyaMonth, previousMonth, startOfKenyaDay } from '../utils/time.js';

const router = Router();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = (id, what = 'Not found') => {
  if (!mongoose.isValidObjectId(id)) throw notFound(what);
  return id;
};
// Money that counts as received: what M-Pesa says was paid.
const received = { $ifNull: ['$paidAmount', '$amount'] };

// --- Who sees what --------------------------------------------------------------------------

router.use(requireAdmin);

// Admins change anything; merchants change their own things (the queries make sure of that);
// viewers change nothing. Staff-only actions use adminOnly.
const adminOnly = requireRole('admin');
const canChange = requireRole('admin', 'merchant');
const staffOnly = requireRole(...STAFF_ROLES);

// How many platforms and tills one merchant account may have.
export const MERCHANT_LIMITS = { platforms: 10, tills: 5 };

router.use(async (req, _res, next) => {
  req.merchant = req.admin.role === 'merchant';
  // The merchant's platforms, for scoping payments, invoices and webhooks.
  req.ownPlatforms = req.merchant ? await Platform.find({ owner: req.admin._id }).distinct('_id') : null;
  next();
});

// Platforms and tills a merchant owns; everything for staff.
const mine = (req) => (req.merchant ? { owner: req.admin._id } : {});
const myTills = (req) => (req.merchant ? { account: req.admin._id } : {});

// Limits a payment / invoice / webhook filter to the merchant's platforms, keeping a platform the
// filter already names only when it is theirs.
function within(req, filter = {}, field = 'platform') {
  if (!req.merchant) return filter;
  const named = filter[field];
  if (named) return { ...filter, [field]: req.ownPlatforms.some((id) => id.equals(named)) ? named : { $in: [] } };
  return { ...filter, [field]: { $in: req.ownPlatforms } };
}

// --- Overview --------------------------------------------------------------------------------

router.get('/stats', async (req, res) => {
  const since = { today: startOfKenyaDay(0), week: startOfKenyaDay(6), month: startOfKenyaDay(29) };
  const scope = within(req);
  const sumSince = (from) =>
    Payment.aggregate([
      { $match: { ...scope, status: 'paid', paidAt: { $gte: from } } },
      { $group: { _id: null, amount: { $sum: received }, count: { $sum: 1 } } },
    ]).then(([row]) => ({ amount: row?.amount || 0, count: row?.count || 0 }));

  const [today, week, month, allTime, daily, byPlatform, outcomes, pending, disputed, failedWebhooks, recent, overdueInvoices, waitingMerchants] = await Promise.all([
    sumSince(since.today),
    sumSince(since.week),
    sumSince(since.month),
    sumSince(new Date(0)),
    Payment.aggregate([
      { $match: { ...scope, status: 'paid', paidAt: { $gte: since.month } } },
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
      { $match: { ...scope, status: 'paid', paidAt: { $gte: since.month } } },
      { $group: { _id: '$platform', amount: { $sum: received }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } },
    ]),
    Payment.aggregate([
      { $match: { ...scope, createdAt: { $gte: since.week }, status: { $ne: 'pending' } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Payment.countDocuments({ ...scope, status: 'pending' }),
    Payment.countDocuments({ ...scope, status: 'disputed' }),
    WebhookDelivery.countDocuments({ ...scope, status: 'failed' }),
    Payment.find(scope).sort({ createdAt: -1 }).limit(8).populate('platform', 'name slug'),
    Invoice.countDocuments({ ...scope, kind: 'subscription', status: 'open', dueAt: { $lt: new Date() } }),
    // Businesses that signed up and wait for an admin (staff only).
    req.merchant ? 0 : AdminUser.countDocuments({ role: 'merchant', active: true, 'approval.status': 'pending' }),
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
    attention: { pending, disputed, failedWebhooks, overdueInvoices, waitingMerchants },
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
  const filter = within(req, paymentFilter(req.valid.query));
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
  const payments = await Payment.find(within(req, paymentFilter(req.valid.query)))
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
      // Viewers see masked numbers; admins and the merchant whose customer it is see them in full.
      phone: req.admin.role === 'viewer' ? maskPhone(payment.phone) : payment.phone,
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

async function findPayment(req, id) {
  const payment = await Payment.findOne(within(req, { _id: objectId(id, 'Payment not found') }));
  if (!payment) throw notFound('Payment not found');
  return payment;
}

router.get('/payments/:id', async (req, res) => {
  res.json(await paymentDetail(req, await findPayment(req, req.params.id)));
});

// Asks Safaricom right now how a pending payment ended.
router.post('/payments/:id/check', canChange, async (req, res) => {
  const payment = await findPayment(req, req.params.id);
  if (payment.status !== 'pending') throw conflict(`This payment is already ${payment.status}`);
  const result = await checkPayment(payment, { source: 'admin' });
  await audit(req, 'payment.checked', { type: 'payment', id: payment.id, label: payment.reference }, { outcome: result.outcome });
  res.json(await paymentDetail(req, result.payment));
});

router.post('/payments/:id/resend-webhook', canChange, async (req, res) => {
  const payment = await findPayment(req, req.params.id);
  const delivery = await resendPaymentWebhook(payment);
  if (!delivery) throw conflict(payment.status === 'pending' ? 'Nothing to send until the payment is settled' : 'This platform has no webhook URL');
  await audit(req, 'payment.webhook_resent', { type: 'payment', id: payment.id, label: payment.reference }, { event: delivery.event });
  res.status(202).json(await paymentDetail(req, payment));
});

// --- Hosted payment links --------------------------------------------------------------------

const linkAmount = z.coerce.number().int().min(env.minAmount).max(env.maxAmount);
const createPaymentLinkSchema = z
  .object({
    platform: z.string().regex(/^[a-f0-9]{24}$/i, 'Choose a platform'),
    title: z.string().trim().min(2, 'Enter a link name').max(100),
    description: z.string().trim().max(500).optional(),
    amountType: z.enum(['fixed', 'customer']),
    amount: linkAmount.optional(),
    minAmount: linkAmount.optional(),
    maxAmount: linkAmount.optional(),
    usage: z.enum(['reusable', 'single-use']).default('reusable'),
    collectName: z.boolean().default(true),
    collectEmail: z.boolean().default(true),
    collectReference: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.amountType === 'fixed' && value.amount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the fixed amount' });
    }
    if (value.amountType === 'customer' && (value.minAmount ?? env.minAmount) > (value.maxAmount ?? env.maxAmount)) {
      ctx.addIssue({ code: 'custom', path: ['maxAmount'], message: 'Maximum amount must be at least the minimum' });
    }
  });

const paymentLinkView = (link) => ({
  ...link.toPublic(),
  url: `${env.appUrl}/pay/${link.slug}`,
  platform: link.platform?.name ? { id: link.platform.id, name: link.platform.name, slug: link.platform.slug } : link.platform,
});

router.get('/payment-links', async (req, res) => {
  const filter = req.merchant ? { platform: { $in: req.ownPlatforms } } : {};
  const links = await PaymentLink.find(filter).sort({ createdAt: -1 }).populate('platform', 'name slug');
  res.json({ paymentLinks: links.map(paymentLinkView) });
});

router.post('/payment-links', canChange, validate(createPaymentLinkSchema), async (req, res) => {
  const body = req.valid.body;
  const platform = await findPlatform(req, body.platform);
  if (platform.status !== 'active') throw conflict('Enable this platform before creating a payment link');

  const link = await PaymentLink.create({
    platform: platform._id,
    slug: randomToken(16).toLowerCase(),
    title: body.title,
    description: body.description,
    amountType: body.amountType,
    ...(body.amountType === 'fixed'
      ? { amount: body.amount }
      : { minAmount: body.minAmount ?? env.minAmount, maxAmount: body.maxAmount ?? env.maxAmount }),
    usage: body.usage,
    collectName: body.collectName,
    collectEmail: body.collectEmail,
    collectReference: body.collectReference,
    createdBy: req.admin._id,
  });
  await link.populate('platform', 'name slug');
  await audit(req, 'payment_link.created', { type: 'payment-link', id: link.id, label: link.title }, { platform: platform.slug, amountType: link.amountType, usage: link.usage });
  res.status(201).json({ paymentLink: paymentLinkView(link) });
});

router.patch('/payment-links/:id', canChange, validate(z.object({ active: z.boolean() })), async (req, res) => {
  const filter = { _id: objectId(req.params.id, 'Payment link not found'), ...(req.merchant ? { platform: { $in: req.ownPlatforms } } : {}) };
  const link = await PaymentLink.findOne(filter).populate('platform', 'name slug');
  if (!link) throw notFound('Payment link not found');
  if (link.status === 'paid') throw conflict('A single-use link that has been paid cannot be reactivated');
  const status = req.valid.body.active ? 'active' : 'disabled';
  if (link.status !== status) {
    link.status = status;
    await link.save();
    await audit(req, `payment_link.${status === 'active' ? 'enabled' : 'disabled'}`, { type: 'payment-link', id: link.id, label: link.title });
  }
  res.json({ paymentLink: paymentLinkView(link) });
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

// A till id, or "isapay": IsaPay's own till (money collected by IsaPay, paid out to the merchant).
const tillRef = z.string().trim().toLowerCase().regex(/^([a-f0-9]{24}|isapay)$/, 'Choose a till');

const platformFields = {
  name: z.string().trim().min(2, 'Name is required').max(60),
  website: z.string().trim().max(200).optional(),
  till: tillRef,
  ownership: z.enum(['own', 'partner']).optional(),
  // Staff only: the merchant account that runs the platform ('' for none).
  owner: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{24}$/i, 'Choose an account')]).optional(),
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

// IsaPay's own till for merchants that let IsaPay collect for them: the first active ISA till.
async function isapayTill() {
  const till = await Till.findOne({ active: true, owner: { $ne: 'partner' }, account: { $exists: false } }).sort({ slot: 1, createdAt: 1 });
  if (!till) throw badRequest("IsaPay's till isn't ready yet. Use your own M-Pesa till, or try again later.");
  return till;
}

// The till a platform may use: staff pick any till; merchants pick IsaPay's or one of their own.
async function requireTill(req, ref) {
  if (ref === 'isapay') return isapayTill();
  const till = await Till.findOne({ _id: ref, ...myTills(req) });
  if (!till) throw badRequest('That till does not exist');
  return till;
}

// Merchants choose their own webhook address, which this server then calls: in production it has
// to be a public https:// address (never this machine or the host's private network).
function checkMerchantWebhook(req, url) {
  if (req.merchant && url && env.nodeEnv === 'production' && !isPublicHttpsUrl(url)) {
    throw badRequest('Webhook URL must be a public https:// address', [{ path: 'webhookUrl', message: 'Use a public https:// address' }]);
  }
}

async function requireMerchant(id) {
  if (!id) return null;
  const account = await AdminUser.findOne({ _id: id, role: 'merchant' });
  if (!account) throw badRequest('That merchant account does not exist');
  return account;
}

async function findPlatform(req, id, select) {
  const query = Platform.findOne({ _id: objectId(id, 'Platform not found'), ...mine(req) });
  const platform = await (select ? query.select(select) : query);
  if (!platform) throw notFound('Platform not found');
  return platform;
}

const OWNER_FIELDS = 'name email business';

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

router.get('/platforms', async (req, res) => {
  const platforms = await Platform.find(mine(req)).sort({ createdAt: 1 }).populate('till').populate('owner', OWNER_FIELDS);
  const stats = await platformStats(platforms.map((p) => p._id));
  res.json({ platforms: platforms.map((p) => ({ ...p.toPublic(), stats: stats(p._id), pricing: resolvePlan(p) })) });
});

router.get('/platforms/:id', async (req, res) => {
  const platform = await findPlatform(req, req.params.id);
  await platform.populate([{ path: 'till' }, { path: 'owner', select: OWNER_FIELDS }]);
  const stats = await platformStats([platform._id]);
  const [deliveries, failedDeliveries] = await Promise.all([
    WebhookDelivery.find({ platform: platform._id }).sort({ createdAt: -1 }).limit(8).select('-body -history'),
    WebhookDelivery.find({ platform: platform._id, status: 'failed' }).sort({ createdAt: -1 }).limit(20).select('-body -history'),
  ]);
  const [current, standing, invoices] = await Promise.all([
    estimate(platform),
    billingStanding(platform),
    Invoice.find({ platform: platform._id }).sort({ period: -1 }).limit(12),
  ]);
  res.json({
    platform: { ...platform.toPublic(), stats: stats(platform._id), pricing: current.pricing },
    billing: {
      currentMonth: { period: current.period, volume: current.volume, estimatedFee: current.fee },
      standing: { state: standing.state, suspendAt: standing.suspendAt || null },
      invoices: invoices.map((invoice) => invoice.toPublic()),
    },
    deliveries,
    failedDeliveries,
  });
});

router.post('/platforms', canChange, validate(createPlatformSchema), async (req, res) => {
  const { owner, ...body } = req.valid.body;
  const till = await requireTill(req, body.till);
  checkMerchantWebhook(req, body.webhookUrl);
  if (req.merchant) {
    if (req.ownPlatforms.length >= MERCHANT_LIMITS.platforms) {
      throw forbidden(`An account can have up to ${MERCHANT_LIMITS.platforms} platforms. Contact IsaPay for more.`);
    }
    // A merchant's platform is a partner platform that it runs. Its contact defaults to the account.
    Object.assign(body, {
      ownership: 'partner',
      owner: req.admin._id,
      contact: {
        name: body.contact?.name || req.admin.name,
        email: body.contact?.email || req.admin.email,
        phone: body.contact?.phone || (req.admin.phone ? `0${req.admin.phone.slice(3)}` : ''),
      },
    });
  } else if (owner) {
    body.owner = (await requireMerchant(owner))._id;
  }
  if (await Platform.exists({ slug: body.slug })) throw conflict(`The slug "${body.slug}" is taken`);

  const platform = new Platform({ ...body, till: till._id });
  const apiKey = platform.issueApiKey();
  const webhookSecret = platform.issueWebhookSecret();
  await platform.save();
  await platform.populate([{ path: 'till' }, { path: 'owner', select: OWNER_FIELDS }]);
  await audit(req, 'platform.created', { type: 'platform', id: platform.id, label: platform.slug }, {
    till: till.name,
    ownership: platform.ownership,
    ...(platform.owner ? { account: platform.owner.email } : {}),
  });
  res.status(201).json({ platform: { ...platform.toPublic(), pricing: resolvePlan(platform) }, apiKey, webhookSecret });
});

router.patch('/platforms/:id', canChange, validate(updatePlatformSchema), async (req, res) => {
  const body = { ...req.valid.body };
  if (req.merchant) {
    // Whether a platform may take payments, and whose it is, are IsaPay's decisions.
    for (const key of ['status', 'ownership', 'owner']) {
      if (key in body) throw forbidden(key === 'status' ? 'Only IsaPay can disable or enable a platform' : 'Only IsaPay can change who runs a platform');
    }
  }
  const platform = await findPlatform(req, req.params.id);
  if (body.till) body.till = String((await requireTill(req, body.till))._id);
  if (body.webhookUrl) checkMerchantWebhook(req, body.webhookUrl);
  if ('owner' in body) body.owner = body.owner ? String((await requireMerchant(body.owner))._id) : null;

  const before = platform.toPublic();
  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    const old = key === 'till' ? String(platform.till) : key === 'owner' ? before.owner?.id || null : key === 'contact' ? before.contact : before[key];
    if (JSON.stringify(old) !== JSON.stringify(value)) changes[key] = { from: old, to: value };
  }
  platform.set({ ...body, ...('owner' in body ? { owner: body.owner || undefined } : {}) });
  await platform.save();
  await platform.populate([{ path: 'till' }, { path: 'owner', select: OWNER_FIELDS }]);
  // Moving a platform to another till changes where customers' money goes: make it stand out.
  const action = changes.till ? 'platform.till_changed' : changes.status ? `platform.${body.status === 'disabled' ? 'disabled' : 'enabled'}` : 'platform.updated';
  await audit(req, action, { type: 'platform', id: platform.id, label: platform.slug }, changes);
  res.json({ platform: { ...platform.toPublic(), pricing: resolvePlan(platform) } });
});

router.post('/platforms/:id/api-key', canChange, async (req, res) => {
  const platform = await findPlatform(req, req.params.id);
  const apiKey = platform.issueApiKey();
  await platform.save();
  await audit(req, 'platform.api_key_rotated', { type: 'platform', id: platform.id, label: platform.slug });
  res.json({ apiKey, apiKeyHint: platform.apiKeyHint });
});

router.post('/platforms/:id/webhook-secret', canChange, async (req, res) => {
  const platform = await findPlatform(req, req.params.id);
  const webhookSecret = platform.issueWebhookSecret();
  await platform.save();
  await audit(req, 'platform.webhook_secret_rotated', { type: 'platform', id: platform.id, label: platform.slug });
  res.json({ webhookSecret });
});

router.post('/platforms/:id/test-webhook', canChange, async (req, res) => {
  const platform = await findPlatform(req, req.params.id, '+webhookSecret');
  res.json({ result: await sendTestWebhook(platform) });
});

// --- Tills ------------------------------------------------------------------------------------
// Admins can correct a till here, and merchants can add and correct their own. Its numbers decide
// where customers' money goes, so every change asks for the person's password again and is
// audited. Daraja keys are write-only: they can be replaced but never read back.

const TILL_SECRETS = '+consumerKey +consumerSecret +passkey';
const hint = (value) => (value ? `…${value.slice(-4)}` : null);

async function tillView(req, till) {
  const platforms = await Platform.find({ till: till._id, ...mine(req) }).select('name slug status').sort({ createdAt: 1 });
  let consumerKeyHint = null;
  try {
    consumerKeyHint = hint(till.consumerKey ? till.credentials().consumerKey : '');
  } catch {
    // Stored with a different HUB_SECRET_KEY: shown as missing.
  }
  return {
    ...till.toPublic(),
    hasCredentials: Boolean(till.consumerKey && till.consumerSecret && till.passkey),
    consumerKeyHint,
    callbackUrl: `${env.publicUrl}/mpesa/callback/${till.id}/••••••`,
    // The host variables that manage this till, e.g. MPESA_CONSUMER_KEY_2 for till 2.
    envVariables: till.slot
      ? ['MPESA_ENV', 'MPESA_SHORTCODE', 'MPESA_TILL_NUMBER', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_PASSKEY'].map((name) => `${name}${envSuffix(till.slot)}`)
      : [],
    platforms: platforms.length,
    platformList: platforms.map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status })),
    // A merchant's own till: whose (shown to staff).
    account: till.account?.email ? { id: till.account.id, name: till.account.name, email: till.account.email } : null,
    updatedAt: till.updatedAt,
  };
}

async function findTill(req, id) {
  const till = await Till.findOne({ _id: objectId(id, 'Till not found'), ...myTills(req) })
    .select(TILL_SECRETS)
    .populate('account', 'name email');
  if (!till) throw notFound('Till not found');
  return till;
}

router.get('/tills', async (req, res) => {
  const tills = await Till.find(myTills(req)).sort({ createdAt: 1 }).select(TILL_SECRETS).populate('account', 'name email');
  // Numbered tills first, in number order; merchants' own (unnumbered) tills after them.
  tills.sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity));
  res.json({ tills: await Promise.all(tills.map((till) => tillView(req, till))) });
});

router.get('/tills/:id', async (req, res) => {
  res.json({ till: await tillView(req, await findTill(req, req.params.id)) });
});

// Guessing the confirmation password is slowed down like sign-in.
const tillEditLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  keyGenerator: (req) => req.admin.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please wait 15 minutes' },
  skip: () => env.nodeEnv === 'test',
});

const digits = (label) => z.string().trim().regex(/^\d{5,8}$/, `${label} must be 5–8 digits`);
const secret = z.string().trim().max(300).optional();
const tillUpdateSchema = z.object({
  password: z.string().min(1, 'Enter your password to confirm'),
  name: z.string().trim().min(2, 'Give the till a name').max(60).optional(),
  kind: z.enum(['till', 'paybill']).optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  owner: z.enum(['isa', 'partner']).optional(),
  shortcode: digits('The store / Paybill number').optional(),
  tillNumber: z.union([z.literal(''), digits('The till number')]).optional(),
  active: z.boolean().optional(),
  // Blank or missing keeps the current value.
  consumerKey: secret,
  consumerSecret: secret,
  passkey: secret,
});

const confirmPassword = async (req, password) => {
  const admin = await AdminUser.findById(req.admin._id).select('+passwordHash');
  if (!admin.passwordHash) throw forbidden('Set a password under Your account first: it is asked again before any till change.');
  if (!(await admin.checkPassword(password))) throw new HttpError(403, 'Your password is wrong, so nothing was changed');
};

const required = (label) => z.string().trim().min(1, `Enter the ${label}`).max(300);
const tillCreateSchema = z.object({
  password: z.string().min(1, 'Enter your password to confirm'),
  name: z.string().trim().min(2, 'Give the till a name').max(60),
  kind: z.enum(['till', 'paybill']),
  environment: z.enum(['sandbox', 'production']),
  owner: z.enum(['isa', 'partner']).default('isa'),
  shortcode: digits('The store / Paybill number'),
  tillNumber: z.union([z.literal(''), digits('The till number')]).optional(),
  consumerKey: required('consumer key'),
  consumerSecret: required('consumer secret'),
  passkey: required('passkey'),
});

// Adds a till. Staff tills get the next free number ("M-Pesa till 2"), so their keys never overlap
// with another till's. A merchant's till is theirs alone: unnumbered, and always the partner's own
// (money goes straight to the merchant; IsaPay bills a subscription).
router.post('/tills', canChange, tillEditLimiter, validate(tillCreateSchema), async (req, res) => {
  const { password, consumerKey, consumerSecret, passkey, tillNumber, ...fields } = req.valid.body;
  await confirmPassword(req, password);
  if (fields.kind === 'till' && !tillNumber) throw badRequest('A Buy Goods till needs its till number');
  if (req.merchant && (await Till.countDocuments({ account: req.admin._id })) >= MERCHANT_LIMITS.tills) {
    throw forbidden(`An account can have up to ${MERCHANT_LIMITS.tills} tills. Contact IsaPay for more.`);
  }

  let till;
  for (let attempt = 0; ; attempt += 1) {
    const placement = req.merchant ? { owner: 'partner', account: req.admin._id } : { slot: await Till.nextSlot() };
    till = new Till({ ...fields, ...placement, tillNumber: fields.kind === 'till' ? tillNumber : undefined, source: 'dashboard' });
    till.setCredentials({ consumerKey, consumerSecret, passkey });
    try {
      await till.save();
      break;
    } catch (err) {
      // Two admins adding a till at once: take the next number.
      if (err?.code !== 11000 || attempt >= 3) throw err;
    }
  }
  await audit(req, 'till.created', { type: 'till', id: till.id, label: till.name }, {
    slot: till.slot,
    kind: till.kind,
    environment: till.environment,
    owner: till.owner,
    payNumber: till.payNumber,
  });
  res.status(201).json({ till: await tillView(req, await findTill(req, till.id)) });
});

router.patch('/tills/:id', canChange, tillEditLimiter, validate(tillUpdateSchema), async (req, res) => {
  const { password, consumerKey, consumerSecret, passkey, ...fields } = req.valid.body;
  if (req.merchant && fields.owner && fields.owner !== 'partner') throw forbidden('Your tills are always your own');
  await confirmPassword(req, password);

  const till = await findTill(req, req.params.id);
  const before = {
    name: till.name,
    kind: till.kind,
    environment: till.environment,
    owner: till.owner || 'isa',
    shortcode: till.shortcode,
    tillNumber: till.tillNumber || null,
    active: till.active,
  };

  if (fields.kind === 'paybill') fields.tillNumber = '';
  if (fields.tillNumber !== undefined) fields.tillNumber = fields.tillNumber || undefined;
  till.set(fields);
  if (fields.kind === 'paybill' || ('tillNumber' in fields && !fields.tillNumber)) till.tillNumber = undefined;
  if (till.kind === 'till' && !till.tillNumber) throw badRequest('A Buy Goods till needs its till number');

  const credentials = Object.fromEntries(Object.entries({ consumerKey, consumerSecret, passkey }).filter(([, value]) => value));
  till.setCredentials(credentials);

  const details = {};
  for (const [key, from] of Object.entries(before)) {
    const to = key === 'tillNumber' ? till.tillNumber || null : till[key];
    if (from !== to) details[key] = { from, to };
  }
  if (Object.keys(credentials).length) details.credentials = Object.keys(credentials);
  if (!Object.keys(details).length) return res.json({ till: await tillView(req, till), changed: [] });

  await till.save();
  // Where customers' money goes changed: logged as its own action so it stands out.
  const numbers = ['kind', 'environment', 'shortcode', 'tillNumber'].some((key) => details[key]);
  await audit(req, numbers ? 'till.numbers_changed' : 'till.updated', { type: 'till', id: till.id, label: till.name }, details);
  res.json({ till: await tillView(req, till), changed: Object.keys(details) });
});

// Signs in to Daraja with the till's consumer key and secret.
router.post('/tills/:id/check', canChange, async (req, res) => {
  const till = await findTill(req, req.params.id);
  try {
    await checkCredentials(till);
    res.json({ ok: true, message: `Daraja accepted the consumer key and secret (${till.environment}).` });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// --- Billing ---------------------------------------------------------------------------------
// What IsaPay earns from the platforms (services/billing.js).

const money = z.coerce.number().min(0, 'Use 0 or more').max(10_000_000);
const billingSchema = z.object({
  plan: z.enum(['auto', 'exempt', 'percent', 'subscription']),
  // Empty means "use the default".
  percent: z.union([z.null(), z.coerce.number().min(0).max(100, 'A percentage, 0–100')]).optional(),
  monthlyFee: z.union([z.null(), money]).optional(),
  freeAmount: z.union([z.null(), money]).optional(),
  phone: z.union([z.literal(''), z.string().trim().refine((value) => normalizePhone(value), 'Billing phone: a Kenyan mobile number')]).optional(),
  email: z.union([z.literal(''), z.string().trim().email('Billing email looks wrong')]).optional(),
  graceUntil: z.union([z.null(), z.literal(''), z.coerce.date()]).optional(),
});

router.put('/platforms/:id/billing', adminOnly, validate(billingSchema), async (req, res) => {
  const platform = await Platform.findById(objectId(req.params.id, 'Platform not found')).populate('till');
  if (!platform) throw notFound('Platform not found');
  const body = req.valid.body;
  const before = platform.toPublic().billing;
  const next = {
    plan: body.plan,
    percent: body.percent ?? undefined,
    monthlyFee: body.monthlyFee ?? undefined,
    freeAmount: body.freeAmount ?? undefined,
    phone: body.phone ? normalizePhone(body.phone) : undefined,
    email: body.email || undefined,
    graceUntil: body.graceUntil || undefined,
  };
  platform.billing = next;
  await platform.save();
  const after = platform.toPublic().billing;
  const changes = Object.fromEntries(
    Object.keys(after)
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => [key, { from: before[key], to: after[key] }]),
  );
  if (Object.keys(changes).length) await audit(req, 'platform.billing_changed', { type: 'platform', id: platform.id, label: platform.slug }, changes);
  res.json({ platform: { ...platform.toPublic(), pricing: resolvePlan(platform) } });
});

// Staff: what IsaPay earns from every platform. A merchant: what its own platforms pay IsaPay,
// and what IsaPay owes it from money collected on IsaPay's till.
router.get('/billing', async (req, res) => {
  const period = kenyaMonth();
  const scope = within(req);
  const platforms = await Platform.find({ system: { $ne: true }, ...mine(req) }).sort({ createdAt: 1 }).populate('till');
  const rows = await Promise.all(
    platforms.map(async (platform) => {
      const [current, standing] = await Promise.all([estimate(platform, period), billingStanding(platform)]);
      return {
        platform: { id: platform.id, name: platform.name, slug: platform.slug, ownership: platform.ownership },
        till: platform.till ? { name: platform.till.name, owner: platform.till.owner || 'isa', label: platform.till.toPublic().label } : null,
        pricing: current.pricing,
        volume: current.volume,
        estimatedFee: current.fee,
        standing: standing.state,
        suspendAt: standing.suspendAt || null,
      };
    }),
  );
  const yearStart = `${period.slice(0, 4)}-01`;
  const [earned, outstanding, payouts] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...scope, status: 'paid', period: { $gte: yearStart } } },
      { $group: { _id: '$kind', amount: { $sum: '$fee' }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([
      { $match: { ...scope, status: 'open' } },
      { $group: { _id: { $lt: ['$dueAt', new Date()] }, amount: { $sum: '$fee' }, count: { $sum: 1 } } },
    ]),
    Invoice.aggregate([{ $match: { ...scope, payoutStatus: 'pending' } }, { $group: { _id: null, amount: { $sum: '$payout' }, count: { $sum: 1 } } }]),
  ]);
  const pick = (rowsIn, id) => {
    const row = rowsIn.find((r) => r._id === id);
    return { amount: row?.amount || 0, count: row?.count || 0 };
  };
  res.json({
    period,
    lastPeriod: previousMonth(period),
    defaults: env.billing,
    summary: {
      thisMonthEstimate: rows.reduce((sum, row) => sum + row.estimatedFee, 0),
      earnedThisYear: {
        subscription: pick(earned, 'subscription'),
        commission: pick(earned, 'commission'),
      },
      outstanding: pick(outstanding, false),
      overdue: pick(outstanding, true),
      payoutsPending: payouts[0] ? { amount: payouts[0].amount, count: payouts[0].count } : { amount: 0, count: 0 },
    },
    platforms: rows,
  });
});

const invoiceQuery = z.object({
  status: z.enum([...INVOICE_STATUSES, 'overdue', 'payout']).optional(),
  platform: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

router.get('/invoices', validate(invoiceQuery, 'query'), async (req, res) => {
  const { status, platform, page } = req.valid.query;
  const filter = {};
  if (status === 'overdue') Object.assign(filter, { status: 'open', dueAt: { $lt: new Date() } });
  else if (status === 'payout') filter.payoutStatus = 'pending';
  else if (status) filter.status = status;
  if (platform) filter.platform = platform;
  const scoped = within(req, filter);
  const [invoices, total] = await Promise.all([
    Invoice.find(scoped)
      .sort({ period: -1, createdAt: -1 })
      .skip((page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate({ path: 'platform', select: 'name slug owner', populate: { path: 'owner', select: 'name role payout' } }),
    Invoice.countDocuments(scoped),
  ]);
  res.json({
    invoices: invoices.map((invoice) => ({
      ...invoice.toPublic(),
      // Staff: where to send a merchant's payout (the details it gave under Your account).
      ...(!req.merchant && invoice.payoutStatus === 'pending' ? { payTo: payoutDestination(invoice.platform?.owner) } : {}),
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

function payoutDestination(owner) {
  if (owner?.role !== 'merchant' || !owner.payout?.method) return null;
  const { method, phone, bankName, accountName, accountNumber } = owner.payout;
  return { name: owner.name, method, phone: phone || null, bankName: bankName || null, accountName: accountName || null, accountNumber: accountNumber || null };
}

// Writes the invoices for a month now, instead of waiting for the hourly check.
const periodSchema = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'Month as YYYY-MM').optional() });
router.post('/billing/close-month', adminOnly, validate(periodSchema), async (req, res) => {
  const period = req.valid.body.period || previousMonth(kenyaMonth());
  if (period >= kenyaMonth()) throw badRequest('Only a month that has ended can be invoiced');
  const invoices = await closeMonth(period);
  await audit(req, 'billing.month_closed', { type: 'billing', id: period, label: period }, { invoices: invoices.length });
  res.json({ period, invoices: invoices.length });
});

async function findInvoice(req, id) {
  const invoice = await Invoice.findOne(within(req, { _id: objectId(id, 'Invoice not found') }));
  if (!invoice) throw notFound('Invoice not found');
  return invoice;
}
const invoiceTarget = (invoice) => ({ type: 'platform', id: String(invoice.platform), label: invoice.number });

// Sends the M-Pesa prompt for an open subscription invoice (a merchant: paying its own).
router.post('/invoices/:id/collect', canChange, validate(z.object({ phone: z.string().trim().max(20).optional() })), async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  const { payment, error } = await collectInvoice(invoice, { phone: req.valid.body.phone, by: req });
  if (error) return res.status(502).json({ error, payment: payment?.toAdminRow?.() });
  res.status(201).json({ payment: payment.toAdminRow() });
});

const noteSchema = z.object({ receipt: z.string().trim().max(40).optional(), note: z.string().trim().max(300).optional() });

router.post('/invoices/:id/mark-paid', adminOnly, validate(noteSchema), async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  if (invoice.status !== 'open') throw conflict(`This invoice is already ${invoice.status}`);
  Object.assign(invoice, { status: 'paid', paidAt: new Date(), receipt: req.valid.body.receipt || undefined, note: req.valid.body.note || invoice.note });
  await invoice.save();
  await audit(req, 'invoice.marked_paid', invoiceTarget(invoice), { number: invoice.number, amount: invoice.fee, receipt: invoice.receipt || null });
  res.json({ invoice: invoice.toPublic() });
});

router.post('/invoices/:id/void', adminOnly, validate(noteSchema), async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  if (invoice.status !== 'open') throw conflict(`This invoice is already ${invoice.status}`);
  Object.assign(invoice, { status: 'void', note: req.valid.body.note || 'Voided by an admin' });
  await invoice.save();
  await audit(req, 'invoice.voided', invoiceTarget(invoice), { number: invoice.number, amount: invoice.fee, note: invoice.note });
  res.json({ invoice: invoice.toPublic() });
});

router.post('/invoices/:id/payout', adminOnly, validate(z.object({ reference: z.string().trim().min(1, 'Enter the M-Pesa or bank reference').max(100) })), async (req, res) => {
  const invoice = await findInvoice(req, req.params.id);
  if (invoice.payoutStatus !== 'pending') throw conflict('There is no payout waiting on this invoice');
  Object.assign(invoice, { payoutStatus: 'sent', payoutReference: req.valid.body.reference, payoutAt: new Date() });
  await invoice.save();
  await audit(req, 'invoice.payout_sent', invoiceTarget(invoice), { number: invoice.number, amount: invoice.payout, reference: invoice.payoutReference });
  res.json({ invoice: invoice.toPublic() });
});

// --- Accounts --------------------------------------------------------------------------------
// The ISA Tech team and the merchants that signed up. Staff can look; admins approve merchants for
// live payments, add team members, reset passwords and deactivate accounts.

const accountTarget = (account) => ({ type: 'admin', id: account.id, label: account.email });

function accountView(account, platforms = []) {
  const view = account.toPublic();
  if (view.approval) view.approval.by = account.approval?.by || null;
  return { ...view, platforms: platforms.map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status })) };
}

async function findAccount(id) {
  const account = await AdminUser.findById(objectId(id, 'Account not found')).select('+passwordHash +googleId');
  if (!account) throw notFound('Account not found');
  return account;
}

const accountsQuery = z.object({
  kind: z.enum(['merchant', 'staff']).optional(),
  approval: z.enum(['pending', 'approved', 'rejected']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

router.get('/accounts', staffOnly, validate(accountsQuery, 'query'), async (req, res) => {
  const { kind, approval, q, page } = req.valid.query;
  const filter = {};
  if (kind === 'merchant' || approval) filter.role = 'merchant';
  else if (kind === 'staff') filter.role = { $in: STAFF_ROLES };
  if (approval === 'pending') filter['approval.status'] = { $nin: ['approved', 'rejected'] };
  else if (approval) filter['approval.status'] = approval;
  if (q) {
    const text = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ email: text }, { name: text }, { 'business.name': text }];
  }
  const [accounts, total] = await Promise.all([
    AdminUser.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).select('+passwordHash +googleId'),
    AdminUser.countDocuments(filter),
  ]);
  const platforms = await Platform.find({ owner: { $in: accounts.map((a) => a._id) } }).select('name slug status owner');
  res.json({
    accounts: accounts.map((account) => accountView(account, platforms.filter((p) => p.owner.equals(account._id)))),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  });
});

router.get('/accounts/:id', staffOnly, async (req, res) => {
  const account = await findAccount(req.params.id);
  const [platforms, tills] = await Promise.all([
    Platform.find({ owner: account._id }).sort({ createdAt: 1 }).populate('till'),
    Till.find({ account: account._id }).sort({ createdAt: 1 }),
  ]);
  const stats = await platformStats(platforms.map((p) => p._id));
  res.json({
    account: accountView(account, platforms),
    platforms: platforms.map((p) => ({ ...p.toPublic(), stats: stats(p._id), pricing: resolvePlan(p) })),
    tills: tills.map((till) => till.toPublic()),
  });
});

const createAccountSchema = z.object({
  name: z.string().trim().min(2, 'Enter their name').max(80),
  email: z.string().trim().toLowerCase().max(120).email('Enter their email address'),
  role: z.enum(['admin', 'viewer', 'merchant']),
  businessName: z.string().trim().max(100).optional(),
});

// A team member, or a merchant onboarded by IsaPay (approved at once). They get a temporary
// password, shown once, to change after signing in; or they can sign in with Google.
router.post('/accounts', adminOnly, validate(createAccountSchema), async (req, res) => {
  const body = req.valid.body;
  if (await AdminUser.exists({ email: body.email })) throw conflict(`${body.email} already has an account`);
  const account = new AdminUser({ name: body.name, email: body.email, role: body.role });
  if (body.role === 'merchant') {
    account.business = { name: body.businessName || body.name };
    account.approval = { status: 'approved', at: new Date(), by: `${req.admin.name} <${req.admin.email}>`, note: 'Added by IsaPay' };
  }
  const password = randomToken(15);
  await account.setPassword(password);
  await account.save();
  await audit(req, 'admin.created', accountTarget(account), { role: account.role });
  res.status(201).json({ account: accountView(account), password });
});

const updateAccountSchema = z
  .object({
    active: z.boolean(),
    // Staff accounts only: admin ↔ viewer.
    role: z.enum(STAFF_ROLES),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

router.patch('/accounts/:id', adminOnly, validate(updateAccountSchema), async (req, res) => {
  const account = await findAccount(req.params.id);
  const body = req.valid.body;
  const self = account._id.equals(req.admin._id);
  if (body.role && !account.isStaff) throw badRequest("A merchant's role can't be changed");
  // Never yourself, so the person making the change always stays an active admin: nobody can
  // lock everybody out.
  if (self && (body.active === false || (body.role && body.role !== account.role))) throw badRequest("You can't deactivate yourself or change your own role");

  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    if (account[key] !== value) changes[key] = { from: account[key], to: value };
  }
  if (!Object.keys(changes).length) return res.json({ account: accountView(account) });
  account.set(body);
  account.tokenVersion += 1; // the change applies from their next request
  await account.save();
  const action = changes.active ? (body.active ? 'admin.activated' : 'admin.deactivated') : 'admin.role_changed';
  await audit(req, action, accountTarget(account), changes);
  res.json({ account: accountView(account) });
});

const decisionSchema = z.object({ note: z.string().trim().max(500).optional() });

// Approving a merchant lets its platforms take live payments; rejecting stops them.
async function decide(req, res, status) {
  const account = await findAccount(req.params.id);
  if (account.role !== 'merchant') throw badRequest('Only merchant accounts need approving');
  const note = req.valid.body.note || '';
  if (status === 'rejected' && !note) throw badRequest('Tell the merchant why, so they can fix it', [{ path: 'note', message: 'Add a reason' }]);
  const from = account.approval?.status || 'pending';
  account.approval = { status, at: new Date(), by: `${req.admin.name} <${req.admin.email}>`, note: note || undefined };
  await account.save();
  await audit(req, status === 'approved' ? 'account.approved' : 'account.rejected', accountTarget(account), { from, to: status, ...(note ? { note } : {}) });
  const emailed = await notifyApprovalDecision(account);
  res.json({ account: accountView(account), emailed });
}

router.post('/accounts/:id/approve', adminOnly, validate(decisionSchema), (req, res) => decide(req, res, 'approved'));
router.post('/accounts/:id/reject', adminOnly, validate(decisionSchema), (req, res) => decide(req, res, 'rejected'));

// A new temporary password, shown once (for when email isn't set up, or the link didn't arrive).
router.post('/accounts/:id/reset-password', adminOnly, async (req, res) => {
  const account = await findAccount(req.params.id);
  const password = randomToken(15);
  await account.setPassword(password);
  account.tokenVersion += 1;
  await account.save();
  await audit(req, 'admin.password_reset', accountTarget(account));
  res.json({ password });
});

// Confirms an email address by hand, when this server can't send the confirmation email.
router.post('/accounts/:id/verify-email', adminOnly, async (req, res) => {
  const account = await findAccount(req.params.id);
  if (!account.emailVerifiedAt) {
    account.emailVerifiedAt = new Date();
    await account.save();
    await audit(req, 'account.email_verified', accountTarget(account), { by: 'admin' });
  }
  res.json({ account: accountView(account) });
});

// --- Audit log -------------------------------------------------------------------------------

const auditQuery = z.object({
  target: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// A merchant sees what it did, and everything done to its account, platforms and tills (by IsaPay
// too, shown as "IsaPay team").
async function auditScope(req) {
  if (!req.merchant) return {};
  const tills = await Till.find({ account: req.admin._id }).distinct('_id');
  const ids = [req.admin._id, ...req.ownPlatforms, ...tills].map(String);
  return { $or: [{ actor: req.admin._id }, { 'target.id': { $in: ids } }] };
}

router.get('/audit', validate(auditQuery, 'query'), async (req, res) => {
  const { target, page } = req.valid.query;
  const filter = { ...(target ? { 'target.id': target } : {}), ...(await auditScope(req)) };
  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE),
    AuditLog.countDocuments(filter),
  ]);
  const shown = entries.map((entry) => {
    const row = entry.toJSON();
    if (req.merchant && entry.actor && !entry.actor.equals(req.admin._id)) {
      row.actorLabel = 'IsaPay team';
      delete row.ip;
    }
    return row;
  });
  res.json({ entries: shown, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
});

router.use((req, _res, next) => next(new HttpError(404, `No route for ${req.method} ${req.originalUrl}`)));

export default router;
