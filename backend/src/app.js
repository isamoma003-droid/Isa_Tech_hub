import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import adminRoutes from './routes/admin.js';
import mpesaRoutes from './routes/mpesa.js';
import v1Routes from './routes/v1.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '100kb' }));
  if (env.nodeEnv !== 'test') app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

  app.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true }));
  // Safaricom → Hub. No auth, no rate limit: a throttled callback looks like a payment that never happened.
  app.use('/mpesa', mpesaRoutes);
  // Platforms → Hub (server-to-server, API key).
  app.use('/v1', v1Routes);
  // Dashboard → Hub.
  app.use('/api/admin', cors({ origin: env.clientOrigins }), adminRoutes);
  app.use(['/api', '/v1', '/mpesa'], notFoundHandler);

  // Optionally serve the built dashboard from the same server (SERVE_CLIENT=true). Otherwise the
  // bare address answers with a short note, so opening it in a browser (or Render probing it)
  // doesn't look like an error.
  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  if (process.env.SERVE_CLIENT === 'true' && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.json({ service: 'ISA Tech Hub API', status: 'ok', health: '/health' }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
