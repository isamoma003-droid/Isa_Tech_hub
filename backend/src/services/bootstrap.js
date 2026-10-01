// Lets a fresh deployment be set up entirely from the host's environment variables (the Render
// dashboard), with no shell: the first dashboard account, and the till with its Daraja
// credentials. Both still live only on the server side: the dashboard can't create or change them.
import { AdminUser } from '../models/AdminUser.js';
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
 * Creates the till described by the MPESA_* variables, or brings its credentials up to date.
 * The same variable names as A-Read: MPESA_SHORTCODE is the store / head office number that signs
 * requests, MPESA_TILL_NUMBER the Buy Goods till customers pay (leave it empty for a Paybill).
 * @returns {Promise<{ till, action: 'created'|'updated'|'unchanged' } | null>}
 */
export async function syncTillFromEnv(vars = process.env) {
  const shortcode = vars.MPESA_SHORTCODE?.trim();
  const creds = { consumerKey: vars.MPESA_CONSUMER_KEY, consumerSecret: vars.MPESA_CONSUMER_SECRET, passkey: vars.MPESA_PASSKEY };
  if (!shortcode || !creds.consumerKey || !creds.consumerSecret || !creds.passkey) return null;

  const environment = vars.MPESA_ENV === 'production' ? 'production' : 'sandbox';
  const tillNumber = vars.MPESA_TILL_NUMBER?.trim() || null;
  const kind = tillNumber ? 'till' : 'paybill';

  let till = await Till.findOne({ environment, shortcode, tillNumber }).select('+consumerKey +consumerSecret +passkey');
  if (!till) {
    till = new Till({
      name: vars.MPESA_TILL_NAME?.trim() || (kind === 'till' ? 'ISA main till' : 'ISA Paybill'),
      kind,
      environment,
      shortcode,
      tillNumber: tillNumber || undefined,
    });
    till.setCredentials(creds);
    await till.save();
    await audit(BY, 'till.created', { type: 'till', id: till.id, label: till.name }, { kind, environment, payNumber: till.payNumber });
    console.log(`Added ${environment} ${kind} "${till.name}" (customers pay ${till.payNumber}) from MPESA_* variables`);
    return { till, action: 'created' };
  }

  let current;
  try {
    current = till.credentials();
  } catch {
    current = {}; // stored with a different HUB_SECRET_KEY: replace with the values from the environment
  }
  const changed = Object.keys(creds).filter((key) => current[key] !== creds[key]);
  if (!changed.length) return { till, action: 'unchanged' };

  till.setCredentials(Object.fromEntries(changed.map((key) => [key, creds[key]])));
  await till.save();
  await audit(BY, 'till.credentials_changed', { type: 'till', id: till.id, label: till.name }, { changed });
  console.log(`Updated ${changed.join(', ')} for till "${till.name}" from MPESA_* variables`);
  return { till, action: 'updated' };
}
