// Lets a fresh deployment be set up entirely from the host's environment variables (the Render
// dashboard), with no shell: the first dashboard account, and the till with its Daraja
// credentials. Admins can correct the till in the dashboard afterwards.
import { AdminUser } from '../models/AdminUser.js';
import { AuditLog } from '../models/AuditLog.js';
import { Till, envSuffix } from '../models/Till.js';
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
 * Applies every numbered set of MPESA_* variables: MPESA_SHORTCODE, MPESA_CONSUMER_KEY… for
 * till 1, MPESA_SHORTCODE_2, MPESA_CONSUMER_KEY_2… for till 2, and so on. Each set manages its
 * own till, so the keys of different tills never overlap.
 * @returns {Promise<Array>} one syncTillFromEnv result per numbered set found
 */
export async function syncTillsFromEnv(vars = process.env) {
  await assignSlots();
  const slots = new Set([1]);
  for (const key of Object.keys(vars)) {
    const match = /^MPESA_SHORTCODE_(\d{1,2})$/.exec(key);
    if (match && Number(match[1]) >= 1) slots.add(Number(match[1]));
  }
  const results = [];
  for (const slot of [...slots].sort((a, b) => a - b)) {
    try {
      const result = await syncTillFromEnv(vars, slot);
      if (result) results.push(result);
    } catch (err) {
      console.error(`Could not set up M-Pesa till ${slot} from MPESA_*${envSuffix(slot)} variables:`, err.message);
    }
  }
  return results;
}

/**
 * Creates the till described by one numbered set of MPESA_* variables, or applies the variables
 * that changed. The same variable names as A-Read: MPESA_SHORTCODE is the store / head office
 * number that signs requests, MPESA_TILL_NUMBER the Buy Goods till customers pay (leave it empty
 * for a Paybill). Till 1 reads the plain names (or MPESA_SHORTCODE_1…), till N reads MPESA_*_N.
 *
 * Each set manages one till, marked `source: 'env'` with that number. Each start-up applies only
 * the variables whose value differs from what was applied last time, so for every field the
 * latest change wins: correcting MPESA_TILL_NUMBER on the host corrects the till, and a correction
 * made in the dashboard isn't undone by a restart. The till keeps its id and callback secret.
 * @returns {Promise<{ till, action: 'created'|'updated'|'unchanged', changed?: string[] } | null>}
 */
export async function syncTillFromEnv(vars = process.env, slot = 1) {
  const suffix = envSuffix(slot);
  const read = (name) => {
    const value = vars[`${name}${suffix}`];
    return slot === 1 && (value === undefined || value === '') ? vars[`${name}_1`] : value;
  };
  const shortcode = read('MPESA_SHORTCODE')?.trim();
  const creds = { consumerKey: read('MPESA_CONSUMER_KEY'), consumerSecret: read('MPESA_CONSUMER_SECRET'), passkey: read('MPESA_PASSKEY') };
  if (!shortcode || !creds.consumerKey || !creds.consumerSecret || !creds.passkey) {
    if (slot > 1 && shortcode) {
      console.warn(`M-Pesa till ${slot}: set MPESA_CONSUMER_KEY${suffix}, MPESA_CONSUMER_SECRET${suffix} and MPESA_PASSKEY${suffix} as well`);
    }
    return null;
  }

  const tillNumber = read('MPESA_TILL_NUMBER')?.trim() || null;
  const name = read('MPESA_TILL_NAME')?.trim() || null;
  // A till without its own MPESA_ENV_N follows MPESA_ENV, so one MPESA_ENV=production covers all.
  const envValue = read('MPESA_ENV') || vars.MPESA_ENV;
  const environment = envValue === 'production' ? 'production' : 'sandbox';
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

  const till = await findEnvTill(slot);
  if (till === false) return null;
  if (!till) {
    const kind = tillNumber ? 'till' : 'paybill';
    const created = new Till({
      name: name || (slot === 1 ? (kind === 'till' ? 'ISA main till' : 'ISA Paybill') : `M-Pesa till ${slot}`),
      kind,
      environment,
      shortcode,
      tillNumber: tillNumber || undefined,
      source: 'env',
      slot,
      envApplied: applied,
    });
    created.setCredentials(creds);
    await created.save();
    await audit(BY, 'till.created', { type: 'till', id: created.id, label: created.name }, { kind, environment, payNumber: created.payNumber, slot });
    console.log(`Added M-Pesa till ${slot}: ${environment} ${kind} "${created.name}" (customers pay ${created.payNumber}) from MPESA_*${suffix} variables`);
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
  if (!moved.length && till.source === 'env' && till.slot) return { till, action: 'unchanged', changed };

  till.source = 'env';
  till.slot ??= slot;
  till.envApplied = applied;
  till.markModified('envApplied');
  await till.save();
  if (changed.length) {
    // Numbers are logged from → to; credentials only by name.
    await audit(BY, Object.keys(details).length ? 'till.updated' : 'till.credentials_changed', { type: 'till', id: till.id, label: till.name }, {
      ...details,
      ...(changedCredentials.length ? { credentials: changedCredentials } : {}),
    });
    console.log(`Updated M-Pesa till ${slot} "${till.name}" from MPESA_*${suffix} variables: ${changed.join(', ')} (customers pay ${till.payNumber})`);
  }
  return { till, action: changed.length ? 'updated' : 'unchanged', changed };
}

const SECRETS = '+consumerKey +consumerSecret +passkey +envApplied';

// The till that MPESA_*<suffix> manages: the till with that number. Returns false when that
// number belongs to a till added in the dashboard or from the command line: the variables never
// take over a till they didn't create, since its numbers decide where customers' money goes.
async function findEnvTill(slot) {
  const numbered = await Till.findOne({ slot }).select(SECRETS);
  if (numbered && numbered.source !== 'env' && !(slot === 1 && (await isLegacyEnvTill(numbered)))) {
    console.warn(
      `MPESA_*${envSuffix(slot)} variables ignored: M-Pesa till ${slot} is "${numbered.name}", added ${numbered.source === 'dashboard' ? 'in the dashboard' : 'from the command line'}. ` +
        `Use the next free number (${await Till.nextSlot()}) for the variables instead.`,
    );
    return false;
  }
  if (numbered || slot !== 1) return numbered;
  return findLegacyEnvTill();
}

// Till 1 from before tills were numbered: marked `source: 'env'`, or, from before `source`
// existed, recognised from the audit log. It's corrected rather than duplicated.
async function findLegacyEnvTill() {
  const marked = await Till.findOne({ source: 'env', slot: { $exists: false } }).select(SECRETS);
  if (marked) return marked;
  const created = await AuditLog.find({ action: 'till.created', actorLabel: BY }).sort({ createdAt: -1 }).limit(5);
  for (const entry of created) {
    const till = entry.target?.id && (await Till.findById(entry.target.id).select(SECRETS));
    if (till) return till;
  }
  return null;
}

async function isLegacyEnvTill(till) {
  return Boolean(await AuditLog.exists({ action: 'till.created', actorLabel: BY, 'target.id': till.id }));
}

/**
 * Numbers the tills that don't have a number yet (tills from before numbering): the till from the
 * plain MPESA_* variables becomes till 1, the others follow in the order they were added.
 */
export async function assignSlots() {
  if (!(await Till.exists({ slot: { $exists: false } }))) return;
  const legacy = await findLegacyEnvTill();
  if (legacy && !legacy.slot && !(await Till.exists({ slot: 1 }))) {
    await Till.updateOne({ _id: legacy._id }, { $set: { slot: 1, source: 'env' } });
  }
  const unnumbered = await Till.find({ slot: { $exists: false } }).sort({ createdAt: 1 }).select('_id name');
  for (const till of unnumbered) {
    const slot = await Till.nextSlot();
    await Till.updateOne({ _id: till._id, slot: { $exists: false } }, { $set: { slot } });
    console.log(`Numbered till "${till.name}" as M-Pesa till ${slot}`);
  }
}
