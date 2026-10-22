import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { Payment } from '../src/models/Payment.js';
import { PaymentLink } from '../src/models/PaymentLink.js';
import { Till, envSuffix } from '../src/models/Till.js';
import { feeFor, resolvePlan } from '../src/services/billing.js';
import { setGoogleCertsFetcher, verifyGoogleIdToken } from '../src/services/google.js';
import { startKeepAlive } from '../src/services/keepAlive.js';
import { parseCallback, setDarajaTransport, stkQuery } from '../src/services/daraja.js';
import { decryptSecret, encryptSecret, signWebhook, verifyWebhookSignature } from '../src/utils/crypto.js';
import { assertPublicDestination, isPrivateAddress, isPublicHttpsUrl } from '../src/utils/network.js';
import { maskPhone, normalizePhone } from '../src/utils/phone.js';
import { darajaTimestamp, kenyaDay, monthRange, previousMonth, startOfKenyaDay } from '../src/utils/time.js';

describe('health endpoint', () => {
  test('allows the configured dashboard origin to read health status', async () => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.deepEqual(await response.json(), { ok: true });
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe('M-Pesa confirmation codes', () => {
  test('exposes Safaricom receipts to platforms and the dashboard', () => {
    const payment = new Payment({
      reference: 'order-123',
      phone: '254712345678',
      amount: 100,
      receipt: 'UA42HD1234',
    });

    assert.equal(payment.toPlatform('demo').mpesaReceipt, 'UA42HD1234');
    assert.equal(payment.toPlatform('demo').receipt, 'UA42HD1234', 'keep the existing API field');
    assert.equal(payment.toAdminRow().mpesaReceipt, 'UA42HD1234');
  });

  test('uses a retained successful callback receipt when a paid payment lacks a top-level receipt', () => {
    const payment = new Payment({
      reference: 'link-example',
      phone: '254712345678',
      amount: 100,
      status: 'paid',
      callback: { resultCode: 0, receipt: 'QGH123ABC' },
    });

    assert.equal(payment.toPlatform('demo').receipt, 'QGH123ABC');
    assert.equal(payment.toAdminRow().mpesaReceipt, 'QGH123ABC');
  });

  test('uses a retained successful callback receipt for a disputed payment', () => {
    const payment = new Payment({
      reference: 'link-example',
      phone: '254712345678',
      amount: 100,
      status: 'disputed',
      callback: { resultCode: 0, receipt: 'DISPUTED123' },
    });

    assert.equal(payment.toPlatform('demo').receipt, 'DISPUTED123');
    assert.equal(payment.toAdminRow().mpesaReceipt, 'DISPUTED123');
  });

  test('payment links do not request a customer-entered reference', () => {
    const link = new PaymentLink({
      title: 'Ticket',
      amountType: 'fixed',
      amount: 100,
    });

    assert.equal(link.toPublic().collectReference, undefined);
  });
});

describe('phone numbers', () => {
  test('normalizes the usual Kenyan formats', () => {
    for (const input of ['0712345678', '712345678', '+254712345678', '254712345678', '0712 345 678', '0712-345-678']) {
      assert.equal(normalizePhone(input), '254712345678', input);
    }
    assert.equal(normalizePhone('0110345678'), '254110345678');
  });

  test('rejects anything else', () => {
    for (const input of ['', '12345', '0812345678', '25471234567', '+1 415 555 0100', 'abc']) {
      assert.equal(normalizePhone(input), null, input);
    }
  });

  test('masks for display', () => {
    assert.equal(maskPhone('254712345678'), '0712***678');
  });
});

describe('secrets at rest', () => {
  test('round-trips and uses a fresh IV each time', () => {
    const a = encryptSecret('passkey-123');
    const b = encryptSecret('passkey-123');
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), 'passkey-123');
    assert.equal(decryptSecret(''), '');
  });

  test('refuses tampered ciphertext', () => {
    const blob = encryptSecret('passkey-123').split(':');
    blob[3] = Buffer.from('something else').toString('base64');
    assert.throws(() => decryptSecret(blob.join(':')));
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ type: 'payment.paid' });

  test('verify with the right secret, within the time window', () => {
    const header = signWebhook('whsec_one', body);
    assert.equal(verifyWebhookSignature('whsec_one', body, header), true);
    assert.equal(verifyWebhookSignature('whsec_two', body, header), false);
    assert.equal(verifyWebhookSignature('whsec_one', `${body} `, header), false);
    assert.equal(verifyWebhookSignature('whsec_one', body, 'garbage'), false);
  });

  test('reject old timestamps (replays)', () => {
    const header = signWebhook('whsec_one', body, Math.floor(Date.now() / 1000) - 3600);
    assert.equal(verifyWebhookSignature('whsec_one', body, header), false);
  });
});

describe('Kenya time', () => {
  test('Daraja timestamps are YYYYMMDDHHmmss in UTC+3', () => {
    assert.equal(darajaTimestamp(new Date('2026-10-01T21:30:05Z')), '20261002003005');
  });

  test('days start at midnight Nairobi', () => {
    const now = new Date('2026-10-01T22:00:00Z'); // 01:00 on 2 October in Nairobi
    assert.equal(kenyaDay(now), '2026-10-02');
    assert.equal(startOfKenyaDay(0, now).toISOString(), '2026-10-01T21:00:00.000Z');
    assert.equal(startOfKenyaDay(1, now).toISOString(), '2026-09-30T21:00:00.000Z');
  });
});

describe('Daraja', () => {
  test('parses a success callback', () => {
    const result = parseCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: '29115-34620561-1',
          CheckoutRequestID: 'ws_CO_191220191020363925',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 1.0 },
              { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
              { Name: 'Balance' },
              { Name: 'TransactionDate', Value: 20191219102115 },
              { Name: 'PhoneNumber', Value: 254708374149 },
            ],
          },
        },
      },
    });
    assert.deepEqual(result, {
      checkoutRequestId: 'ws_CO_191220191020363925',
      merchantRequestId: '29115-34620561-1',
      resultCode: 0,
      resultDesc: 'The service request is processed successfully.',
      amount: 1,
      receipt: 'NLJ7RT61SV',
      phone: '254708374149',
      transactionDate: '20191219102115',
    });
  });

  test('parses a failure callback and ignores junk', () => {
    const result = parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'ws_1', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });
    assert.equal(result.resultCode, 1032);
    assert.equal(result.receipt, undefined);
    assert.equal(parseCallback({ hello: 'world' }), null);
  });

  test('maps status-query answers to states', async () => {
    const till = new Till({ name: 'T', kind: 'till', environment: 'sandbox', shortcode: '174379', tillNumber: '5551234' });
    till.setCredentials({ consumerKey: 'k', consumerSecret: 's', passkey: 'p' });
    let answer;
    setDarajaTransport(async (url) =>
      url.includes('/oauth/') ? { status: 200, json: { access_token: 'tok', expires_in: '3599' } } : answer,
    );
    try {
      answer = { status: 200, json: { ResponseCode: '0', ResultCode: '0', ResultDesc: 'ok' } };
      assert.equal((await stkQuery(till, 'ws_1')).state, 'success');
      answer = { status: 200, json: { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' } };
      assert.deepEqual(await stkQuery(till, 'ws_1'), { state: 'failed', resultCode: 1032, resultDesc: 'Request cancelled by user' });
      answer = { status: 500, json: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } };
      assert.equal((await stkQuery(till, 'ws_1')).state, 'pending');
      answer = { status: 200, json: { ResponseCode: '0', ResultCode: '4999', ResultDesc: 'still under processing' } };
      assert.equal((await stkQuery(till, 'ws_1')).state, 'pending');
      answer = { status: 400, json: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid CheckoutRequestID' } };
      assert.equal((await stkQuery(till, 'ws_1')).state, 'unknown');
      answer = { status: 502, json: null };
      await assert.rejects(stkQuery(till, 'ws_1'));
    } finally {
      setDarajaTransport(null);
    }
  });
});

describe('numbered tills', () => {
  test('till 1 uses the plain variable names, till N adds _N', () => {
    assert.equal(envSuffix(1), '');
    assert.equal(envSuffix(2), '_2');
    assert.equal(envSuffix(12), '_12');
    const till = new Till({ name: 'Two', kind: 'paybill', environment: 'sandbox', shortcode: '600000', slot: 2 });
    assert.equal(till.toPublic().label, 'M-Pesa till 2');
    assert.equal(till.toPublic().envSuffix, '_2');
  });
});

describe('keep-alive', () => {
  test('pings the public address on a timer, and never localhost', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const calls = [];
    const stop = startKeepAlive({ url: 'https://hub.test/health', everyMs: 600_000, fetchFn: async (url) => (calls.push(url), { ok: true }) });
    assert.deepEqual(calls, ['https://hub.test/health']);
    t.mock.timers.tick(600_000);
    t.mock.timers.tick(600_000);
    await Promise.resolve();
    assert.deepEqual(calls, ['https://hub.test/health', 'https://hub.test/health', 'https://hub.test/health']);
    stop();
    t.mock.timers.tick(600_000);
    assert.equal(calls.length, 3);

    const local = [];
    startKeepAlive({ url: 'http://localhost:5100/health', fetchFn: async (url) => local.push(url) })();
    assert.equal(local.length, 0);
  });
});

describe('billing', () => {
  const pricing = { plan: 'percent', percent: 1.5, monthlyFee: 1000, freeAmount: 10_000 };

  test('a percentage above the free amount', () => {
    assert.equal(feeFor(pricing, { amount: 8000 }), 0);
    assert.equal(feeFor(pricing, { amount: 30_000 }), 300);
    assert.equal(feeFor({ ...pricing, freeAmount: 0 }, { amount: 333 }), 5);
  });

  test('a subscription unless the month stays under the free amount', () => {
    const sub = { ...pricing, plan: 'subscription' };
    assert.equal(feeFor(sub, { amount: 10_000 }), 0);
    assert.equal(feeFor(sub, { amount: 10_001 }), 1000);
    assert.equal(feeFor({ ...pricing, plan: 'exempt' }, { amount: 1e6 }), 0);
  });

  test('the plan follows whose platform and whose till', () => {
    assert.equal(resolvePlan({ ownership: 'own' }, { owner: 'isa' }).plan, 'exempt');
    assert.equal(resolvePlan({ ownership: 'partner' }, { owner: 'isa' }).plan, 'percent');
    assert.equal(resolvePlan({ ownership: 'partner' }, { owner: 'partner' }).plan, 'subscription');
    assert.equal(resolvePlan({ ownership: 'own', billing: { plan: 'subscription', monthlyFee: 500 } }, {}).monthlyFee, 500);
  });

  test('Kenyan months', () => {
    assert.equal(previousMonth('2026-01'), '2025-12');
    assert.equal(monthRange('2026-10').start.toISOString(), '2026-09-30T21:00:00.000Z');
    assert.equal(monthRange('2026-12').end.toISOString(), '2026-12-31T21:00:00.000Z');
  });
});

describe('merchant webhook addresses', () => {
  test('must be public https addresses', () => {
    for (const url of ['https://shop.example.com/hooks/isapay', 'https://8.8.8.8/x', 'https://[2606:4700::1111]/x']) {
      assert.equal(isPublicHttpsUrl(url), true, url);
    }
    for (const url of [
      'http://shop.example.com/hooks',
      'https://localhost/x',
      'https://api.localhost/x',
      'https://printer.local/x',
      'https://metadata.google.internal/x',
      'https://intranet/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.20.0.5/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'https://[::ffff:10.0.0.1]/x',
      'https://user:pass@shop.example.com/x',
      'not a url',
    ]) {
      assert.equal(isPublicHttpsUrl(url), false, url);
    }
    assert.equal(isPrivateAddress('41.90.1.1'), false);
    assert.equal(isPrivateAddress('0.0.0.0'), true);
  });

  test('a public name that resolves to a private address is refused before delivery', async () => {
    const resolvesTo = (address) => async () => [{ address, family: 4 }];
    await assert.doesNotReject(assertPublicDestination('https://shop.example.com/x', resolvesTo('41.90.1.1')));
    await assert.rejects(assertPublicDestination('https://sneaky.example.com/x', resolvesTo('10.0.0.7')), /private network/);
    await assert.rejects(assertPublicDestination('https://127.0.0.1/x'), /private network/);
  });
});

describe('Google sign-in tokens', () => {
  const clientIds = ['web-client.apps.googleusercontent.com'];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const sign = (claims = {}, { key = privateKey, kid = 'key-1', ...options } = {}) =>
    jwt.sign(
      { email: 'Wanjiku@gmail.com', email_verified: true, name: 'Wanjiku', picture: 'https://lh3.googleusercontent.com/a/x', ...claims },
      key,
      { algorithm: 'RS256', keyid: kid, audience: clientIds[0], issuer: 'https://accounts.google.com', subject: '1234567890', expiresIn: '1h', ...options },
    );

  test('accepts a token Google signed for our client', async (t) => {
    let fetches = 0;
    setGoogleCertsFetcher(async () => {
      fetches += 1;
      return { json: { keys: [jwk] }, maxAge: 3600 };
    });
    t.after(() => setGoogleCertsFetcher(null));
    const who = await verifyGoogleIdToken(sign(), { clientIds });
    assert.deepEqual(who, { googleId: '1234567890', email: 'wanjiku@gmail.com', name: 'Wanjiku', picture: 'https://lh3.googleusercontent.com/a/x', authoritative: true });
    await verifyGoogleIdToken(sign(), { clientIds });
    assert.equal(fetches, 1, "Google's keys are cached");

    // Google is the authority for Gmail and for Workspace domains (hd), not for other addresses.
    assert.equal((await verifyGoogleIdToken(sign({ email: 'a@shop.co.ke' }), { clientIds })).authoritative, false);
    assert.equal((await verifyGoogleIdToken(sign({ email: 'a@shop.co.ke', hd: 'shop.co.ke' }), { clientIds })).authoritative, true);
  });

  test('refuses forged, foreign, expired and unverified tokens', async (t) => {
    setGoogleCertsFetcher(async () => ({ json: { keys: [jwk] }, maxAge: 3600 }));
    t.after(() => setGoogleCertsFetcher(null));
    const refused = (token) => assert.rejects(verifyGoogleIdToken(token, { clientIds }), (err) => err.status === 401);
    await refused(sign({}, { key: other.privateKey }));
    await refused(sign({}, { kid: 'unknown-key' }));
    await refused(sign({}, { audience: 'someone-elses-client' }));
    await refused(sign({}, { issuer: 'https://evil.example' }));
    await refused(sign({}, { expiresIn: -120 }));
    await refused(sign({ email_verified: false }));
    await refused(jwt.sign({ sub: '1', email: 'a@gmail.com', email_verified: true }, 'shared-secret', { algorithm: 'HS256', keyid: 'key-1', audience: clientIds[0], issuer: 'accounts.google.com' }));
    await refused('not-a-token');
    await assert.rejects(verifyGoogleIdToken(sign(), { clientIds: [] }), (err) => err.status === 503);
  });
});
