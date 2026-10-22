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
export const mailStatus = () => ({
  enabled: mailEnabled(),
  provider: testTransport ? 'test' : provider(),
  senderConfigured: Boolean(env.mailFrom),
});

function sender() {
  const value = env.mailFrom || 'IsaPay <no-reply@isapay.co.ke>';
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  return match ? { name: match[1].trim() || 'IsaPay', email: match[2].trim() } : { name: 'IsaPay', email: value.trim() };
}

/**
 * A mail problem must not undo the account or payment action that triggered it.
 * @returns {Promise<boolean>} whether it was handed to the mail server
 */
export async function sendMail({ to, subject, text, html, replyTo }) {
  if (!mailEnabled()) {
    console.warn(JSON.stringify({ service: 'isapay', event: 'email.disabled', reason: 'configure_BREVO_API_KEY_or_SMTP_URL' }));
    return false;
  }
  try {
    if (testTransport) {
      await testTransport.sendMail({ from: sender(), to, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {}) });
    } else if (provider() === 'brevo') {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': env.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: sender(),
          to: [{ email: to }],
          subject,
          textContent: text,
          ...(html ? { htmlContent: html } : {}),
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const responseText = await response.text();
        let detail = '';
        try {
          const body = JSON.parse(responseText);
          const code = typeof body.code === 'string' ? body.code : '';
          const message = typeof body.message === 'string' ? body.message : '';
          detail = [code, message].filter(Boolean).join(': ');
        } catch {
          // Brevo may return a non-JSON error page; the HTTP status is still useful.
        }
        const safeDetail = detail
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
          .slice(0, 300);
        console.error(JSON.stringify({
          service: 'isapay',
          event: 'email.provider_rejected',
          provider: 'brevo',
          httpStatus: response.status,
          diagnostic: safeDetail || undefined,
        }));
        return false;
      }
    } else {
      const from = env.mailFrom || `${sender().name} <${sender().email}>`;
      const via = (transport ??= nodemailer.createTransport(env.smtpUrl));
      await via.sendMail({ from, to, subject, text, ...(html ? { html } : {}), ...(replyTo ? { replyTo } : {}) });
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      service: 'isapay',
      event: 'email.transport_error',
      provider: provider(),
      errorType: err?.name || 'Error',
    }));
    return false;
  }
}
