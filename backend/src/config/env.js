// Loads backend/.env (if present) and exposes typed, validated settings.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see backend/.env.example)`);
  return value;
}

function number(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: number('PORT', 5100),
  mongoUri: isTest ? process.env.MONGODB_URI : required('MONGODB_URI'),
  jwtSecret: isTest ? 'test-jwt-secret' : required('JWT_SECRET'),
  // Dashboard sessions are short on purpose: this is where the till is run from.
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  // Encrypts till credentials and webhook secrets at rest. Changing it makes them unreadable,
  // so keep it safe and never rotate it without re-entering the till credentials.
  secretKey: isTest ? 'test-secret-key' : required('HUB_SECRET_KEY'),
  // Public HTTPS address of this API. Safaricom posts payment results to
  // <PUBLIC_URL>/mpesa/callback/<till id>/<till secret>. On Render it defaults to the service's
  // own address (RENDER_EXTERNAL_URL); set PUBLIC_URL when you add a custom domain.
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${number('PORT', 5100)}`).replace(/\/$/, ''),
  // Dashboard origins allowed to call /api/admin (not needed when SERVE_CLIENT=true).
  clientOrigins: list('CLIENT_ORIGIN').length ? list('CLIENT_ORIGIN') : ['http://localhost:5173'],
  minAmount: number('MIN_AMOUNT', 1),
  maxAmount: number('MAX_AMOUNT', 150_000),
  // Background work: asking Safaricom about payments whose callback never came, and
  // delivering webhooks to platforms. Turn off only for tests or a second, API-only instance.
  workers: process.env.WORKERS !== 'false' && !isTest,
  sweepEveryMs: number('SWEEP_EVERY_MS', 30_000),
  webhookEveryMs: number('WEBHOOK_EVERY_MS', 10_000),
};
