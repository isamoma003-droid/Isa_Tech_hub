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

    assert.equal(await sendMail({ to: 'support@example.test', subject: 'Help', text: 'Message', replyTo: 'payer@example.test' }), true);
    assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(request.options.headers['api-key'], 'test-api-key');
    assert.deepEqual(request.body.sender, { name: 'IsaPay', email: 'verified@example.test' });
    assert.deepEqual(request.body.to, [{ email: 'support@example.test' }]);
    assert.deepEqual(request.body.replyTo, { email: 'payer@example.test' });
    assert.equal(request.body.textContent, 'Message');
  } finally {
    globalThis.fetch = original.fetch;
    env.mailProvider = original.provider;
    env.brevoApiKey = original.apiKey;
    env.smtpUrl = original.smtpUrl;
    env.mailFrom = original.mailFrom;
    setMailTransport(null);
  }
});
