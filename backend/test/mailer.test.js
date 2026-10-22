import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { sendMail, setMailTransport } from '../src/services/mailer.js';

test('Brevo transactional mail sends verified sender, recipient, and reply-to', async () => {
  const original = {
    fetch: globalThis.fetch,
    provider: env.mailProvider,
    apiKey: env.brevoApiKey,
    smtpUrl: env.smtpUrl,
    mailFrom: env.mailFrom,
  };
  let request;
  try {
    setMailTransport(null);
    env.mailProvider = 'brevo';
    env.brevoApiKey = 'test-api-key';
    env.smtpUrl = '';
    env.mailFrom = 'IsaPay <verified@example.test>';
    globalThis.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 201 };
    };

    const html = '<html><body><h1>Help</h1></body></html>';
    assert.equal(await sendMail({ to: 'support@example.test', subject: 'Help', text: 'Message', html, replyTo: 'payer@example.test' }), true);
    assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(request.options.headers['api-key'], 'test-api-key');
    assert.deepEqual(request.body.sender, { name: 'IsaPay', email: 'verified@example.test' });
    assert.deepEqual(request.body.to, [{ email: 'support@example.test' }]);
    assert.deepEqual(request.body.replyTo, { email: 'payer@example.test' });
    assert.equal(request.body.textContent, 'Message');
    assert.equal(request.body.htmlContent, html);
  } finally {
    globalThis.fetch = original.fetch;
    env.mailProvider = original.provider;
    env.brevoApiKey = original.apiKey;
    env.smtpUrl = original.smtpUrl;
    env.mailFrom = original.mailFrom;
    setMailTransport(null);
  }
});

test('Brevo rejection logs its safe diagnostic without exposing the API key', async () => {
  const original = {
    fetch: globalThis.fetch,
    error: console.error,
    provider: env.mailProvider,
    apiKey: env.brevoApiKey,
    smtpUrl: env.smtpUrl,
    mailFrom: env.mailFrom,
  };
  let logged = '';
  try {
    setMailTransport(null);
    env.mailProvider = 'brevo';
    env.brevoApiKey = 'secret-test-key';
    env.smtpUrl = '';
    env.mailFrom = 'IsaPay <unverified@example.test>';
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: 'invalid_parameter', message: 'Sender email is not verified' }),
    });
    console.error = (...args) => { logged = args.join(' '); };

    assert.equal(await sendMail({ to: 'support@example.test', subject: 'Help', text: 'Message' }), false);
    const logEntry = JSON.parse(logged);
    assert.equal(logEntry.event, 'email.provider_rejected');
    assert.equal(logEntry.httpStatus, 400);
    assert.equal(logEntry.diagnostic, 'invalid_parameter: Sender email is not verified');
    assert.doesNotMatch(logged, /secret-test-key|support@example\.test/);
  } finally {
    globalThis.fetch = original.fetch;
    console.error = original.error;
    env.mailProvider = original.provider;
    env.brevoApiKey = original.apiKey;
    env.smtpUrl = original.smtpUrl;
    env.mailFrom = original.mailFrom;
    setMailTransport(null);
  }
});
