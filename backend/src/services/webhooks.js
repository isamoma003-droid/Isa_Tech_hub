// Tells platforms what happened to their payments: signed POSTs to each platform's webhook URL,
// retried with growing gaps until the platform answers 2xx.
import { env } from '../config/env.js';
import { Platform } from '../models/Platform.js';
import { WebhookDelivery } from '../models/WebhookDelivery.js';
import { randomToken, signWebhook } from '../utils/crypto.js';

// Wait before attempt 2, 3, … (about two days in total), then give up and show it in the dashboard.
export const RETRY_DELAYS_MS = [1, 5, 15, 60, 180, 360, 720, 1440].map((minutes) => minutes * 60_000);
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const TIMEOUT_MS = 10_000;

export const EVENT_FOR_STATUS = { paid: 'payment.paid', failed: 'payment.failed', disputed: 'payment.disputed' };

function kick() {
  // In production, deliver right away instead of waiting for the next worker tick.
  if (env.workers) setImmediate(() => deliverDueWebhooks().catch((err) => console.error('Webhook delivery failed:', err)));
}

// Queues `type` for the payment's platform. Returns the delivery, or null if the platform has no URL.
export async function enqueuePaymentEvent(payment, type) {
  const platform = await Platform.findById(payment.platform);
  if (!platform?.webhookUrl) return null;
  const delivery = new WebhookDelivery({ platform: platform._id, payment: payment._id, event: type, url: platform.webhookUrl });
  delivery.body = JSON.stringify({
    id: `evt_${delivery.id}`,
    type,
    createdAt: new Date().toISOString(),
    data: { payment: payment.toPlatform(platform.slug) },
  });
  await delivery.save();
  kick();
  return delivery;
}

async function post(url, { event, deliveryId, body, secret }) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'ISA-Tech-Hub-Webhooks/1.0',
        'isa-event': event,
        'isa-delivery': deliveryId,
        'isa-signature': signWebhook(secret, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}`, ms: Date.now() - started };
  } catch (err) {
    const error = err.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} s` : err.cause?.code || err.message;
    return { ok: false, status: null, error, ms: Date.now() - started };
  }
}

async function attempt(delivery) {
  const platform = await Platform.findById(delivery.platform).select('+webhookSecret');
  const secret = platform?.webhookSecret ? platform.signingSecret() : '';
  const result = secret
    ? await post(delivery.url, { event: delivery.event, deliveryId: delivery.id, body: delivery.body, secret })
    : { ok: false, status: null, error: platform ? 'The platform has no webhook signing secret' : 'The platform no longer exists', ms: 0 };

  const attempts = delivery.attempts + 1;
  const set = { attempts, lastStatus: result.status, lastError: result.error };
  if (result.ok) {
    set.status = 'delivered';
    set.deliveredAt = new Date();
  } else if (attempts >= MAX_ATTEMPTS || !secret) {
    set.status = 'failed';
  } else {
    set.nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]);
  }
  await WebhookDelivery.updateOne(
    { _id: delivery._id },
    {
      $set: set,
      $unset: { lockedUntil: 1 },
      $push: { history: { $each: [{ at: new Date(), status: result.status, error: result.error, ms: result.ms }], $slice: -20 } },
    },
  );
  return result;
}

let delivering = false;

// Sends every delivery that is due. Each one is claimed first, so two servers never send it twice.
export async function deliverDueWebhooks({ limit = 50 } = {}) {
  if (delivering) return 0;
  delivering = true;
  let sent = 0;
  try {
    while (sent < limit) {
      const now = new Date();
      const delivery = await WebhookDelivery.findOneAndUpdate(
        { status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + 60_000) } },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      );
      if (!delivery) break;
      await attempt(delivery);
      sent += 1;
    }
  } finally {
    delivering = false;
  }
  return sent;
}

// Sends a fresh copy of the event that matches the payment's current status.
export async function resendPaymentWebhook(payment) {
  const type = EVENT_FOR_STATUS[payment.status];
  if (!type) return null;
  return enqueuePaymentEvent(payment, type);
}

// A one-off signed `ping`, sent right away, so a platform can check its endpoint while onboarding.
export async function sendTestWebhook(platform) {
  if (!platform.webhookUrl) return { ok: false, status: null, error: 'Set a webhook URL first', ms: 0 };
  const deliveryId = `test_${randomToken(9)}`;
  const body = JSON.stringify({
    id: `evt_${deliveryId}`,
    type: 'ping',
    createdAt: new Date().toISOString(),
    data: { platform: platform.slug, message: 'Test event from ISA Tech Hub' },
  });
  return post(platform.webhookUrl, { event: 'ping', deliveryId, body, secret: platform.signingSecret() });
}
