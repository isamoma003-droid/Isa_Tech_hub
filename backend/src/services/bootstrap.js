// Lets a fresh deployment be set up entirely from the host's environment variables (the Render
// dashboard), with no shell: the first dashboard account, and the till with its Daraja
// credentials. Admins can correct the till in the dashboard afterwards.
import { AdminUser } from '../models/AdminUser.js';
import { AuditLog } from '../models/AuditLog.js';
import { Till } from '../models/Till.js';
import { fingerprint } from '../utils/crypto.js';
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
 * Creates the till described by the MPESA_* variables, or applies the variables that changed.
 * The same variable names as A-Read: MPESA_SHORTCODE is the store / head office number that signs
 * requests, MPESA_TILL_NUMBER the Buy Goods till customers pay (leave it empty for a Paybill).
 *
 * The variables manage one till, marked `source: 'env'`. Each start-up applies only the variables
 * whose value differs from what was applied last time, so for every field the latest change wins:
 * correcting MPESA_TILL_NUMBER on the host corrects the till, and a correction made in the
 * dashboard isn't undone by a restart. The till keeps its id and callback secret either way.
 * @returns {Promise<{ till, action: 'created'|'updated'|'unchanged', changed?: string[] } | null>}
 */
export async function syncTillFromEnv(vars = process.env) {
  const shortcode = vars.MPESA_SHORTCODE?.trim();
  const creds = { consumerKey: vars.MPESA_CONSUMER_KEY, consumerSecret: vars.MPESA_CONSUMER_SECRET, passkey: vars.MPESA_PASSKEY };
  if (!shortcode || !creds.consumerKey || !creds.consumerSecret || !creds.passkey) return null;

  const tillNumber = vars.MPESA_TILL_NUMBER?.trim() || null;
  const name = vars.MPESA_TILL_NAME?.trim() || null;
  const environment = vars.MPESA_ENV === 'production' ? 'production' : 'sandbox';
  // What the variables say now. Secrets are compared by fingerprint, never stored in the clear.
  const applied = {
    environment,
    shortcode,
    tillNumber,
    name,
    consumerKey: fingerprint(creds.consumerKey),
    consumerSecret: fingerprint(creds.consumerSecret),
    passkey: fingerprint(creds.passkey),
  };

  const till = await findEnvTill();
  if (!till) {
    const kind = tillNumber ? 'till' : 'paybill';
    const created = new Till({
      name: name || (kind === 'till' ? 'ISA main till' : 'ISA Paybill'),
      kind,
      environment,
      shortcode,
      tillNumber: tillNumber || undefined,
      source: 'env',
      envApplied: applied,
    });
    created.setCredentials(creds);
    await created.save();
    await audit(BY, 'till.created', { type: 'till', id: created.id, label: created.name }, { kind, environment, payNumber: created.payNumber });
    console.log(`Added ${environment} ${kind} "${created.name}" (customers pay ${created.payNumber}) from MPESA_* variables`);
    return { till: created, action: 'created' };
  }

  // A till from before envApplied existed counts as "every variable changed".
  const last = till.envApplied || {};
  const moved = Object.keys(applied).filter((key) => last[key] !== applied[key] && !(key === 'name' && !applied.name));

  const details = {};
  for (const key of ['environment', 'shortcode', 'tillNumber', 'name']) {
    if (!moved.includes(key)) continue;
    const value = key === 'tillNumber' ? applied.tillNumber || undefined : applied[key];
    if ((till[key] ?? undefined) !== value) details[key] = { from: till[key] ?? null, to: value ?? null };
    till[key] = value;
  }
  if (moved.includes('tillNumber')) {
    const kind = applied.tillNumber ? 'till' : 'paybill';
    if (till.kind !== kind) details.kind = { from: till.kind, to: kind };
    till.kind = kind;
  }

  let current;
  try {
    current = till.credentials();
  } catch {
    current = {}; // stored with a different HUB_SECRET_KEY: take the values from the environment
  }
  const changedCredentials = ['consumerKey', 'consumerSecret', 'passkey'].filter((key) => moved.includes(key) && current[key] !== creds[key]);
  till.setCredentials(Object.fromEntries(changedCredentials.map((key) => [key, creds[key]])));

  const changed = [...Object.keys(details), ...changedCredentials];
  if (!moved.length && till.source === 'env') return { till, action: 'unchanged', changed };

  till.source = 'env';
  till.envApplied = applied;
  till.markModified('envApplied');
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

const SECRETS = '+consumerKey +consumerSecret +passkey +envApplied';

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
