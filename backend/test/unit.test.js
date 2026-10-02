import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Till, envSuffix } from '../src/models/Till.js';
import { startKeepAlive } from '../src/services/keepAlive.js';
import { parseCallback, setDarajaTransport, stkQuery } from '../src/services/daraja.js';
import { decryptSecret, encryptSecret, signWebhook, verifyWebhookSignature } from '../src/utils/crypto.js';
import { maskPhone, normalizePhone } from '../src/utils/phone.js';
import { darajaTimestamp, kenyaDay, startOfKenyaDay } from '../src/utils/time.js';

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
    t.mock.timers.tick(600_000);
    t.mock.timers.tick(600_000);
    await Promise.resolve();
    assert.deepEqual(calls, ['https://hub.test/health', 'https://hub.test/health']);
    stop();
    t.mock.timers.tick(600_000);
    assert.equal(calls.length, 2);

    const local = [];
    startKeepAlive({ url: 'http://localhost:5100/health', fetchFn: async (url) => local.push(url) })();
    assert.equal(local.length, 0);
  });
});
