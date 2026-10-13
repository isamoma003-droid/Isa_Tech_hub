// Outgoing email through any SMTP server (SMTP_URL), e.g. Gmail with an app password. Without
// SMTP_URL nothing is sent: the server logs that an email was skipped, and admins reset
// passwords from the Accounts page instead.
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport = null;
let testTransport = null;

/** Tests: deliver through this object's sendMail(message) instead of SMTP. null restores SMTP. */
export function setMailTransport(fake) {
  testTransport = fake;
}

export const mailEnabled = () => Boolean(testTransport || env.smtpUrl);

function sender() {
  if (env.mailFrom) return env.mailFrom;
  try {
    const user = decodeURIComponent(new URL(env.smtpUrl).username);
    if (user.includes('@')) return `IsaPay <${user}>`;
  } catch {
    // Not a URL: fall through.
  }
  return 'IsaPay <no-reply@isapay.local>';
}

/**
 * Sends one email. Never throws: a mail problem must not undo what the person just did.
 * @returns {Promise<boolean>} whether it was handed to the mail server
 */
export async function sendMail({ to, subject, text }) {
  if (!mailEnabled()) {
    console.log(`Email to ${to} not sent ("${subject}"): set SMTP_URL to send email`);
    return false;
  }
  try {
    const via = testTransport || (transport ??= nodemailer.createTransport(env.smtpUrl));
    await via.sendMail({ from: sender(), to, subject, text });
    return true;
  } catch (err) {
    console.error(`Could not email ${to} ("${subject}"):`, err.message);
    return false;
  }
}
