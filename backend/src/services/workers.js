import { env } from '../config/env.js';
import { sweepPendingPayments } from './payments.js';
import { deliverDueWebhooks } from './webhooks.js';

// Runs inside the API process. Safe with several servers: every payment transition and every
// webhook delivery is claimed with a conditional update, so duplicates cost a little extra work only.
export function startWorkers() {
  const every = (ms, label, fn) =>
    setInterval(() => {
      fn().catch((err) => console.error(`${label} failed:`, err));
    }, ms);

  const timers = [
    every(env.sweepEveryMs, 'Payment sweep', async () => {
      const summary = await sweepPendingPayments();
      if (summary.scanned) console.log('Payment sweep:', summary);
    }),
    every(env.webhookEveryMs, 'Webhook delivery', () => deliverDueWebhooks()),
  ];
  console.log(`Background work on: payment sweep every ${env.sweepEveryMs / 1000}s, webhooks every ${env.webhookEveryMs / 1000}s`);
  return () => timers.forEach(clearInterval);
}
