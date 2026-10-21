// Outgoing transactional email through Brevo's API or a legacy SMTP server.
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport = null;
let testTransport = null;

/** Tests: deliver through this object's sendMail(message) instead of the live provider. */
export function setMailTransport(fake) {
  testTransport = fake;
}

const provider = () => (env.mailProvider === 'auto' ? (env.brevoApiKey ? 'brevo' : 'smtp') : env.mailProvider);
export const mailEnabled = () => Boolean(testTransport || (provider() === 'brevo' ? env.brevoApiKey : env.smtpUrl));

function sender() {
  const value = env.mailFrom || 'IsaPay <no-reply@isapay.co.ke>';
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  return match ? { name: match[1].trim() || 'IsaPay', email: match[2].trim() } : { name: 'IsaPay', email: value.trim() };
}

/**
 * A mail problem must not undo the account or payment action that triggered it.
 * @returns {Promise<boolean>} whether it was handed to the mail server
 */
export async function sendMail({ to, subject, text, replyTo }) {
  if (!mailEnabled()) {
    console.log(`Email to ${to} not sent ("${subject}"): configure BREVO_API_KEY or SMTP_URL`);
    return false;
  }
  try {
    if (testTransport) {
      await testTransport.sendMail({ from: sender(), to, subject, text, ...(replyTo ? { replyTo } : {}) });
    } else if (provider() === 'brevo') {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: sender(),
          to: [{ email: to }],
          subject,
          textContent: text,
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        console.error(`Could not email ${to} ("${subject}"): Brevo returned HTTP ${response.status}`);
        return false;
      }
    } else {
      const from = env.mailFrom || `${sender().name} <${sender().email}>`;
      const via = (transport ??= nodemailer.createTransport(env.smtpUrl));
      await via.sendMail({ from, to, subject, text, ...(replyTo ? { replyTo } : {}) });
    }
    return true;
  } catch (err) {
    console.error(`Could not email ${to} ("${subject}"):`, err.message);
    return false;
  }
}
