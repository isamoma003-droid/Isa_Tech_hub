// Lets a fresh deployment be set up entirely from the host's environment variables (the Render
// dashboard), with no shell: the first dashboard account, and the till with its Daraja
// credentials. Both still live only on the server side: the dashboard can't create or change them.
import { AdminUser } from '../models/AdminUser.js';
import { AuditLog } from '../models/AuditLog.js';
import { Till } from '../models/Till.js';
import { audit } from './audit.js';

const BY = 'server start-up (environment variables)';

/**
 * Creates the first admin from BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, once. After the
 * account exists the variables are ignored, so changing the password in the dashboard sticks.
 */
export async function bootstrapAdmin(vars = process.env) {
  const email = vars.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = vars.BOOTSTRAP_ADMIN_PASSWORD || '';
  if (!email || !password) return null;
  if (await AdminUser.exists({ email })) return null;
  if (password.length < 10) {
    console.warn('BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters: no dashboard account was created');
    return null;
  }
  const admin = new AdminUser({ email, name: vars.BOOTSTRAP_ADMIN_NAME?.trim() || email.split('@')[0], role: 'admin' });
  await admin.setPassword(password);
  await admin.save();
  await audit(BY, 'admin.created', { type: 'admin', id: admin.id, label: admin.email }, { role: 'admin' });
  console.log(`Created dashboard admin ${email}. Sign in, change the password under Account, then delete BOOTSTRAP_ADMIN_PASSWORD.`);
  return admin;
}

/**
 * Creates the till described by the MPESA_* variables, or brings it up to date.
 * The same variable names as A-Read: MPESA_SHORTCODE is the store / head office number that signs
 * requests, MPESA_TILL_NUMBER the Buy Goods till customers pay (leave it empty for a Paybill).
 *
 * The variables always describe one till, the one marked `source: 'env'`. Correcting a number
 * on the host corrects that till in place (same id, same callback secret), so every platform
 * pointing at it follows along instead of being left on a till with the old numbers.
 * @returns {Promise<{ till, action: 'created'|'updated'|'unchanged', changed?: string[] } | null>}
 */
export async function syncTillFromEnv(vars = process.env) {
  const shortcode = vars.MPESA_SHORTCODE?.trim();
  const creds = { consumerKey: vars.MPESA_CONSUMER_KEY, consumerSecret: vars.MPESA_CONSUMER_SECRET, passkey: vars.MPESA_PASSKEY };
  if (!shortcode || !creds.consumerKey || !creds.consumerSecret || !creds.passkey) return null;

  const wanted = {
    environment: vars.MPESA_ENV === 'production' ? 'production' : 'sandbox',
    shortcode,
    tillNumber: vars.MPESA_TILL_NUMBER?.trim() || undefined,
  };
  wanted.kind = wanted.tillNumber ? 'till' : 'paybill';
  const name = vars.MPESA_TILL_NAME?.trim();

  const till = await findEnvTill();
  if (!till) {
    const created = new Till({ ...wanted, name: name || (wanted.kind === 'till' ? 'ISA main till' : 'ISA Paybill'), source: 'env' });
    created.setCredentials(creds);
    await created.save();
    await audit(BY, 'till.created', { type: 'till', id: created.id, label: created.name }, { kind: wanted.kind, environment: wanted.environment, payNumber: created.payNumber });
    console.log(`Added ${wanted.environment} ${wanted.kind} "${created.name}" (customers pay ${created.payNumber}) from MPESA_* variables`);
    return { till: created, action: 'created' };
  }

  const details = {};
  for (const [key, value] of Object.entries({ ...wanted, ...(name ? { name } : {}) })) {
    if ((till[key] ?? undefined) !== value) details[key] = { from: till[key] ?? null, to: value ?? null };
  }
  let current;
  try {
    current = till.credentials();
  } catch {
    current = {}; // stored with a different HUB_SECRET_KEY: replace with the values from the environment
  }
  const changedCredentials = Object.keys(creds).filter((key) => current[key] !== creds[key]);
  const changed = [...Object.keys(details), ...changedCredentials];
  if (!changed.length && till.source === 'env') return { till, action: 'unchanged', changed };

  till.set({ ...wanted, ...(name ? { name } : {}), source: 'env' });
  if (!wanted.tillNumber) till.tillNumber = undefined;
  till.setCredentials(Object.fromEntries(changedCredentials.map((key) => [key, creds[key]])));
  await till.save();
  if (changed.length) {
    // Numbers are logged from → to; credentials only by name.
    await audit(BY, Object.keys(details).length ? 'till.updated' : 'till.credentials_changed', { type: 'till', id: till.id, label: till.name }, {
      ...details,
      ...(changedCredentials.length ? { credentials: changedCredentials } : {}),
    });
    console.log(`Updated till "${till.name}" from MPESA_* variables: ${changed.join(', ')} (customers pay ${till.payNumber})`);
  }
  return { till, action: changed.length ? 'updated' : 'unchanged', changed };
}

const SECRETS = '+consumerKey +consumerSecret +passkey';

// The till the MPESA_* variables manage. Tills created from the variables before `source` existed
// are recognised from the audit log, so they're corrected rather than duplicated.
async function findEnvTill() {
  const marked = await Till.findOne({ source: 'env' }).select(SECRETS);
  if (marked) return marked;
  const created = await AuditLog.find({ action: 'till.created', actorLabel: BY }).sort({ createdAt: -1 }).limit(5);
  for (const entry of created) {
    const till = entry.target?.id && (await Till.findById(entry.target.id).select(SECRETS));
    if (till) return till;
  }
  return null;
}
