// Dashboard accounts: one-time email links (password reset, email check) and the emails that go
// with signing up and being approved.
import { env } from '../config/env.js';
import { AdminUser } from '../models/AdminUser.js';
import { AuthToken } from '../models/AuthToken.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { dashboardLink, emailTemplate } from './emailTemplate.js';
import { sendMail } from './mailer.js';

const BRAND_NAME = 'IsaPay';
const HOUR = 3600_000;
const LIFETIME = { 'reset-password': HOUR, 'verify-email': 72 * HOUR };

/** A new one-time link token for `purpose`; earlier ones for the same purpose stop working. */
export async function issueToken(user, purpose) {
  const token = randomToken(32);
  await AuthToken.deleteMany({ user: user._id, purpose });
  await AuthToken.create({ user: user._id, purpose, hash: sha256(token), expiresAt: new Date(Date.now() + LIFETIME[purpose]) });
  return token;
}

/** Uses up a link token. Returns its account, or null when it's wrong, used or expired. */
export async function consumeToken(token, purpose) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const found = await AuthToken.findOneAndDelete({ hash: sha256(token), purpose, expiresAt: { $gt: new Date() } });
  return found ? AdminUser.findById(found.user) : null;
}

const link = (path, token) => `${env.appUrl}${path}?token=${encodeURIComponent(token)}`;

export async function sendEmailCheck(user) {
  const token = await issueToken(user, 'verify-email');
  const verifyUrl = link('/verify-email', token);
  return sendMail({
    to: user.email,
    subject: `Confirm your email for ${BRAND_NAME}`,
    text: `Hello ${user.name},\n\nConfirm that this is your email address by opening this link (it works for 3 days):\n\n${link('/verify-email', token)}\n\nIf you didn't create a ${BRAND_NAME} account, ignore this email.\n`,
    html: emailTemplate({
      preheader: 'Confirm your IsaPay email address.',
      title: 'Confirm your email',
      greeting: `Hello ${user.name},`,
      paragraphs: ['Confirm your email address to finish setting up your IsaPay account. This link expires in 3 days.'],
      action: { label: 'Confirm email address', url: verifyUrl },
      closing: `If you didn't create an ${BRAND_NAME} account, you can ignore this email.`,
    }),
  });
}

export async function sendPasswordReset(user) {
  const token = await issueToken(user, 'reset-password');
  const resetUrl = link('/reset-password', token);
  return sendMail({
    to: user.email,
    subject: `Reset your ${BRAND_NAME} password`,
    text: `Hello ${user.name},\n\nSomeone asked to reset the password of your ${BRAND_NAME} account. To choose a new one, open this link within an hour:\n\n${link('/reset-password', token)}\n\nIf it wasn't you, ignore this email: your password stays as it is.\n`,
    html: emailTemplate({
      preheader: 'Choose a new password for your IsaPay account.',
      title: 'Reset your password',
      greeting: `Hello ${user.name},`,
      paragraphs: ['Someone asked to reset the password for your IsaPay account.', 'This secure link expires in 1 hour and can only be used once.'],
      action: { label: 'Choose a new password', url: resetUrl },
      closing: `If you didn't request this change, ignore this email. Your password will stay as it is.`,
    }),
  });
}

/** Tells the admins a business signed up and is waiting for approval. */
export async function notifyAdminsOfSignup(merchant) {
  const admins = await AdminUser.find({ role: 'admin', active: true }).select('email');
  const business = merchant.business?.name ? ` (${merchant.business.name})` : '';
  const accountsUrl = dashboardLink(`/accounts/${merchant.id}`);
  await Promise.all(
    admins.map((admin) =>
      sendMail({
        to: admin.email,
        subject: `New ${BRAND_NAME} merchant: ${merchant.name}${business}`,
        text: `${merchant.name} <${merchant.email}>${business} opened a merchant account.\n\nReview and approve it under Accounts: ${env.appUrl}/accounts/${merchant.id}\n`,
        html: emailTemplate({
          preheader: `${merchant.name} opened a merchant account.`,
          title: 'New merchant account',
          paragraphs: ['A new business has registered and is waiting for review.'],
          details: [
            { label: 'Contact', value: merchant.name },
            { label: 'Email', value: merchant.email },
            ...(merchant.business?.name ? [{ label: 'Business', value: merchant.business.name }] : []),
          ],
          action: { label: 'Review account', url: accountsUrl },
        }),
      }),
    ),
  );
}

/** Tells a merchant their business was approved, or not. */
export function notifyApprovalDecision(merchant) {
  const approved = merchant.approval?.status === 'approved';
  const dashboardUrl = dashboardLink(approved ? '/' : '/account');
  return sendMail({
    to: merchant.email,
    subject: approved ? `${BRAND_NAME}: your business is approved` : `${BRAND_NAME}: about your merchant account`,
    text: approved
      ? `Hello ${merchant.name},\n\nYour business is approved: your platforms can now take live M-Pesa payments through ${BRAND_NAME}.\n\nDashboard: ${env.appUrl}\n`
      : `Hello ${merchant.name},\n\nWe couldn't approve your merchant account for live payments yet.${merchant.approval?.note ? `\n\nNote from the ${BRAND_NAME} team: ${merchant.approval.note}` : ''}\n\nReply to this email or update your business details in the dashboard: ${env.appUrl}/account\n`,
    html: emailTemplate({
      preheader: approved ? 'Your business can now accept live M-Pesa payments.' : 'There is an update about your IsaPay merchant account.',
      title: approved ? 'Your business is approved' : 'Update about your merchant account',
      greeting: `Hello ${merchant.name},`,
      paragraphs: approved
        ? ['Your business is approved. Your platforms can now take live M-Pesa payments through IsaPay.']
        : ["We couldn't approve your merchant account for live payments yet.", ...(merchant.approval?.note ? [`Note from the IsaPay team: ${merchant.approval.note}`] : [])],
      action: { label: approved ? 'Open IsaPay dashboard' : 'Review business details', url: dashboardUrl },
      closing: approved ? 'Welcome to IsaPay.' : 'Reply to this email if you need help with the review.',
    }),
  });
}
