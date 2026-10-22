import { env } from '../config/env.js';
import { closeMonth } from './billing.js';
import { deliverReceiptEmails, sweepPendingPayments } from './payments.js';
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
    every(30_000, 'Payment receipt emails', async () => {
      const summary = await deliverReceiptEmails();
      if (summary.scanned) console.log('Payment receipt emails:', summary);
    }),
    every(env.webhookEveryMs, 'Webhook delivery', () => deliverDueWebhooks()),
    // Last month's invoices, written once each; checking hourly catches the turn of the month.
    every(3600_000, 'Monthly invoices', invoiceLastMonth),
  ];
  invoiceLastMonth().catch((err) => console.error('Monthly invoices failed:', err));
  console.log(`Background work on: payment sweep every ${env.sweepEveryMs / 1000}s, webhooks every ${env.webhookEveryMs / 1000}s`);
  return () => timers.forEach(clearInterval);
}

async function invoiceLastMonth() {
  const invoices = await closeMonth();
  const fresh = invoices.filter((invoice) => Date.now() - invoice.createdAt.getTime() < 60_000);
  if (fresh.length) console.log(`Invoiced ${fresh.length} platform${fresh.length === 1 ? '' : 's'} for ${fresh[0].period}`);
}
