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
const mailProvider = process.env.MAIL_PROVIDER || 'auto';
if (!['auto', 'brevo', 'smtp'].includes(mailProvider)) throw new Error('Environment variable MAIL_PROVIDER must be auto, brevo or smtp');
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${number('PORT', 5100)}`).replace(/\/$/, '');
const clientOrigins = list('CLIENT_ORIGIN').length ? list('CLIENT_ORIGIN') : ['http://localhost:5173'];

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
  publicUrl,
  // Dashboard origins allowed to call /api/admin (not needed when SERVE_CLIENT=true).
  clientOrigins,
  // The dashboard's address, for links in emails (password reset, email check). Defaults to the
  // first CLIENT_ORIGIN, or this server when it serves the dashboard itself.
  appUrl: (process.env.APP_URL || (process.env.SERVE_CLIENT === 'true' ? publicUrl : clientOrigins[0])).replace(/\/$/, ''),
  // Anyone can open a merchant account from the sign-in page (SIGNUP=false closes it). New
  // merchants can set everything up and test on a sandbox till; live payments start once an
  // IsaPay admin approves the business.
  signup: process.env.SIGNUP !== 'false',
  // "Sign in with Google": the OAuth client ID(s) from Google Cloud Console, comma-separated.
  googleClientIds: list('GOOGLE_CLIENT_ID'),
  // Outgoing email (password resets, email checks, approvals), e.g.
  // smtps://you%40gmail.com:app-password@smtp.gmail.com:465. Without it, nothing is emailed:
  // admins reset passwords from the Accounts page instead.
  mailProvider,
  brevoApiKey: process.env.BREVO_API_KEY || '',
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || '',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@isapay.co.ke',
  supportPhone: process.env.SUPPORT_PHONE || '+254 700 000 000',
  minAmount: number('MIN_AMOUNT', 1),
  maxAmount: number('MAX_AMOUNT', 150_000),
  // Background work: asking Safaricom about payments whose callback never came, and
  // delivering webhooks to platforms. Turn off only for tests or a second, API-only instance.
  workers: process.env.WORKERS !== 'false' && !isTest,
  sweepEveryMs: number('SWEEP_EVERY_MS', 30_000),
  webhookEveryMs: number('WEBHOOK_EVERY_MS', 10_000),
  // Render's free plan puts a service to sleep after 15 minutes without incoming requests, and a
  // sleeping Hub misses Safaricom's callbacks. Until the service is on a paid (always-on) plan, it
  // pings its own public address so it never looks idle. On by default on Render; KEEP_ALIVE=false
  // turns it off (do that once you're on the Starter plan), KEEP_ALIVE=true turns it on elsewhere.
  keepAlive: process.env.KEEP_ALIVE ? process.env.KEEP_ALIVE === 'true' : Boolean(process.env.RENDER_EXTERNAL_URL) && !isTest,
  keepAliveEveryMs: number('KEEP_ALIVE_EVERY_MINUTES', 10) * 60_000,
  // What IsaPay charges, unless a platform has its own price (Platforms → Billing). Platforms on a
  // till of yours pay a percentage of what they receive; partners on their own till pay a monthly
  // subscription. The first BILLING_FREE_AMOUNT shillings of payments each month are free.
  billing: {
    percent: number('BILLING_PERCENT', 1.5),
    monthlyFee: number('BILLING_MONTHLY_FEE', 1000),
    freeAmount: number('BILLING_FREE_AMOUNT', 10_000),
    // A subscription invoice is due this many days after the month ends; the platform can't start
    // new payments once it's this many days overdue (an admin can extend that per platform).
    dueDays: number('BILLING_DUE_DAYS', 7),
    graceDays: number('BILLING_GRACE_DAYS', 14),
    // The first month that is invoiced (YYYY-MM). By default, the month this version first ran,
    // so nobody is billed for months before billing existed.
    startMonth: process.env.BILLING_START_MONTH || null,
  },
};
