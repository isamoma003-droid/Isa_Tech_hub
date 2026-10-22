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

  const result = parseCallback(req.body);
  if (!result) {
    console.warn(JSON.stringify({
      service: 'isapay',
      event: 'payment.callback_unreadable',
      tillId: till.id,
      bodyType: typeof req.body,
      bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body).slice(0, 20) : [],
    }));
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    return;
  }
  // Persist the callback before acknowledging, then do the slower Safaricom status check.
  const job = handleCallback(till, result, () => {
    if (!res.headersSent) res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  })
    .catch((err) => {
      console.error(`M-Pesa callback ${result.checkoutRequestId} failed:`, err);
      if (!res.headersSent) res.status(503).json({ ResultCode: 1, ResultDesc: 'Temporary processing failure' });
    })
    .finally(() => inflight.delete(job));
  inflight.add(job);
});

export default router;
