// Safaricom posts STK results here. Public by necessity (Safaricom sends no credentials), so
// the URL carries each till's secret, and success is re-checked with Safaricom before it counts.
import { Router } from 'express';
import mongoose from 'mongoose';
import { parseCallback } from '../services/daraja.js';
import { handleCallback, loadTill } from '../services/payments.js';
import { safeEqual } from '../utils/crypto.js';
import { notFound } from '../utils/httpError.js';

const router = Router();

// Callbacks still being processed after their 200 was sent (tests wait on these).
const inflight = new Set();
export const callbacksIdle = () => Promise.all([...inflight]);

router.post('/callback/:tillId/:secret', async (req, res) => {
  const { tillId, secret } = req.params;
  if (!mongoose.isValidObjectId(tillId)) throw notFound();
  const till = await loadTill(tillId);
  if (!till || !safeEqual(till.callbackSecret, secret)) throw notFound();

  // Acknowledge first: Daraja gives the endpoint a few seconds and retries anything slower.
  // Even a body we can't use is acknowledged, since a redelivery would fail the same way.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  const result = parseCallback(req.body);
  if (!result) {
    console.warn(`Unreadable M-Pesa callback on till ${till.id}: ${JSON.stringify(req.body).slice(0, 500)}`);
    return;
  }
  const job = handleCallback(till, result)
    .catch((err) => console.error(`M-Pesa callback ${result.checkoutRequestId} failed (the sweep will retry):`, err))
    .finally(() => inflight.delete(job));
  inflight.add(job);
});

export default router;
