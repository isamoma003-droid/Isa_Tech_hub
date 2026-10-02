// End-to-end tests: the real app against a real MongoDB, with Safaricom faked and a little
// HTTP server standing in for a platform's webhook endpoint.
//   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/isa-hub-test npm test
// Use a throwaway database: the tests drop it.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { AdminUser } from '../src/models/AdminUser.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { Till } from '../src/models/Till.js';
import { WebhookDelivery } from '../src/models/WebhookDelivery.js';
import { callbacksIdle } from '../src/routes/mpesa.js';
import { assignSlots, bootstrapAdmin, syncTillFromEnv, syncTillsFromEnv } from '../src/services/bootstrap.js';
import { setDarajaTransport } from '../src/services/daraja.js';
import { closeMonth } from '../src/services/billing.js';
import { sweepPendingPayments } from '../src/services/payments.js';
import { deliverDueWebhooks } from '../src/services/webhooks.js';
import { verifyWebhookSignature } from '../src/utils/crypto.js';
import { kenyaMonth, monthRange, previousMonth } from '../src/utils/time.js';

const uri = process.env.MONGODB_URI_TEST;
const { IsaHub, IsaHubError, verifyWebhook } = createRequire(import.meta.url)('../../sdk/node/isa-hub.cjs');

// --- A fake Safaricom ------------------------------------------------------------------------
const daraja = {
  pushes: [],
  queries: [],
  // CheckoutRequestID → what the status query answers. Default: still processing.
  answers: new Map(),
  refusePhones: new Set(),
  reset() {
    this.pushes = [];
    this.queries = [];
    this.answers.clear();
    this.refusePhones.clear();
  },
  async transport(url, { body }) {
    if (url.includes('/oauth/v1/generate')) return { status: 200, json: { access_token: 'token', expires_in: '3599' } };
    if (url.endsWith('/mpesa/stkpush/v1/processrequest')) {
      if (daraja.refusePhones.has(body.PhoneNumber)) return { status: 400, json: { errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' } };
      const id = `ws_CO_${daraja.pushes.length + 1}_${Date.now()}`;
      daraja.pushes.push({ url, body, id });
      return { status: 200, json: { MerchantRequestID: `m-${id}`, CheckoutRequestID: id, ResponseCode: '0', CustomerMessage: 'Success' } };
    }
    if (url.endsWith('/mpesa/stkpushquery/v1/query')) {
      daraja.queries.push(body.CheckoutRequestID);
      return daraja.answers.get(body.CheckoutRequestID) || { status: 500, json: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } };
    }
    return { status: 404, json: null };
  },
};
const success = { status: 200, json: { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' } };
const cancelled = { status: 200, json: { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' } };

const callbackBody = (checkoutRequestId, { resultCode = 0, amount, receipt, phone = 254712345678 } = {}) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: `m-${checkoutRequestId}`,
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...(resultCode === 0
        ? {
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: amount },
                { Name: 'MpesaReceiptNumber', Value: receipt },
                { Name: 'TransactionDate', Value: 20261001120000 },
                { Name: 'PhoneNumber', Value: phone },
              ],
            },
          }
        : {}),
    },
  },
});

describe('ISA Tech Hub API', { skip: !uri && 'set MONGODB_URI_TEST to run the API tests' }, () => {
  let server;
  let base;
  let receiver;
  let receiverUrl;
  const received = [];
  const receiverReplies = []; // status codes to answer with, in order; then 200
  let adminToken;
  let viewerToken;
  let till;
  let tillSecret;
  let platform;
  let apiKey;
  let webhookSecret;
  let otherKey;

  async function request(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text; // CSV and other non-JSON bodies
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  const pay = (body, headers, key = apiKey) => request('POST', '/v1/payments', { body, token: key, headers });
  const callback = async (body, secret = tillSecret, tillId = till.id) => {
    const res = await request('POST', `/mpesa/callback/${tillId}/${secret}`, { body });
    await callbacksIdle();
    return res;
  };
  let phoneCounter = 0;
  const nextPhone = () => `07${String(10_000_000 + (phoneCounter += 1)).padStart(8, '0')}`;
  // Mongoose treats createdAt as immutable, so back-date through the driver.
  const age = (paymentId, ms) =>
    Payment.collection.updateOne({ _id: new mongoose.Types.ObjectId(paymentId) }, { $set: { createdAt: new Date(Date.now() - ms) } });

  before(async () => {
    await connectDb(uri);
    await mongoose.connection.dropDatabase();
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()));
    setDarajaTransport(daraja.transport);

    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body, json: JSON.parse(body) });
        res.statusCode = receiverReplies.shift() || 200;
        res.end('ok');
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/hooks/isa`;

    till = new Till({ name: 'ISA main till', kind: 'till', environment: 'production', shortcode: '600111', tillNumber: '5551234' });
    till.setCredentials({ consumerKey: 'ck', consumerSecret: 'cs', passkey: 'the-passkey' });
    await till.save();
    tillSecret = (await Till.findById(till._id).select('+callbackSecret')).callbackSecret;

    for (const [email, role] of [['owner@isa.test', 'admin'], ['viewer@isa.test', 'viewer']]) {
      const admin = new AdminUser({ email, name: role, role });
      await admin.setPassword('correct horse battery');
      await admin.save();
    }
  });

  after(async () => {
    setDarajaTransport(null);
    server?.close();
    receiver?.close();
    await mongoose.disconnect();
  });

  beforeEach(() => daraja.reset());

  test('dashboard sign-in', async () => {
    assert.equal((await request('POST', '/api/admin/auth/login', { body: { email: 'owner@isa.test', password: 'nope' } })).status, 401);
    const ok = await request('POST', '/api/admin/auth/login', { body: { email: 'OWNER@isa.test', password: 'correct horse battery' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.admin.role, 'admin');
    adminToken = ok.body.token;
    viewerToken = (await request('POST', '/api/admin/auth/login', { body: { email: 'viewer@isa.test', password: 'correct horse battery' } })).body.token;
    assert.equal((await request('GET', '/api/admin/auth/me', { token: adminToken })).body.admin.email, 'owner@isa.test');
    assert.equal((await request('GET', '/api/admin/stats')).status, 401);
  });

  test('onboarding a platform returns its API key and webhook secret once', async () => {
    const tills = await request('GET', '/api/admin/tills', { token: adminToken });
    assert.equal(tills.body.tills[0].payNumber, '5551234');
    assert.equal(tills.body.tills[0].hasCredentials, true);
    assert.ok(!JSON.stringify(tills.body).includes(tillSecret), 'callback secret never leaves the server');

    const denied = await request('POST', '/api/admin/platforms', { token: viewerToken, body: { name: 'X', slug: 'x1', till: till.id } });
    assert.equal(denied.status, 403);

    const created = await request('POST', '/api/admin/platforms', {
      token: adminToken,
      body: { name: 'A-Read', slug: 'a-read', till: till.id, webhookUrl: receiverUrl, accountReference: 'A-Read', ownership: 'own' },
    });
    assert.equal(created.status, 201);
    assert.match(created.body.apiKey, /^isa_sk_/);
    assert.match(created.body.webhookSecret, /^whsec_/);
    assert.equal(created.body.platform.till.payNumber, '5551234');
    ({ apiKey, webhookSecret } = created.body);
    platform = created.body.platform;

    const dup = await request('POST', '/api/admin/platforms', { token: adminToken, body: { name: 'Again', slug: 'a-read', till: till.id } });
    assert.equal(dup.status, 409);

    const other = await request('POST', '/api/admin/platforms', {
      token: adminToken,
      body: { name: 'EgerTickets', slug: 'egertickets', till: till.id, ownership: 'own' },
    });
    otherKey = other.body.apiKey;

    const listed = await request('GET', '/api/admin/platforms', { token: viewerToken });
    assert.deepEqual(listed.body.platforms.map((p) => p.slug), ['a-read', 'egertickets']);
    assert.ok(!JSON.stringify(listed.body).includes(apiKey), 'API keys are never shown again');
  });

  test('platform API needs a valid key', async () => {
    assert.equal((await request('GET', '/v1/config')).status, 401);
    assert.equal((await request('GET', '/v1/config', { token: 'isa_sk_wrong' })).status, 401);
    const config = await request('GET', '/v1/config', { token: apiKey });
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.till, { kind: 'till', payNumber: '5551234', accountNumber: null, environment: 'production', active: true });
  });

  test('starting a payment sends a Buy Goods STK push to the till', async () => {
    const res = await pay({ phone: '0712 345 678', amount: 250, reference: 'order-1', purpose: 'donation', metadata: { promo: 'p1' } }, { 'idempotency-key': 'order-1-a' });
    assert.equal(res.status, 201);
    assert.equal(res.body.payment.status, 'pending');
    assert.equal(res.body.payment.phone, '254712345678');
    assert.equal(res.body.payment.platform, 'a-read');

    assert.equal(daraja.pushes.length, 1);
    const sent = daraja.pushes[0].body;
    assert.equal(sent.TransactionType, 'CustomerBuyGoodsOnline');
    assert.equal(sent.BusinessShortCode, '600111');
    assert.equal(sent.PartyB, '5551234');
    assert.equal(sent.Amount, 250);
    assert.equal(sent.PhoneNumber, '254712345678');
    assert.equal(sent.Password, Buffer.from(`600111the-passkey${sent.Timestamp}`).toString('base64'));
    assert.equal(sent.CallBackURL, `https://hub.test/mpesa/callback/${till.id}/${tillSecret}`);
    assert.equal(sent.AccountReference, 'A-Read');

    // Same idempotency key: same payment, no second prompt.
    const again = await pay({ phone: '0712345678', amount: 250, reference: 'order-1' }, { 'idempotency-key': 'order-1-a' });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.payment.id, res.body.payment.id);
    assert.equal(daraja.pushes.length, 1, 'still only the first push');

    // A different payment to the same phone right away is refused (Safaricom would refuse too).
    const busy = await pay({ phone: '0712345678', amount: 100, reference: 'order-2' });
    assert.equal(busy.status, 409);
  });

  test('bad requests are explained', async () => {
    const zero = await pay({ phone: nextPhone(), amount: 0, reference: 'r' });
    assert.equal(zero.status, 400);
    assert.match(zero.body.error, /at least KES 1/);
    const phone = await pay({ phone: '12345', amount: 10, reference: 'r' });
    assert.equal(phone.status, 400);
    assert.match(phone.body.error, /Kenyan mobile number/);
    const noRef = await pay({ phone: nextPhone(), amount: 10 });
    assert.equal(noRef.status, 400);
    const badMeta = await pay({ phone: nextPhone(), amount: 10, reference: 'r', metadata: { $where: 'x' } });
    assert.equal(badMeta.status, 400);
    assert.match(badMeta.body.error, /metadata keys/);
  });

  test('a refused STK push fails at once with a clear error', async () => {
    const phone = nextPhone();
    daraja.refusePhones.add(`254${phone.slice(1)}`);
    const res = await pay({ phone, amount: 10, reference: 'refused' });
    assert.equal(res.status, 502);
    assert.equal(res.body.payment.status, 'failed');
    assert.match(res.body.error, /couldn't reach M-Pesa/);
  });

  test('a confirmed callback marks the payment paid and tells the platform once', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 500, reference: 'order-paid' });
    const id = daraja.pushes[0].id;
    daraja.answers.set(id, success);

    assert.equal((await callback(callbackBody(id, { amount: 500, receipt: 'TJ1ABC2DEF' }), 'wrong-secret')).status, 404);
    assert.equal((await Payment.findById(body.payment.id)).status, 'pending');

    const ack = await callback(callbackBody(id, { amount: 500, receipt: 'TJ1ABC2DEF' }));
    assert.equal(ack.status, 200);
    assert.deepEqual(ack.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.deepEqual(daraja.queries, [id], 'success is confirmed with Safaricom before it counts');

    const payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'paid');
    assert.equal(payment.receipt, 'TJ1ABC2DEF');

    // Safaricom retries callbacks; a repeat changes nothing.
    await callback(callbackBody(id, { amount: 500, receipt: 'TJ1ABC2DEF' }));
    assert.equal(await WebhookDelivery.countDocuments({ payment: payment._id }), 1);

    received.length = 0;
    assert.equal(await deliverDueWebhooks(), 1);
    assert.equal(received.length, 1);
    const hook = received[0];
    assert.equal(hook.headers['isa-event'], 'payment.paid');
    assert.ok(verifyWebhookSignature(webhookSecret, hook.body, hook.headers['isa-signature']), 'signature verifies');
    assert.equal(hook.json.type, 'payment.paid');
    assert.equal(hook.json.data.payment.reference, 'order-paid');
    assert.equal(hook.json.data.payment.receipt, 'TJ1ABC2DEF');
    assert.equal((await WebhookDelivery.findOne({ payment: payment._id })).status, 'delivered');

    const polled = await request('GET', `/v1/payments/${payment.id}`, { token: apiKey });
    assert.equal(polled.body.payment.status, 'paid');
    assert.equal(polled.body.payment.message, 'Payment received');
  });

  test('a forged success callback is not trusted', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 300, reference: 'order-forged' });
    const id = daraja.pushes[0].id;
    daraja.answers.set(id, cancelled);
    await callback(callbackBody(id, { amount: 300, receipt: 'FAKE000001' }));
    const payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'failed');
    assert.equal(payment.receipt, undefined);
  });

  test('a different amount is held as disputed', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 1000, reference: 'order-short' });
    const id = daraja.pushes[0].id;
    daraja.answers.set(id, success);
    await callback(callbackBody(id, { amount: 10, receipt: 'TJ1SHORT01' }));
    const payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'disputed');
    assert.equal(payment.paidAmount, 10);
    assert.equal((await WebhookDelivery.findOne({ payment: payment._id })).event, 'payment.disputed');
  });

  test('cancelled, then a late success: the success wins', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 200, reference: 'order-late' });
    const id = daraja.pushes[0].id;
    await callback(callbackBody(id, { resultCode: 1032 }));
    let payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'failed');
    assert.equal(payment.resultCode, 1032);
    assert.equal(payment.toPlatform('a-read').message, 'The payment was cancelled on the phone');

    daraja.answers.set(id, success);
    await callback(callbackBody(id, { amount: 200, receipt: 'TJ1LATE001' }));
    payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'paid');
    const events = (await WebhookDelivery.find({ payment: payment._id }).sort({ createdAt: 1 })).map((d) => d.event);
    assert.deepEqual(events, ['payment.failed', 'payment.paid']);
  });

  test('the sweep settles payments whose callback never came, and a late callback adds the receipt', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 150, reference: 'order-lost' });
    const id = daraja.pushes[0].id;
    await age(body.payment.id, 60_000);

    // Still processing: stays pending.
    let summary = await sweepPendingPayments();
    assert.equal(summary.pending, 1);
    assert.equal((await Payment.findById(body.payment.id)).status, 'pending');

    // Checked moments ago: not asked again yet.
    daraja.answers.set(id, success);
    summary = await sweepPendingPayments();
    assert.equal(summary.scanned, 0);

    await Payment.updateOne({ _id: body.payment.id }, { $set: { lastCheckedAt: new Date(Date.now() - 60_000) } });
    summary = await sweepPendingPayments();
    assert.equal(summary.paid, 1);
    let payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'paid');
    assert.equal(payment.receipt, undefined);

    await callback(callbackBody(id, { amount: 150, receipt: 'TJ1LOST001' }));
    payment = await Payment.findById(body.payment.id);
    assert.equal(payment.receipt, 'TJ1LOST001');
    assert.equal(await WebhookDelivery.countDocuments({ payment: payment._id }), 1, 'no second payment.paid');
  });

  test('the sweep gives up after ten minutes without an answer', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 50, reference: 'order-silent' });
    await age(body.payment.id, 11 * 60_000);
    await sweepPendingPayments();
    const payment = await Payment.findById(body.payment.id);
    assert.equal(payment.status, 'failed');
    assert.equal(payment.resultDesc, 'No answer from M-Pesa');
  });

  test('polling asks Safaricom when the callback is late', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 75, reference: 'order-poll' });
    const id = daraja.pushes[0].id;
    let res = await request('GET', `/v1/payments/${body.payment.id}`, { token: apiKey });
    assert.equal(res.body.payment.status, 'pending');
    assert.equal(daraja.queries.length, 0, 'too early to ask');

    await age(body.payment.id, 30_000);
    daraja.answers.set(id, cancelled);
    res = await request('GET', `/v1/payments/${body.payment.id}`, { token: apiKey });
    assert.equal(res.body.payment.status, 'failed');
    assert.equal(daraja.queries.length, 1);
  });

  test("platforms only see their own payments", async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 20, reference: 'mine' });
    assert.equal((await request('GET', `/v1/payments/${body.payment.id}`, { token: otherKey })).status, 404);
    const mine = await request('GET', '/v1/payments?reference=mine', { token: apiKey });
    assert.equal(mine.body.payments.length, 1);
    const theirs = await request('GET', '/v1/payments?reference=mine', { token: otherKey });
    assert.equal(theirs.body.payments.length, 0);
  });

  test('failed webhooks are retried later', async () => {
    const { body } = await pay({ phone: nextPhone(), amount: 60, reference: 'order-retry' });
    const id = daraja.pushes[0].id;
    daraja.answers.set(id, success);
    await WebhookDelivery.updateMany({ payment: { $ne: new mongoose.Types.ObjectId(body.payment.id) } }, { $set: { status: 'delivered' } });
    await callback(callbackBody(id, { amount: 60, receipt: 'TJ1RETRY01' }));

    receiverReplies.push(500);
    await deliverDueWebhooks();
    let delivery = await WebhookDelivery.findOne({ payment: body.payment.id });
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.lastStatus, 500);
    assert.ok(delivery.nextAttemptAt > new Date(), 'waits before trying again');
    assert.equal(await deliverDueWebhooks(), 0);

    await WebhookDelivery.updateOne({ _id: delivery._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await deliverDueWebhooks();
    delivery = await WebhookDelivery.findById(delivery._id);
    assert.equal(delivery.status, 'delivered');
    assert.equal(delivery.attempts, 2);
  });

  test('dashboard: overview, payments, detail, export', async () => {
    const stats = await request('GET', '/api/admin/stats', { token: viewerToken });
    assert.equal(stats.status, 200);
    // Paid so far: 500 (order-paid) + 200 (late) + 150 (lost) + 60 (retry).
    assert.equal(stats.body.totals.today.amount, 910);
    assert.equal(stats.body.days.length, 30);
    assert.equal(stats.body.days.at(-1).amount, 910);
    assert.equal(stats.body.byPlatform[0].platform.slug, 'a-read');
    assert.equal(stats.body.attention.disputed, 1);

    const paid = await request('GET', `/api/admin/payments?status=paid&platform=${platform.id}`, { token: viewerToken });
    assert.equal(paid.body.total, 4);
    assert.equal(paid.body.paid.amount, 910);
    assert.match(paid.body.payments[0].phone, /^07\d\d\*\*\*\d{3}$/, 'phones are masked in lists');

    const byReceipt = await request('GET', '/api/admin/payments?q=tj1abc2def', { token: viewerToken });
    assert.equal(byReceipt.body.total, 1);
    assert.equal(byReceipt.body.payments[0].reference, 'order-paid');

    const detail = await request('GET', `/api/admin/payments/${byReceipt.body.payments[0].id}`, { token: adminToken });
    assert.equal(detail.body.payment.phone.length, 12, 'admins see the full number');
    assert.ok(detail.body.payment.events.some((e) => e.type === 'callback'));
    assert.equal(detail.body.deliveries[0].status, 'delivered');
    const viewerDetail = await request('GET', `/api/admin/payments/${byReceipt.body.payments[0].id}`, { token: viewerToken });
    assert.match(viewerDetail.body.payment.phone, /\*\*\*/);

    const resent = await request('POST', `/api/admin/payments/${byReceipt.body.payments[0].id}/resend-webhook`, { token: adminToken });
    assert.equal(resent.status, 202);
    assert.equal((await request('POST', `/api/admin/payments/${byReceipt.body.payments[0].id}/resend-webhook`, { token: viewerToken })).status, 403);

    const csv = await request('GET', '/api/admin/payments/export.csv?status=paid', { token: adminToken });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.equal(csv.body.trim().split('\r\n').length, 5);
    assert.match(csv.body, /"TJ1ABC2DEF"/);
  });

  test('rotating a key locks the old one out; disabling a platform stops new payments', async () => {
    const rotated = await request('POST', `/api/admin/platforms/${platform.id}/api-key`, { token: adminToken });
    assert.match(rotated.body.apiKey, /^isa_sk_/);
    assert.equal((await request('GET', '/v1/config', { token: apiKey })).status, 401);
    apiKey = rotated.body.apiKey;
    assert.equal((await request('GET', '/v1/config', { token: apiKey })).status, 200);

    const disabled = await request('PATCH', `/api/admin/platforms/${platform.id}`, { token: adminToken, body: { status: 'disabled' } });
    assert.equal(disabled.body.platform.status, 'disabled');
    assert.equal((await pay({ phone: nextPhone(), amount: 10, reference: 'x' })).status, 403);
    await request('PATCH', `/api/admin/platforms/${platform.id}`, { token: adminToken, body: { status: 'active' } });

    const badUrl = await request('PATCH', `/api/admin/platforms/${platform.id}`, { token: adminToken, body: { webhookUrl: 'not a url' } });
    assert.equal(badUrl.status, 400);
  });

  test('test webhook and audit log', async () => {
    received.length = 0;
    const ping = await request('POST', `/api/admin/platforms/${platform.id}/test-webhook`, { token: adminToken });
    assert.equal(ping.body.result.ok, true);
    assert.equal(received[0].json.type, 'ping');
    assert.ok(verifyWebhookSignature(webhookSecret, received[0].body, received[0].headers['isa-signature']));

    const log = await request('GET', '/api/admin/audit', { token: viewerToken });
    const actions = log.body.entries.map((e) => e.action);
    for (const action of ['auth.login', 'platform.created', 'platform.api_key_rotated', 'platform.disabled', 'platform.enabled', 'payment.webhook_resent', 'payments.exported']) {
      assert.ok(actions.includes(action), `audit log has ${action}`);
    }
    assert.ok(await AuditLog.exists({ actorLabel: /owner@isa\.test/ }));
  });

  test('the Node client in sdk/ works end to end', async () => {
    const hub = new IsaHub({ apiKey, baseUrl: base });
    assert.equal((await hub.config()).till.payNumber, '5551234');

    const { payment } = await hub.createPayment({ phone: nextPhone(), amount: 120, reference: 'sdk-1', idempotencyKey: 'sdk-1-a' });
    assert.equal(payment.status, 'pending');
    assert.equal((await hub.createPayment({ phone: '0700000000', amount: 120, reference: 'sdk-1', idempotencyKey: 'sdk-1-a' })).replayed, true);
    assert.equal((await hub.getPayment(payment.id)).payment.id, payment.id);
    assert.equal((await hub.listPayments({ reference: 'sdk-1' })).payments.length, 1);

    const bad = await hub.createPayment({ phone: '1', amount: 5, reference: 'x' }).catch((err) => err);
    assert.ok(bad instanceof IsaHubError);
    assert.equal(bad.status, 400);

    daraja.answers.set(daraja.pushes[0].id, success);
    await WebhookDelivery.updateMany({}, { $set: { status: 'delivered' } });
    await callback(callbackBody(daraja.pushes[0].id, { amount: 120, receipt: 'TJ1SDK0001' }));
    received.length = 0;
    await deliverDueWebhooks();
    const event = verifyWebhook({ secret: webhookSecret, rawBody: Buffer.from(received[0].body), signature: received[0].headers['isa-signature'] });
    assert.equal(event.type, 'payment.paid');
    assert.equal(event.data.payment.receipt, 'TJ1SDK0001');
    assert.throws(() => verifyWebhook({ secret: 'whsec_wrong', rawBody: received[0].body, signature: received[0].headers['isa-signature'] }));
  });

  test('the first admin and the till can come from environment variables', async () => {
    const vars = { BOOTSTRAP_ADMIN_EMAIL: 'Boss@ISA.test', BOOTSTRAP_ADMIN_PASSWORD: 'a long first password', BOOTSTRAP_ADMIN_NAME: 'Boss' };
    const admin = await bootstrapAdmin(vars);
    assert.equal(admin.email, 'boss@isa.test');
    assert.equal(await bootstrapAdmin(vars), null, 'only once');
    assert.equal(await bootstrapAdmin({ BOOTSTRAP_ADMIN_EMAIL: 'x@isa.test', BOOTSTRAP_ADMIN_PASSWORD: 'short' }), null);
    const login = await request('POST', '/api/admin/auth/login', { body: { email: 'boss@isa.test', password: 'a long first password' } });
    assert.equal(login.status, 200);

    const tillVars = {
      MPESA_ENV: 'production',
      MPESA_SHORTCODE: '700222',
      MPESA_TILL_NUMBER: '8881234',
      MPESA_CONSUMER_KEY: 'key-1',
      MPESA_CONSUMER_SECRET: 'secret-1',
      MPESA_PASSKEY: 'passkey-1',
    };
    assert.equal(await syncTillFromEnv({ MPESA_SHORTCODE: '700222' }), null, 'needs all the credentials');
    const created = await syncTillFromEnv(tillVars);
    assert.equal(created.action, 'created');
    assert.equal(created.till.kind, 'till');
    assert.equal(created.till.payNumber, '8881234');
    assert.equal((await syncTillFromEnv(tillVars)).action, 'unchanged');

    const updated = await syncTillFromEnv({ ...tillVars, MPESA_PASSKEY: 'passkey-2' });
    assert.equal(updated.action, 'updated');
    assert.equal(updated.till.id, created.till.id);
    const stored = await Till.findById(created.till._id).select('+consumerKey +consumerSecret +passkey');
    assert.equal(stored.credentials().passkey, 'passkey-2');
    assert.ok(await AuditLog.exists({ action: 'till.credentials_changed', 'target.id': created.till.id }));

    // Correcting a number fixes the same till (platforms keep pointing at it), never adds a second one.
    const tillsBefore = await Till.countDocuments();
    const corrected = await syncTillFromEnv({ ...tillVars, MPESA_PASSKEY: 'passkey-2', MPESA_TILL_NUMBER: '8885678' });
    assert.equal(corrected.action, 'updated');
    assert.equal(corrected.till.id, created.till.id);
    assert.equal(corrected.till.payNumber, '8885678');
    assert.deepEqual(corrected.changed, ['tillNumber']);
    assert.equal(await Till.countDocuments(), tillsBefore);
    const entry = await AuditLog.findOne({ action: 'till.updated', 'target.id': created.till.id });
    assert.deepEqual(entry.details.tillNumber, { from: '8881234', to: '8885678' });

    // A till created from the variables before tills were marked is recognised from the audit log.
    await Till.collection.updateOne({ _id: created.till._id }, { $unset: { source: '' } });
    const adopted = await syncTillFromEnv({ ...tillVars, MPESA_PASSKEY: 'passkey-2', MPESA_TILL_NUMBER: '8885678', MPESA_SHORTCODE: '700333' });
    assert.equal(adopted.till.id, created.till.id);
    assert.equal(adopted.till.shortcode, '700333');
    assert.equal((await Till.findById(created.till._id)).source, 'env');
    assert.equal(await Till.countDocuments(), tillsBefore);

    // A correction made in the dashboard survives restarts; a variable changed later still applies.
    const latestVars = { ...tillVars, MPESA_PASSKEY: 'passkey-2', MPESA_TILL_NUMBER: '8885678', MPESA_SHORTCODE: '700333' };
    const fixed = await request('PATCH', `/api/admin/tills/${created.till.id}`, {
      token: adminToken,
      body: { password: 'correct horse battery', tillNumber: '8889999' },
    });
    assert.equal(fixed.status, 200);
    assert.equal((await syncTillFromEnv(latestVars)).action, 'unchanged');
    assert.equal((await Till.findById(created.till._id)).tillNumber, '8889999', 'a restart does not undo the dashboard');
    const rotated = await syncTillFromEnv({ ...latestVars, MPESA_PASSKEY: 'passkey-3' });
    assert.deepEqual(rotated.changed, ['passkey']);
    const after = await Till.findById(created.till._id).select('+consumerKey +consumerSecret +passkey');
    assert.equal(after.tillNumber, '8889999');
    assert.equal(after.credentials().passkey, 'passkey-3');
  });

  test('admins can correct a till from the dashboard, with their password', async () => {
    const path = `/api/admin/tills/${till.id}`;
    const body = { password: 'correct horse battery', shortcode: '600222', tillNumber: '5559999' };

    const shown = await request('GET', path, { token: viewerToken });
    assert.equal(shown.body.till.payNumber, '5551234');
    assert.deepEqual(shown.body.till.platformList.map((p) => p.slug), ['a-read', 'egertickets']);
    assert.equal(shown.body.till.consumerKeyHint, '…ck');

    assert.equal((await request('PATCH', path, { token: viewerToken, body })).status, 403);
    assert.equal((await request('PATCH', path, { token: adminToken, body: { shortcode: '600222' } })).status, 400);
    const wrong = await request('PATCH', path, { token: adminToken, body: { ...body, password: 'nope' } });
    assert.equal(wrong.status, 403);
    assert.equal((await Till.findById(till._id)).tillNumber, '5551234', 'nothing changes without the password');
    assert.equal((await request('PATCH', path, { token: adminToken, body: { ...body, shortcode: 'abc' } })).status, 400);

    const saved = await request('PATCH', path, { token: adminToken, body: { ...body, passkey: 'new-passkey' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.till.payNumber, '5559999');
    assert.deepEqual(saved.body.changed.sort(), ['credentials', 'shortcode', 'tillNumber']);
    assert.ok(!JSON.stringify(saved.body).includes('new-passkey'), 'keys are never sent back');
    const entry = await AuditLog.findOne({ action: 'till.numbers_changed', 'target.id': till.id }).sort({ createdAt: -1 });
    assert.deepEqual(entry.details.tillNumber, { from: '5551234', to: '5559999' });
    assert.deepEqual(entry.details.credentials, ['passkey']);

    // The next prompt uses the corrected numbers and passkey.
    await pay({ phone: nextPhone(), amount: 10, reference: 'after-fix' });
    const sent = daraja.pushes[0].body;
    assert.equal(sent.BusinessShortCode, '600222');
    assert.equal(sent.PartyB, '5559999');
    assert.equal(sent.Password, Buffer.from(`600222new-passkey${sent.Timestamp}`).toString('base64'));

    // A Paybill has no till number; a Buy Goods till must have one.
    assert.equal((await request('PATCH', path, { token: adminToken, body: { password: body.password, kind: 'till', tillNumber: '' } })).status, 400);
    const paybill = await request('PATCH', path, { token: adminToken, body: { password: body.password, kind: 'paybill' } });
    assert.equal(paybill.body.till.kind, 'paybill');
    assert.equal(paybill.body.till.tillNumber, null);
    assert.equal(paybill.body.till.payNumber, '600222');

    const check = await request('POST', `${path}/check`, { token: adminToken });
    assert.equal(check.body.ok, true);

    const restored = await request('PATCH', path, {
      token: adminToken,
      body: { password: body.password, kind: 'till', shortcode: '600111', tillNumber: '5551234', passkey: 'the-passkey' },
    });
    assert.equal(restored.body.till.payNumber, '5551234');
  });

  test('numbered MPESA_*_N variables each manage their own till, never another one', async () => {
    // Tills from before numbering get a number first; the variables then use the next free one.
    await assignSlots();
    assert.ok(await Till.exists({ _id: till._id, slot: { $exists: true } }), 'tills from before numbering get a number');
    const n = await Till.nextSlot();
    const vars = {
      MPESA_ENV: 'production',
      MPESA_SHORTCODE: '700333',
      MPESA_TILL_NUMBER: '8885678',
      MPESA_CONSUMER_KEY: 'key-1',
      MPESA_CONSUMER_SECRET: 'secret-1',
      MPESA_PASSKEY: 'passkey-3',
      [`MPESA_SHORTCODE_${n}`]: '710000',
      [`MPESA_CONSUMER_KEY_${n}`]: 'key-two',
      [`MPESA_CONSUMER_SECRET_${n}`]: 'secret-two',
      [`MPESA_PASSKEY_${n}`]: 'passkey-two',
      [`MPESA_TILL_NAME_${n}`]: 'Partner Paybill',
      [`MPESA_ENV_${n}`]: 'sandbox',
    };
    const results = await syncTillsFromEnv(vars);
    const second = results.find((r) => r.till.slot === n);
    assert.equal(second.action, 'created');
    assert.equal(second.till.name, 'Partner Paybill');
    assert.equal(second.till.kind, 'paybill');
    assert.equal(second.till.environment, 'sandbox');
    const one = await Till.findOne({ slot: 1 }).select('+consumerKey +consumerSecret +passkey');
    const two = await Till.findById(second.till._id).select('+consumerKey +consumerSecret +passkey');
    assert.equal(one.source, 'env');
    assert.equal(one.credentials().consumerKey, 'key-1', 'till 1 keeps its own consumer key');
    assert.equal(two.credentials().consumerKey, 'key-two');

    // Rotating till N's key leaves till 1 alone.
    const rotated = (await syncTillsFromEnv({ ...vars, [`MPESA_CONSUMER_KEY_${n}`]: 'key-two-b' })).find((r) => r.till.slot === n);
    assert.deepEqual(rotated.changed, ['consumerKey']);
    assert.equal((await Till.findById(one._id).select('+consumerKey')).credentials().consumerKey, 'key-1');

    // Tills listed with their number and the variables that manage them.
    const listed = await request('GET', '/api/admin/tills', { token: adminToken });
    const shown = listed.body.tills.find((t) => t.slot === n);
    assert.equal(shown.label, `M-Pesa till ${n}`);
    assert.ok(shown.envVariables.includes(`MPESA_CONSUMER_KEY_${n}`));
  });

  test('admins can add a till in the dashboard; it gets the next number', async () => {
    const body = {
      password: 'correct horse battery',
      name: 'Shop till',
      kind: 'till',
      environment: 'production',
      shortcode: '720000',
      tillNumber: '7201234',
      consumerKey: 'shop-key',
      consumerSecret: 'shop-secret',
      passkey: 'shop-passkey',
    };
    assert.equal((await request('POST', '/api/admin/tills', { token: viewerToken, body })).status, 403);
    assert.equal((await request('POST', '/api/admin/tills', { token: adminToken, body: { ...body, password: 'nope' } })).status, 403);
    assert.equal((await request('POST', '/api/admin/tills', { token: adminToken, body: { ...body, tillNumber: '' } })).status, 400);

    const expected = await Till.nextSlot();
    const created = await request('POST', '/api/admin/tills', { token: adminToken, body });
    assert.equal(created.status, 201);
    assert.equal(created.body.till.slot, expected);
    assert.equal(created.body.till.source, 'dashboard');
    assert.equal(created.body.till.hasCredentials, true);
    assert.ok(!JSON.stringify(created.body).includes('shop-secret'), 'keys are never sent back');
    assert.ok(await AuditLog.exists({ action: 'till.created', 'target.id': created.body.till.id }));

    // Variables with that number don't take over a till they didn't create.
    const suffix = `_${expected}`;
    const ignored = await syncTillFromEnv(
      {
        [`MPESA_SHORTCODE${suffix}`]: '730000',
        [`MPESA_CONSUMER_KEY${suffix}`]: 'other',
        [`MPESA_CONSUMER_SECRET${suffix}`]: 'other',
        [`MPESA_PASSKEY${suffix}`]: 'other',
      },
      expected,
    );
    assert.equal(ignored, null);
    assert.equal((await Till.findById(created.body.till.id)).shortcode, '720000');
  });

  test('billing: a % on an ISA till, a subscription on a partner till, suspension when unpaid', async () => {
    const partnerTill = new Till({ name: 'Partner own till', kind: 'paybill', environment: 'production', shortcode: '740000', owner: 'partner', slot: 90 });
    partnerTill.setCredentials({ consumerKey: 'pk', consumerSecret: 'ps', passkey: 'pp' });
    await partnerTill.save();
    const add = async (slug, tillId) =>
      (await request('POST', '/api/admin/platforms', { token: adminToken, body: { name: slug, slug, till: tillId, ownership: 'partner' } })).body;
    const onIsa = await add('shop-on-isa', till.id);
    const onOwn = await add('shop-own-till', partnerTill.id);
    // Created last month, so last month is billed.
    const last = previousMonth(kenyaMonth());
    const { start } = monthRange(last);
    await Promise.all(
      [onIsa, onOwn].map((p) => mongoose.model('Platform').collection.updateOne({ _id: new mongoose.Types.ObjectId(p.platform.id) }, { $set: { createdAt: start } })),
    );

    const shown = await request('GET', `/api/admin/platforms/${onIsa.platform.id}`, { token: adminToken });
    assert.equal(shown.body.platform.pricing.plan, 'percent');
    assert.equal((await request('GET', `/api/admin/platforms/${onOwn.platform.id}`, { token: adminToken })).body.platform.pricing.plan, 'subscription');

    const paidLastMonth = (platformId, tillId, amount, n) =>
      Payment.create({
        platform: platformId,
        till: tillId,
        reference: `last-${platformId}-${n}`,
        phone: '254700000009',
        amount,
        status: 'paid',
        paidAt: new Date(start.getTime() + 5 * 864e5),
      });
    await paidLastMonth(onIsa.platform.id, till.id, 30_000, 1);
    await paidLastMonth(onOwn.platform.id, partnerTill.id, 20_000, 1);

    assert.equal((await request('POST', '/api/admin/billing/close-month', { token: viewerToken, body: { period: last } })).status, 403);
    // Months before billing started are never invoiced.
    assert.deepEqual(await closeMonth(last), []);
    await AuditLog.updateMany({ action: 'billing.started' }, { $set: { 'details.period': last } });
    const closed = await request('POST', '/api/admin/billing/close-month', { token: adminToken, body: { period: last } });
    assert.equal(closed.status, 200);
    const commission = await Invoice.findOne({ platform: onIsa.platform.id, period: last });
    assert.equal(commission.kind, 'commission');
    assert.equal(commission.fee, 300, '1.5% of the KES 20,000 above the free KES 10,000');
    assert.equal(commission.payout, 29_700);
    assert.equal(commission.payoutStatus, 'pending');
    const subscription = await Invoice.findOne({ platform: onOwn.platform.id, period: last });
    assert.equal(subscription.kind, 'subscription');
    assert.equal(subscription.fee, 1000);
    assert.equal(subscription.status, 'open');
    await request('POST', '/api/admin/billing/close-month', { token: adminToken, body: { period: last } });
    assert.equal(await Invoice.countDocuments({ platform: onOwn.platform.id }), 1, 'a month is invoiced once');

    // Overdue past the grace period: no new payments until it's paid or an admin extends the grace.
    await Invoice.updateOne({ _id: subscription._id }, { $set: { dueAt: new Date(Date.now() - 15 * 864e5) } });
    const blocked = await pay({ phone: nextPhone(), amount: 10, reference: 'while-overdue' }, {}, onOwn.apiKey);
    assert.equal(blocked.status, 402);
    assert.match(blocked.body.error, /overdue/);
    const billingView = await request('GET', '/v1/billing', { token: onOwn.apiKey });
    assert.equal(billingView.body.standing.state, 'suspended');
    assert.equal(billingView.body.invoices[0].number, subscription.number);

    const extended = await request('PUT', `/api/admin/platforms/${onOwn.platform.id}/billing`, {
      token: adminToken,
      body: { plan: 'auto', phone: '0712000111', graceUntil: new Date(Date.now() + 3 * 864e5).toISOString() },
    });
    assert.equal(extended.status, 200);
    assert.equal(extended.body.platform.billing.phone, '254712000111');
    assert.equal((await pay({ phone: nextPhone(), amount: 10, reference: 'grace' }, {}, onOwn.apiKey)).status, 201);

    // Collected by M-Pesa prompt into an ISA till; the invoice is paid when the payment is.
    daraja.reset();
    const collect = await request('POST', `/api/admin/invoices/${subscription.id}/collect`, { token: adminToken, body: {} });
    assert.equal(collect.status, 201);
    assert.equal(daraja.pushes[0].body.Amount, 1000);
    assert.equal(daraja.pushes[0].body.PhoneNumber, '254712000111');
    await age(collect.body.payment.id, 60_000);
    daraja.answers.set(daraja.pushes[0].id, success);
    await sweepPendingPayments();
    const settled = await Invoice.findById(subscription._id);
    assert.equal(settled.status, 'paid');
    assert.equal(String(settled.payment), collect.body.payment.id);
    assert.ok(await AuditLog.exists({ action: 'invoice.paid', 'details.number': subscription.number }));

    // Payouts for platforms on an ISA till are marked sent by an admin.
    const payout = await request('POST', `/api/admin/invoices/${commission.id}/payout`, { token: adminToken, body: { reference: 'BANK-123' } });
    assert.equal(payout.body.invoice.payoutStatus, 'sent');
    const summary = await request('GET', '/api/admin/billing', { token: viewerToken });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.platforms.some((row) => row.platform.slug === 'shop-own-till'));
  });

  test('changing your password signs out other sessions', async () => {
    const res = await request('POST', '/api/admin/auth/password', {
      token: viewerToken,
      body: { currentPassword: 'correct horse battery', newPassword: 'an even longer passphrase' },
    });
    assert.equal(res.status, 200);
    assert.equal((await request('GET', '/api/admin/auth/me', { token: viewerToken })).status, 401);
    assert.equal((await request('GET', '/api/admin/auth/me', { token: res.body.token })).status, 200);
  });
});
