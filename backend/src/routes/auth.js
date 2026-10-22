// Signing in to the dashboard, opening a merchant account, and managing your own account.
// Mounted at /api/admin/auth. Every sign-in and every change is written to the audit log.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAdmin, signAdminToken } from '../middleware/adminAuth.js';
import { validate } from '../middleware/validate.js';
import { AdminUser } from '../models/AdminUser.js';
import { consumeToken, notifyAdminsOfSignup, sendEmailCheck, sendPasswordReset } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { googleEnabled, verifyGoogleIdToken } from '../services/google.js';
import { emailTemplate } from '../services/emailTemplate.js';
import { mailEnabled, sendMail } from '../services/mailer.js';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../utils/httpError.js';
import { normalizePhone } from '../utils/phone.js';

const router = Router();

const limiter = (limit, minutes, error) =>
  rateLimit({
    windowMs: minutes * 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error },
    skip: () => env.nodeEnv === 'test',
  });
const signInLimiter = limiter(10, 15, 'Too many sign-in attempts, please wait 15 minutes');
const signUpLimiter = limiter(5, 60, 'Too many new accounts from this network, please try again in an hour');
const emailLimiter = limiter(5, 15, 'Too many emails asked for, please wait 15 minutes');
const contactLimiter = limiter(5, 15, 'Too many support messages from this network, please try again later');

const ME = '+passwordHash +googleId';
const loadMe = (id) => AdminUser.findById(id).select(ME);
const target = (user) => ({ type: 'admin', id: user.id, label: user.email });

// A fresh dashboard session for `user` (loaded with ME, so the answer says whether it has a
// password and a linked Google account).
async function session(req, res, user, action, details) {
  user.lastLoginAt = new Date();
  await user.save();
  req.admin = user;
  if (action) await audit(req, action, target(user), details);
  res.json({ token: signAdminToken(user), admin: user.toPublic() });
}

const email = z.string().trim().toLowerCase().max(120).email('Enter your email address');
const newPassword = z.string().min(10, 'Use at least 10 characters for the password').max(200);
const optionalPhone = z
  .union([z.literal(''), z.string().trim().refine((value) => normalizePhone(value), 'Phone: a Kenyan mobile number, e.g. 0712345678')])
  .optional();
const website = z.union([z.literal(''), z.string().trim().max(200).url('Website: a full address, e.g. https://shop.example')]).optional();

// --- Public ----------------------------------------------------------------------------------

// What the sign-in page offers.
router.get('/config', (_req, res) => {
  res.json({
    signup: env.signup,
    google: googleEnabled() ? { clientId: env.googleClientIds[0] } : null,
    email: mailEnabled(),
    support: { email: env.supportEmail, phone: env.supportPhone },
    limits: { minAmount: env.minAmount, maxAmount: env.maxAmount, currency: 'KES' },
  });
});

const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password').max(200) });

router.post('/login', signInLimiter, validate(loginSchema), async (req, res) => {
  const { email: address, password } = req.valid.body;
  const user = await AdminUser.findOne({ email: address }).select(ME);
  if (!user?.active || !(await user.checkPassword(password))) throw unauthorized('Wrong email or password');
  await session(req, res, user, 'auth.login');
});

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(80),
  email,
  password: newPassword,
  businessName: z.string().trim().min(2, 'Enter your business name').max(100),
  phone: optionalPhone,
  website,
});

// Opens a merchant account. It can set up platforms right away; live payments start once an
// IsaPay admin approves the business.
router.post('/register', signUpLimiter, validate(registerSchema), async (req, res) => {
  if (!env.signup) throw forbidden('New accounts are closed. Ask IsaPay for an invitation.');
  const body = req.valid.body;
  if (await AdminUser.exists({ email: body.email })) throw conflict('There is already an account with this email. Sign in instead, or reset your password.');

  const user = new AdminUser({
    name: body.name,
    email: body.email,
    role: 'merchant',
    phone: body.phone ? normalizePhone(body.phone) : undefined,
    business: { name: body.businessName, website: body.website || undefined },
    approval: { status: 'pending' },
  });
  await user.setPassword(body.password);
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) throw conflict('There is already an account with this email. Sign in instead, or reset your password.');
    throw err;
  }
  res.status(201);
  await session(req, res, user, 'account.registered', { method: 'password', business: body.businessName });
  // After the answer: an email problem must not fail the sign-up.
  await Promise.all([sendEmailCheck(user), notifyAdminsOfSignup(user)]).catch((err) => console.error('Sign-up emails failed:', err.message));
});

// "Sign in with Google": signs in the account linked to that Google account; or links an account
// with the same address when Google is the authority for it (Gmail, Google Workspace); or opens a
// new merchant account.
router.post('/google', signInLimiter, validate(z.object({ credential: z.string().min(20).max(5000) })), async (req, res) => {
  const google = await verifyGoogleIdToken(req.valid.body.credential);
  let user = await AdminUser.findOne({ googleId: google.googleId }).select(ME);
  let action = 'auth.login';
  let details = { method: 'google' };

  if (!user) {
    user = await AdminUser.findOne({ email: google.email }).select(ME);
    if (user) {
      if (user.googleId) throw conflict('This account is linked to a different Google account. Sign in with that one, or with your password.');
      if (!google.authoritative) {
        throw conflict('Sign in with your password first, then link Google under Your account.');
      }
      user.googleId = google.googleId;
      user.emailVerifiedAt ??= new Date();
      user.avatarUrl ||= google.picture || undefined;
      details = { method: 'google', linked: true };
    } else {
      if (!env.signup) throw forbidden('New accounts are closed. Ask IsaPay for an invitation.');
      user = new AdminUser({
        name: google.name.slice(0, 80),
        email: google.email,
        role: 'merchant',
        googleId: google.googleId,
        avatarUrl: google.picture || undefined,
        emailVerifiedAt: new Date(),
        approval: { status: 'pending' },
      });
      action = 'account.registered';
      res.status(201);
    }
  }
  if (!user.active) throw forbidden('This account is deactivated. Contact IsaPay.');

  try {
    await session(req, res, user, action, details);
  } catch (err) {
    // Signed up twice at the same moment (two tabs): the first one won.
    if (err?.code === 11000) throw conflict('That account was just created. Please sign in with Google again.');
    throw err;
  }
  if (action === 'account.registered') await notifyAdminsOfSignup(user).catch((err) => console.error('Sign-up email failed:', err.message));
});

router.post('/forgot-password', emailLimiter, validate(z.object({ email })), async (req, res) => {
  const user = await AdminUser.findOne({ email: req.valid.body.email });
  if (user?.active) {
    await sendPasswordReset(user);
    await audit(`password reset requested (${req.ip})`, 'auth.password_reset_requested', target(user));
  }
  // Same answer either way, so this can't be used to find out who has an account.
  res.json({ ok: true, email: mailEnabled() });
});

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(80),
  email,
  subject: z.string().trim().min(3, 'Enter a subject').max(120).refine((value) => !/[\r\n]/.test(value), 'Subject must be a single line'),
  message: z.string().trim().min(10, 'Please include a little more detail').max(5000),
});

router.post('/contact', contactLimiter, validate(contactSchema), async (req, res) => {
  if (!mailEnabled()) throw new HttpError(503, 'Support email is temporarily unavailable. Please try again later.');
  const { name, email: senderEmail, subject, message } = req.valid.body;
  const sent = await sendMail({
    to: env.supportEmail,
    replyTo: senderEmail,
    subject: `IsaPay support: ${subject}`,
    text: `Support request from ${name} <${senderEmail}>\n\n${message}\n`,
    html: emailTemplate({
      preheader: `Support request from ${name}: ${subject}`,
      title: 'New support request',
      paragraphs: ['A customer sent a message through the IsaPay contact form.'],
      details: [
        { label: 'From', value: name },
        { label: 'Email', value: senderEmail },
        { label: 'Subject', value: subject },
      ],
      paragraphsAfterDetails: [message],
      closing: 'Reply to this email to respond directly to the customer.',
    }),
  });
  if (!sent) throw new HttpError(502, 'We could not send your message. Please try again.');
  res.status(202).json({ ok: true });
});

router.post('/reset-password', signInLimiter, validate(z.object({ token: z.string().max(200), password: newPassword })), async (req, res) => {
  const found = await consumeToken(req.valid.body.token, 'reset-password');
  if (!found) throw badRequest('This reset link is wrong, already used or expired. Ask for a new one.');
  if (!found.active) throw forbidden('This account is deactivated. Contact IsaPay.');
  const user = await loadMe(found._id);
  await user.setPassword(req.valid.body.password);
  user.tokenVersion += 1; // signs out every other session
  user.emailVerifiedAt ??= new Date(); // the link reached the inbox
  await session(req, res, user, 'auth.password_reset');
});

router.post('/verify-email', validate(z.object({ token: z.string().max(200) })), async (req, res) => {
  const user = await consumeToken(req.valid.body.token, 'verify-email');
  if (!user) throw badRequest('This link is wrong, already used or expired. Sign in and ask for a new one under Your account.');
  if (!user.emailVerifiedAt) {
    user.emailVerifiedAt = new Date();
    await user.save();
    await audit(user.email, 'account.email_verified', target(user));
  }
  res.json({ ok: true, email: user.email });
});

// --- Your account ----------------------------------------------------------------------------

router.get('/me', requireAdmin, async (req, res) => res.json({ admin: (await loadMe(req.admin._id)).toPublic() }));

const profileSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your name').max(80),
    phone: optionalPhone,
    business: z
      .object({
        name: z.string().trim().min(2, 'Enter your business name').max(100),
        website,
        description: z.string().trim().max(500).optional(),
      })
      .optional(),
    payout: z
      .object({
        method: z.enum(['', 'mpesa', 'bank']),
        phone: optionalPhone,
        bankName: z.string().trim().max(80).optional(),
        accountName: z.string().trim().max(100).optional(),
        accountNumber: z.string().trim().max(40).optional(),
      })
      .optional(),
  })
  .partial();

const PAYOUT_KEYS = ['method', 'phone', 'bankName', 'accountName', 'accountNumber'];

router.patch('/me', requireAdmin, validate(profileSchema), async (req, res) => {
  const user = await loadMe(req.admin._id);
  const body = req.valid.body;
  const before = user.toPublic();
  if (body.name !== undefined) user.name = body.name;
  if (body.phone !== undefined) user.phone = body.phone ? normalizePhone(body.phone) : undefined;
  if (user.role === 'merchant') {
    if (body.business) user.business = { name: body.business.name, website: body.business.website || undefined, description: body.business.description || undefined };
    if (body.payout) {
      const payout = body.payout;
      if (payout.method === 'mpesa' && !payout.phone) throw badRequest('Enter the M-Pesa number IsaPay should pay you on', [{ path: 'payout.phone', message: 'Enter the M-Pesa number' }]);
      if (payout.method === 'bank' && !(payout.bankName && payout.accountName && payout.accountNumber)) {
        throw badRequest('Enter the bank, the account name and the account number');
      }
      user.payout = Object.fromEntries(
        PAYOUT_KEYS.map((key) => [key, (key === 'phone' ? payout.phone && normalizePhone(payout.phone) : payout[key]) || undefined]),
      );
    }
  }
  await user.save();

  const after = user.toPublic();
  // Each changed field from → to ("business.website", "payout.accountNumber"…).
  const changes = {};
  const compare = (from, to, path) => {
    if (from && typeof from === 'object') {
      for (const key of Object.keys(from)) compare(from[key], to?.[key], `${path}.${key}`);
    } else if (from !== to) {
      changes[path] = { from, to };
    }
  };
  for (const key of ['name', 'phone', 'business', 'payout']) compare(before[key], after[key], key);
  // Where IsaPay sends a merchant's money: logged in full, and the merchant is told by email, so
  // a change they didn't make stands out.
  const payoutChanged = Object.keys(changes).some((key) => key.startsWith('payout.'));
  if (Object.keys(changes).length) {
    await audit(req, payoutChanged ? 'account.payout_changed' : 'account.profile_updated', target(user), changes);
  }
  if (payoutChanged && before.payout.method) {
    await sendMail({
      to: user.email,
      subject: 'IsaPay: your payout details changed',
      text: `Hello ${user.name},\n\nThe details IsaPay uses to send you your money were just changed in the dashboard. If this wasn't you, change your password and contact IsaPay at once.\n\n${env.appUrl}/account\n`,
      html: emailTemplate({
        preheader: 'Your IsaPay payout details were changed.',
        title: 'Payout details changed',
        greeting: `Hello ${user.name},`,
        paragraphs: [
          'The details IsaPay uses to send you payouts were just changed in the dashboard.',
          "If you didn't make this change, secure your account and contact IsaPay support immediately.",
        ],
        action: { label: 'Review account security', url: `${env.appUrl}/account` },
      }),
    });
  }
  res.json({ admin: after });
});

const passwordSchema = z.object({
  // Not needed when the account has no password yet (it signs in with Google).
  currentPassword: z.string().max(200).optional(),
  newPassword,
});

router.post('/password', requireAdmin, validate(passwordSchema), async (req, res) => {
  const user = await loadMe(req.admin._id);
  const { currentPassword, newPassword: next } = req.valid.body;
  if (user.passwordHash && !(await user.checkPassword(currentPassword || ''))) throw badRequest('Your current password is wrong');
  const first = !user.passwordHash;
  await user.setPassword(next);
  user.tokenVersion += 1; // signs out every other session
  await session(req, res, user, first ? 'auth.password_set' : 'auth.password_changed');
});

router.post('/google/link', requireAdmin, validate(z.object({ credential: z.string().min(20).max(5000) })), async (req, res) => {
  const google = await verifyGoogleIdToken(req.valid.body.credential);
  const user = await loadMe(req.admin._id);
  const taken = await AdminUser.exists({ googleId: google.googleId, _id: { $ne: user._id } });
  if (taken) throw conflict('That Google account is already linked to another IsaPay account');
  user.googleId = google.googleId;
  user.avatarUrl ||= google.picture || undefined;
  if (google.email === user.email) user.emailVerifiedAt ??= new Date();
  await user.save();
  await audit(req, 'auth.google_linked', target(user), { googleEmail: google.email });
  res.json({ admin: user.toPublic() });
});

router.delete('/google', requireAdmin, async (req, res) => {
  const user = await loadMe(req.admin._id);
  if (!user.passwordHash) throw badRequest('Set a password first, or you would have no way to sign in');
  user.googleId = undefined;
  await user.save();
  await audit(req, 'auth.google_unlinked', target(user));
  res.json({ admin: user.toPublic() });
});

router.post('/verify-email/resend', requireAdmin, emailLimiter, async (req, res) => {
  const user = await loadMe(req.admin._id);
  if (user.emailVerifiedAt) return res.json({ sent: false, verified: true });
  if (!mailEnabled()) throw new HttpError(503, "This server can't send email yet. An IsaPay admin can confirm your account instead.");
  res.json({ sent: await sendEmailCheck(user), verified: false });
});

// Ends every other session (a lost phone, a shared computer); this one gets a new token.
router.post('/sign-out-everywhere', requireAdmin, async (req, res) => {
  const user = await loadMe(req.admin._id);
  user.tokenVersion += 1;
  await session(req, res, user, 'auth.signed_out_everywhere');
});

export default router;
