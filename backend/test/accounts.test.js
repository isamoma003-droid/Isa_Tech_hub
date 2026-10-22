// End-to-end tests for dashboard accounts: signing up, Google sign-in, password resets, and what a
// merchant can see and do. The real app against a real MongoDB, with Safaricom, Google and email
// faked.
//   MONGODB_URI_TEST=mongodb://127.0.0.1:27017/isa-hub-test npm test
// Use a throwaway database: the tests drop it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { AdminUser } from '../src/models/AdminUser.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Invoice } from '../src/models/Invoice.js';
import { Payment } from '../src/models/Payment.js';
import { PaymentLink } from '../src/models/PaymentLink.js';
import { Till } from '../src/models/Till.js';
import { assignSlots } from '../src/services/bootstrap.js';
import { setDarajaTransport } from '../src/services/daraja.js';
import { setGoogleCertsFetcher } from '../src/services/google.js';
import { setMailTransport } from '../src/services/mailer.js';
import { markPaid } from '../src/services/payments.js';

const uri = process.env.MONGODB_URI_TEST;
const PASSWORD = 'correct horse battery';
const GOOGLE_CLIENT = 'web-client.apps.googleusercontent.com';

// Safaricom: every STK push is accepted.
let pushes = 0;
async function darajaTransport(url) {
  if (url.includes('/oauth/v1/generate')) return { status: 200, json: { access_token: 'token', expires_in: '3599' } };
  if (url.endsWith('/mpesa/stkpush/v1/processrequest')) {
    pushes += 1;
    return { status: 200, json: { MerchantRequestID: `m-${pushes}`, CheckoutRequestID: `ws_CO_acc_${pushes}_${Date.now()}`, ResponseCode: '0' } };
  }
  return { status: 500, json: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } };
}

// Google: our own key pair stands in for Google's.
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleJwk = { ...google.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const googleToken = ({ sub, email, name = 'Google Person', ...claims }) =>
  jwt.sign({ email, email_verified: true, name, ...claims }, google.privateKey, {
    algorithm: 'RS256',
    keyid: 'test-key',
    audience: GOOGLE_CLIENT,
    issuer: 'https://accounts.google.com',
    subject: sub,
    expiresIn: '1h',
  });

describe('Accounts', { skip: !uri && 'set MONGODB_URI_TEST to run the API tests' }, () => {
  let server;
  let base;
  let outbox = [];
  let isaTill;
  let adminToken;
  let viewerToken;
  let merchant; // { token, admin }
  let rival; // a second merchant
  let isaPlatform; // run by ISA staff

  async function request(method, path, { body, token } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  const api = (method, path, token, body) => request(method, `/api/admin${path}`, { token, body });
  const signIn = async (email, password = PASSWORD) => (await api('POST', '/auth/login', null, { email, password })).body.token;
  const mailTo = (to) => outbox.filter((mail) => mail.to === to);
  // Sign-up emails go out just after the answer, so give them a moment.
  async function mailFor(to) {
    for (let i = 0; i < 100 && !mailTo(to).length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return mailTo(to);
  }
  const linkToken = (mail) => /token=([\w-]+)/.exec(mail.text)?.[1];
  let phone = 0;
  const nextPhone = () => `0722${String(100_000 + (phone += 1)).padStart(6, '0')}`;

  before(async () => {
    await connectDb(uri);
    await mongoose.connection.dropDatabase();
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()));
    setDarajaTransport(darajaTransport);
    setMailTransport({ sendMail: async (mail) => outbox.push(mail) });
    setGoogleCertsFetcher(async () => ({ json: { keys: [googleJwk] }, maxAge: 3600 }));
    env.googleClientIds = [GOOGLE_CLIENT];
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;

    isaTill = new Till({ name: 'ISA main till', kind: 'till', environment: 'production', shortcode: '600111', tillNumber: '5551234', slot: 1, source: 'env' });
    isaTill.setCredentials({ consumerKey: 'ck', consumerSecret: 'cs', passkey: 'pk' });
    await isaTill.save();
    for (const [email, role] of [['owner@isa.test', 'admin'], ['viewer@isa.test', 'viewer']]) {
      const user = new AdminUser({ email, name: role, role });
      await user.setPassword(PASSWORD);
      await user.save();
    }
    adminToken = await signIn('owner@isa.test');
    viewerToken = await signIn('viewer@isa.test');
    isaPlatform = (await api('POST', '/platforms', adminToken, { name: 'EgerTickets', slug: 'egertickets', till: isaTill.id, ownership: 'own' })).body;
  });

  after(async () => {
    setDarajaTransport(null);
    setMailTransport(null);
    setGoogleCertsFetcher(null);
    env.googleClientIds = [];
    server?.close();
    await mongoose.disconnect();
  });

  beforeEach(() => {
    outbox = [];
  });

  test('the sign-in page learns what it can offer', async () => {
    const config = await api('GET', '/auth/config');
    assert.equal(config.status, 200);
    assert.deepEqual(config.body, {
      signup: true,
      google: { clientId: GOOGLE_CLIENT },
      email: true,
      support: { email: 'support@isapay.co.ke', phone: '+254 700 000 000' },
      limits: { minAmount: 1, maxAmount: 150_000, currency: 'KES' },
    });
  });

  test('a business signs up with email and password, and confirms its email', async () => {
    const weak = await api('POST', '/auth/register', null, { name: 'Amina', email: 'amina@duka.test', password: 'short', businessName: 'Duka Online' });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /10 characters/);

    const res = await api('POST', '/auth/register', null, {
      name: 'Amina Hassan',
      email: 'Amina@Duka.test',
      password: PASSWORD,
      businessName: 'Duka Online',
      phone: '0712 000 111',
      website: 'https://duka.test',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.admin.role, 'merchant');
    assert.equal(res.body.admin.email, 'amina@duka.test');
    assert.equal(res.body.admin.approval.status, 'pending');
    assert.equal(res.body.admin.business.name, 'Duka Online');
    assert.equal(res.body.admin.phone, '254712000111');
    assert.equal(res.body.admin.emailVerified, false);
    assert.equal(res.body.admin.hasPassword, true);
    merchant = res.body;

    // The admins hear about it; the merchant gets a link to confirm the address.
    assert.equal((await mailFor('owner@isa.test')).length, 1);
    assert.match(mailTo('owner@isa.test')[0].subject, /New IsaPay merchant: Amina Hassan \(Duka Online\)/);
    const [check] = await mailFor('amina@duka.test');
    assert.match(check.text, /http:\/\/localhost:5173\/verify-email\?token=/);
    const verified = await api('POST', '/auth/verify-email', null, { token: linkToken(check) });
    assert.equal(verified.status, 200);
    assert.equal((await api('POST', '/auth/verify-email', null, { token: linkToken(check) })).status, 400, 'each link works once');
    assert.equal((await api('GET', '/auth/me', merchant.token)).body.admin.emailVerified, true);

    const again = await api('POST', '/auth/register', null, { name: 'Someone', email: 'amina@duka.test', password: PASSWORD, businessName: 'Copy' });
    assert.equal(again.status, 409);
    assert.ok(await AuditLog.exists({ action: 'account.registered', 'target.label': 'amina@duka.test' }));
  });

  test('a merchant sees only its own things', async () => {
    rival = (await api('POST', '/auth/register', null, { name: 'Rival', email: 'rival@shop.test', password: PASSWORD, businessName: 'Rival Shop' })).body;
    const sale = await Payment.create({ platform: isaPlatform.platform.id, till: isaTill._id, reference: 'staff-order', phone: '254712345678', amount: 50 });

    assert.deepEqual((await api('GET', '/platforms', merchant.token)).body.platforms, []);
    assert.deepEqual((await api('GET', '/tills', merchant.token)).body.tills, []);
    assert.equal((await api('GET', '/payments', merchant.token)).body.total, 0);
    assert.equal((await api('GET', `/payments?platform=${isaPlatform.platform.id}`, merchant.token)).body.total, 0);
    assert.equal((await api('GET', `/payments/${sale.id}`, merchant.token)).status, 404);
    assert.equal((await api('GET', `/platforms/${isaPlatform.platform.id}`, merchant.token)).status, 404);
    assert.equal((await api('POST', `/platforms/${isaPlatform.platform.id}/api-key`, merchant.token)).status, 404);
    assert.equal((await api('GET', '/stats', merchant.token)).body.recent.length, 0);
    assert.equal((await api('GET', '/accounts', merchant.token)).status, 403);
    const tillEdit = await api('PATCH', `/tills/${isaTill.id}`, merchant.token, { password: PASSWORD, name: 'Mine now' });
    assert.equal(tillEdit.status, 404, "a merchant can't touch IsaPay's till");
  });

  test("a merchant's platform on IsaPay's till waits for approval before live payments", async () => {
    const created = await api('POST', '/platforms', merchant.token, {
      name: 'Duka Online',
      slug: 'duka',
      till: 'isapay',
      ownership: 'own', // ignored: a merchant's platform is always a partner's
      webhookUrl: 'https://duka.test/hooks/isapay',
    });
    assert.equal(created.status, 201);
    assert.match(created.body.apiKey, /^isa_sk_/);
    assert.equal(created.body.platform.ownership, 'partner');
    assert.equal(created.body.platform.owner.id, merchant.admin.id);
    assert.equal(created.body.platform.till.payNumber, '5551234');
    assert.equal(created.body.platform.pricing.plan, 'percent');
    assert.equal(created.body.platform.contact.email, 'amina@duka.test');
    merchant.platform = created.body.platform;
    merchant.apiKey = created.body.apiKey;

    // It can be integrated now; live payments wait for IsaPay.
    assert.equal((await request('GET', '/v1/config', { token: merchant.apiKey })).status, 200);
    const early = await request('POST', '/v1/payments', { token: merchant.apiKey, body: { phone: nextPhone(), amount: 100, reference: 'o-1' } });
    assert.equal(early.status, 403);
    assert.match(early.body.error, /still reviewing/);

    // Decisions about the platform stay with IsaPay.
    const id = merchant.platform.id;
    assert.equal((await api('PATCH', `/platforms/${id}`, merchant.token, { status: 'disabled' })).status, 403);
    assert.equal((await api('PATCH', `/platforms/${id}`, merchant.token, { owner: rival.admin.id })).status, 403);
    assert.equal((await api('PUT', `/platforms/${id}/billing`, merchant.token, { plan: 'exempt' })).status, 403);
    const renamed = await api('PATCH', `/platforms/${id}`, merchant.token, { name: 'Duka Online KE' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.platform.name, 'Duka Online KE');

    // Another merchant can't see or touch it.
    assert.equal((await api('GET', `/platforms/${id}`, rival.token)).status, 404);
    assert.equal((await api('PATCH', `/platforms/${id}`, rival.token, { name: 'Mine' })).status, 404);
  });

  test('a merchant can bring its own till; a sandbox till takes payments before approval', async () => {
    const till = await api('POST', '/tills', merchant.token, {
      password: PASSWORD,
      name: 'Duka test till',
      kind: 'paybill',
      environment: 'sandbox',
      owner: 'isa', // ignored: a merchant's till is its own
      shortcode: '174379',
      consumerKey: 'sandbox-ck',
      consumerSecret: 'sandbox-cs',
      passkey: 'sandbox-pk',
    });
    assert.equal(till.status, 201);
    assert.equal(till.body.till.owner, 'partner');
    assert.equal(till.body.till.slot, null, "merchant tills don't take a number from the MPESA_*_N variables");
    assert.equal(till.body.till.account.email, 'amina@duka.test');
    await assignSlots(); // what every server start does
    assert.equal((await Till.findById(till.body.till.id)).slot, undefined, 'and a restart never numbers it');
    assert.deepEqual((await api('GET', '/tills', merchant.token)).body.tills.map((t) => t.name), ['Duka test till']);
    assert.equal((await api('GET', `/tills/${till.body.till.id}`, rival.token)).status, 404);
    assert.equal((await api('POST', '/tills', merchant.token, { password: 'wrong password', name: 'Another till', kind: 'paybill', environment: 'sandbox', shortcode: '174379', consumerKey: 'a', consumerSecret: 'b', passkey: 'c' })).status, 403);

    const sandbox = await api('POST', '/platforms', merchant.token, { name: 'Duka sandbox', slug: 'duka-test', till: till.body.till.id });
    assert.equal(sandbox.status, 201);
    assert.equal(sandbox.body.platform.pricing.plan, 'subscription');
    const paid = await request('POST', '/v1/payments', { token: sandbox.body.apiKey, body: { phone: nextPhone(), amount: 10, reference: 'test-1' } });
    assert.equal(paid.status, 201);

    // A rival can't point a platform at someone else's till.
    const stolen = await api('POST', '/platforms', rival.token, { name: 'Sneaky', slug: 'sneaky', till: till.body.till.id });
    assert.equal(stolen.status, 400);

    // The merchant's payments, and nobody else's.
    const list = await api('GET', '/payments', merchant.token);
    assert.deepEqual(list.body.payments.map((p) => p.reference), ['test-1']);
    const detail = await api('GET', `/payments/${paid.body.payment.id}`, merchant.token);
    assert.equal(detail.body.payment.phone, paid.body.payment.phone, 'merchants see their own customers in full');
    assert.equal((await api('GET', `/payments/${paid.body.payment.id}`, rival.token)).status, 404);
  });

  test('staff review merchants; approval switches on live payments', async () => {
    const waiting = await api('GET', '/accounts?approval=pending', viewerToken);
    assert.equal(waiting.status, 200);
    assert.deepEqual(waiting.body.accounts.map((a) => a.email).sort(), ['amina@duka.test', 'rival@shop.test']);
    assert.equal((await api('GET', '/stats', adminToken)).body.attention.waitingMerchants, 2);

    const detail = await api('GET', `/accounts/${merchant.admin.id}`, viewerToken);
    assert.deepEqual(detail.body.platforms.map((p) => p.slug), ['duka', 'duka-test']);
    assert.equal(detail.body.tills.length, 1);
    assert.equal((await api('POST', `/accounts/${merchant.admin.id}/approve`, viewerToken, {})).status, 403, 'viewers only look');

    // Staff see every platform, with the merchant that runs it.
    const all = await api('GET', '/platforms', viewerToken);
    assert.equal(all.body.platforms.find((p) => p.slug === 'duka').owner.email, 'amina@duka.test');

    const noReason = await api('POST', `/accounts/${rival.admin.id}/reject`, adminToken, {});
    assert.equal(noReason.status, 400);
    const rejected = await api('POST', `/accounts/${rival.admin.id}/reject`, adminToken, { note: 'Send your business registration' });
    assert.equal(rejected.body.account.approval.status, 'rejected');
    assert.match(mailTo('rival@shop.test')[0].text, /Send your business registration/);

    const approved = await api('POST', `/accounts/${merchant.admin.id}/approve`, adminToken, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.account.approval.status, 'approved');
    assert.match(approved.body.account.approval.by, /owner@isa.test/);
    assert.match(mailTo('amina@duka.test')[0].subject, /approved/);
    assert.equal((await api('GET', '/auth/me', merchant.token)).body.admin.approval.status, 'approved');

    const live = await request('POST', '/v1/payments', { token: merchant.apiKey, body: { phone: nextPhone(), amount: 100, reference: 'o-2' } });
    assert.equal(live.status, 201);
    assert.equal(live.body.payment.platform, 'duka');
  });

  test("a merchant's activity log shows its own history, with IsaPay staff kept anonymous", async () => {
    const log = await api('GET', '/audit', merchant.token);
    assert.equal(log.status, 200);
    const actions = log.body.entries.map((e) => e.action);
    assert.ok(actions.includes('platform.created'));
    assert.ok(actions.includes('account.approved'));
    assert.ok(!actions.includes('auth.login') || log.body.entries.every((e) => e.target?.label !== 'owner@isa.test'), "staff sign-ins aren't shown");
    assert.ok(!log.body.entries.some((e) => e.target?.label === 'egertickets'), "other platforms' history isn't shown");
    const approval = log.body.entries.find((e) => e.action === 'account.approved');
    assert.equal(approval.actorLabel, 'IsaPay team');
    assert.equal(approval.ip, undefined);
  });

  test('payout details: changes are logged in full and the merchant is told', async () => {
    const first = await api('PATCH', '/auth/me', merchant.token, { payout: { method: 'mpesa', phone: '0712000111' } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.admin.payout, { method: 'mpesa', phone: '254712000111', bankName: '', accountName: '', accountNumber: '' });
    assert.equal(mailTo('amina@duka.test').length, 0, 'setting it the first time needs no warning');

    const incomplete = await api('PATCH', '/auth/me', merchant.token, { payout: { method: 'bank', bankName: 'KCB' } });
    assert.equal(incomplete.status, 400);
    const bank = await api('PATCH', '/auth/me', merchant.token, { payout: { method: 'bank', bankName: 'KCB', accountName: 'Duka Online Ltd', accountNumber: '1234567890' } });
    assert.equal(bank.status, 200);
    assert.match(mailTo('amina@duka.test')[0].subject, /payout details changed/);
    const entry = await AuditLog.findOne({ action: 'account.payout_changed' }).sort({ createdAt: -1 });
    assert.deepEqual(entry.details['payout.method'], { from: 'mpesa', to: 'bank' });
    assert.deepEqual(entry.details['payout.accountNumber'], { from: '', to: '1234567890' });

    // Staff see where to send a payout owed to the merchant; the merchant sees just the invoice.
    await Invoice.create({ number: 'ISP-TEST-0001', platform: merchant.platform.id, period: '2026-09', kind: 'commission', fee: 15, status: 'paid', payout: 985, payoutStatus: 'pending' });
    const owed = await api('GET', '/invoices?status=payout', adminToken);
    assert.deepEqual(owed.body.invoices[0].payTo, { name: 'Amina Hassan', method: 'bank', phone: null, bankName: 'KCB', accountName: 'Duka Online Ltd', accountNumber: '1234567890' });
    const mine = await api('GET', '/invoices', merchant.token);
    assert.equal(mine.body.invoices.length, 1);
    assert.equal(mine.body.invoices[0].payTo, undefined);
    assert.equal((await api('GET', '/invoices', rival.token)).body.invoices.length, 0);
    assert.equal((await api('POST', `/invoices/${mine.body.invoices[0].id}/payout`, merchant.token, { reference: 'MINE' })).status, 403, 'only IsaPay records payouts');
  });

  test('forgotten password: a one-time link by email', async () => {
    const unknown = await api('POST', '/auth/forgot-password', null, { email: 'nobody@nowhere.test' });
    assert.equal(unknown.status, 200, 'same answer whether or not the account exists');
    assert.equal(outbox.length, 0);

    assert.equal((await api('POST', '/auth/forgot-password', null, { email: 'amina@duka.test' })).status, 200);
    const token = linkToken(mailTo('amina@duka.test')[0]);
    assert.ok(token);
    const reset = await api('POST', '/auth/reset-password', null, { token, password: 'a brand new passphrase' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.admin.email, 'amina@duka.test');
    assert.equal((await api('POST', '/auth/reset-password', null, { token, password: 'yet another passphrase' })).status, 400, 'each link works once');
    assert.equal((await api('GET', '/auth/me', merchant.token)).status, 401, 'old sessions are signed out');
    assert.equal(await signIn('amina@duka.test'), undefined, 'the old password is gone');
    merchant.token = await signIn('amina@duka.test', 'a brand new passphrase');
    assert.ok(merchant.token);
  });

  test('contact support sends a validated message through the configured mail transport', async () => {
    const invalid = await api('POST', '/auth/contact', null, { name: 'A', email: 'bad', subject: 'Help', message: 'Short' });
    assert.equal(invalid.status, 400);

    const sent = await api('POST', '/auth/contact', null, {
      name: 'Amina Hassan',
      email: 'amina@duka.test',
      subject: 'Checkout help',
      message: 'A customer needs help completing an M-Pesa checkout.',
    });
    assert.equal(sent.status, 202);
    const [mail] = mailTo('support@isapay.co.ke');
    assert.equal(mail.replyTo, 'amina@duka.test');
    assert.match(mail.subject, /Checkout help/);
    assert.match(mail.text, /Amina Hassan/);
    assert.match(mail.html, /New support request/);
    assert.match(mail.html, /A customer needs help completing an M-Pesa checkout/);
  });

  test('a hosted payment link creates one-time STK requests and closes after successful payment', async () => {
    const created = await api('POST', '/payment-links', adminToken, {
      platform: isaPlatform.platform.id,
      title: 'Ticket order',
      amountType: 'fixed',
      amount: 250,
      usage: 'single-use',
      collectName: true,
      collectEmail: true,
    });
    assert.equal(created.status, 201);
    const link = created.body.paymentLink;
    assert.equal(link.amount, 250);
    assert.match(link.url, new RegExp(`/pay/${link.slug}$`));

    const edited = await api('PATCH', `/payment-links/${link.id}`, adminToken, { title: 'Ticket order updated', amount: 300 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.paymentLink.title, 'Ticket order updated');
    assert.equal(edited.body.paymentLink.amount, 300);

    const checkout = await request('GET', `/api/checkout/${link.slug}`);
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.paymentLink.title, 'Ticket order updated');
    assert.equal(checkout.body.paymentLink.collectReference, undefined);

    const requestId = crypto.randomUUID();
    const body = {
      phone: nextPhone(),
      amount: 300,
      name: 'Amina Hassan',
      email: 'payer@duka.test',
      requestId,
    };
    const started = await request('POST', `/api/checkout/${link.slug}/pay`, { body });
    assert.equal(started.status, 201);
    const replay = await request('POST', `/api/checkout/${link.slug}/pay`, { body });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);

    const payment = await Payment.findById(started.body.payment.id);
    assert.match(payment.reference, /^link-/);
    await markPaid(payment, { paidAmount: 300, source: 'sweep' });
    assert.equal(mailTo('payer@duka.test').length, 0, 'wait to email until the M-Pesa receipt is available');
    await markPaid(payment, { receipt: 'LINK123456', paidAmount: 300, source: 'callback' });
    const status = await request('GET', `/api/checkout/${link.slug}/payments/${payment.id}`);
    assert.equal(status.body.payment.mpesaReceipt, 'LINK123456');
    assert.equal((await PaymentLink.findById(link.id)).status, 'paid');
    assert.equal((await request('GET', `/api/checkout/${link.slug}`)).status, 404);
    const renamedPaidLink = await api('PATCH', `/payment-links/${link.id}`, adminToken, { title: 'Paid ticket link renamed' });
    assert.equal(renamedPaidLink.status, 200);
    assert.equal(renamedPaidLink.body.paymentLink.title, 'Paid ticket link renamed');
    const lockedPaidLink = await api('PATCH', `/payment-links/${link.id}`, adminToken, { amount: 400 });
    assert.equal(lockedPaidLink.status, 409);
    assert.equal((await api('DELETE', `/payment-links/${link.id}`, adminToken)).status, 204);
    const remainingLinks = await api('GET', '/payment-links', adminToken);
    assert.ok(!remainingLinks.body.paymentLinks.some((item) => item.id === link.id));
    assert.equal(mailTo('payer@duka.test').length, 1, 'send one complete receipt email after receipt arrives');
    const receiptEmail = mailTo('payer@duka.test')[0];
    assert.match(receiptEmail.subject, /Payment received/);
    assert.match(receiptEmail.text, /M-Pesa confirmation code \(receipt\): LINK123456/);
    assert.match(receiptEmail.html, /M-Pesa confirmation code \(receipt\)/);
    assert.match(receiptEmail.html, /LINK123456/);
  });

  test('Google: a new person gets a merchant account, then signs straight in', async () => {
    const credential = googleToken({ sub: 'g-100', email: 'Wanjiku.Shop@gmail.com', name: 'Wanjiku', picture: 'https://lh3.googleusercontent.com/a/w' });
    const created = await api('POST', '/auth/google', null, { credential });
    assert.equal(created.status, 201);
    assert.equal(created.body.admin.role, 'merchant');
    assert.equal(created.body.admin.email, 'wanjiku.shop@gmail.com');
    assert.equal(created.body.admin.emailVerified, true);
    assert.equal(created.body.admin.hasPassword, false);
    assert.equal(created.body.admin.googleLinked, true);
    assert.equal(created.body.admin.approval.status, 'pending');
    assert.equal((await mailFor('owner@isa.test')).length, 1, 'the admins hear about it');

    const again = await api('POST', '/auth/google', null, { credential });
    assert.equal(again.status, 200);
    assert.equal(again.body.admin.id, created.body.admin.id);

    // No password yet: password sign-in fails, and till changes ask for one first.
    assert.equal(await signIn('wanjiku.shop@gmail.com', 'anything at all'), undefined);
    const till = await api('POST', '/tills', again.body.token, { password: 'x', name: 'Wanjiku till', kind: 'paybill', environment: 'sandbox', shortcode: '174379', consumerKey: 'a', consumerSecret: 'b', passkey: 'c' });
    assert.equal(till.status, 403);
    assert.match(till.body.error, /Set a password/);
    const unlink = await api('DELETE', '/auth/google', again.body.token);
    assert.equal(unlink.status, 400, "can't remove the only way to sign in");

    // Setting a first password needs no current one.
    const set = await api('POST', '/auth/password', again.body.token, { newPassword: 'my first passphrase' });
    assert.equal(set.status, 200);
    assert.equal(set.body.admin.hasPassword, true);
    assert.ok(await signIn('wanjiku.shop@gmail.com', 'my first passphrase'));
  });

  test('Google: existing accounts are linked only when Google is the authority for the address', async () => {
    // owner@isa.test isn't a Gmail or Workspace address: someone could have made a Google account with it.
    const risky = await api('POST', '/auth/google', null, { credential: googleToken({ sub: 'g-200', email: 'owner@isa.test' }) });
    assert.equal(risky.status, 409);
    assert.match(risky.body.error, /Sign in with your password first/);

    // From a Google Workspace on that domain (hd), it links and signs in.
    const workspace = await api('POST', '/auth/google', null, { credential: googleToken({ sub: 'g-200', email: 'owner@isa.test', hd: 'isa.test' }) });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.admin.role, 'admin');
    assert.equal(workspace.body.admin.googleLinked, true);
    assert.ok(await AuditLog.exists({ action: 'auth.login', 'details.linked': true }));

    // A different Google account with the same address can't take it over.
    const other = await api('POST', '/auth/google', null, { credential: googleToken({ sub: 'g-201', email: 'owner@isa.test', hd: 'isa.test' }) });
    assert.equal(other.status, 409);

    // Signed in, anyone can link a Google account themselves.
    const linked = await api('POST', '/auth/google/link', viewerToken, { credential: googleToken({ sub: 'g-300', email: 'viewer.personal@gmail.com' }) });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.admin.googleLinked, true);
    const taken = await api('POST', '/auth/google/link', viewerToken, { credential: googleToken({ sub: 'g-100', email: 'wanjiku.shop@gmail.com' }) });
    assert.equal(taken.status, 409);
    const viaGoogle = await api('POST', '/auth/google', null, { credential: googleToken({ sub: 'g-300', email: 'viewer.personal@gmail.com' }) });
    assert.equal(viaGoogle.body.admin.email, 'viewer@isa.test');

    const forged = await api('POST', '/auth/google', null, { credential: jwt.sign({ sub: 'g-1', email: 'x@gmail.com', email_verified: true }, 'secret', { keyid: 'test-key' }) });
    assert.equal(forged.status, 401);
  });

  test('admins manage the team; nobody locks everybody out', async () => {
    const created = await api('POST', '/accounts', adminToken, { name: 'Kevin', email: 'kevin@isa.test', role: 'viewer' });
    assert.equal(created.status, 201);
    assert.ok(created.body.password.length >= 15);
    const kevin = await signIn('kevin@isa.test', created.body.password);
    assert.ok(kevin);
    assert.equal((await api('POST', '/accounts', viewerToken, { name: 'X', email: 'x@isa.test', role: 'admin' })).status, 403);

    const promoted = await api('PATCH', `/accounts/${created.body.account.id}`, adminToken, { role: 'admin' });
    assert.equal(promoted.body.account.role, 'admin');
    assert.equal((await api('GET', '/auth/me', kevin)).status, 401, 'a role change takes effect at once');

    const reset = await api('POST', `/accounts/${created.body.account.id}/reset-password`, adminToken);
    const kevinAgain = await signIn('kevin@isa.test', reset.body.password);
    assert.ok(kevinAgain);

    const owner = (await api('GET', '/auth/me', adminToken)).body.admin;
    assert.equal((await api('PATCH', `/accounts/${owner.id}`, adminToken, { active: false })).status, 400, "can't deactivate yourself");
    assert.equal((await api('PATCH', `/accounts/${merchant.admin.id}`, adminToken, { role: 'admin' })).status, 400, "a merchant can't become staff");

    // Admins can change each other, never themselves.
    assert.equal((await api('PATCH', `/accounts/${owner.id}`, kevinAgain, { role: 'viewer' })).status, 200);
    assert.equal((await api('PATCH', `/accounts/${owner.id}`, kevinAgain, { role: 'admin' })).status, 200);
    assert.equal((await api('PATCH', `/accounts/${created.body.account.id}`, kevinAgain, { active: false })).status, 400);
    adminToken = await signIn('owner@isa.test');
    const off = await api('PATCH', `/accounts/${created.body.account.id}`, adminToken, { active: false });
    assert.equal(off.body.account.active, false);
    assert.equal((await api('GET', '/auth/me', kevinAgain)).status, 401);
    assert.equal(await signIn('kevin@isa.test', reset.body.password), undefined);
  });

  test('a deactivated merchant is signed out and its platforms stop', async () => {
    const off = await api('PATCH', `/accounts/${merchant.admin.id}`, adminToken, { active: false });
    assert.equal(off.status, 200);
    assert.equal((await api('GET', '/auth/me', merchant.token)).status, 401);
    assert.equal(await signIn('amina@duka.test', 'a brand new passphrase'), undefined);
    const api403 = await request('GET', '/v1/config', { token: merchant.apiKey });
    assert.equal(api403.status, 403);
    assert.match(api403.body.error, /deactivated/);
  });

  test('sign-up can be closed', async () => {
    env.signup = false;
    try {
      assert.equal((await api('GET', '/auth/config')).body.signup, false);
      const res = await api('POST', '/auth/register', null, { name: 'Late', email: 'late@shop.test', password: PASSWORD, businessName: 'Late Shop' });
      assert.equal(res.status, 403);
      const viaGoogle = await api('POST', '/auth/google', null, { credential: googleToken({ sub: 'g-900', email: 'late.shop@gmail.com' }) });
      assert.equal(viaGoogle.status, 403);
    } finally {
      env.signup = true;
    }
  });
});
