// Tills can be added in the dashboard (Tills → Add till) or from the MPESA_* environment variables
// on the host (see .env.example: MPESA_*_2 for till 2, and so on), which are applied when the
// server starts. This script is for everything else: a till without the dashboard, deactivating,
// rotating secrets. Run from backend/ with the production MONGODB_URI and
// HUB_SECRET_KEY in .env. Daraja credentials are read from the environment, never from the
// command line (where they would land in your shell history):
//
//   MPESA_CONSUMER_KEY=… MPESA_CONSUMER_SECRET=… MPESA_PASSKEY=… \
//     npm run till -- add --name "ISA main till" --kind till --env production --shortcode <store no.> --till <till no.>
//
//   npm run till -- add --sandbox --name "Sandbox"     (Safaricom's public test shortcode 174379;
//                                                      still needs your sandbox app's key and secret)
//   npm run till -- list
//   npm run till -- set-credentials --id <till id>     (re-reads the three MPESA_* variables)
//   npm run till -- deactivate --id <till id>          (activate, rotate-callback-secret likewise)
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Platform } from '../src/models/Platform.js';
import { Till } from '../src/models/Till.js';
import { audit } from '../src/services/audit.js';
import { randomToken } from '../src/utils/crypto.js';
import { args, fail, run } from './cli.js';

// Safaricom's published sandbox test shortcode and its Lipa na M-Pesa Online passkey.
const SANDBOX = { shortcode: '174379', passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919' };

const command = process.argv[2];
const by = `command line (${process.env.USER || 'unknown user'})`;
const credentialsFromEnv = () => ({
  consumerKey: process.env.MPESA_CONSUMER_KEY || undefined,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || undefined,
  passkey: process.env.MPESA_PASSKEY || undefined,
});

async function findTill() {
  const { id } = args({ id: { type: 'string' } });
  if (!id || !mongoose.isValidObjectId(id)) fail(`Usage: npm run till -- ${command} --id <till id> (see npm run till -- list)`);
  const till = await Till.findById(id).select('+consumerKey +consumerSecret +passkey +callbackSecret');
  if (!till) fail(`No till with id ${id}`);
  return till;
}

async function add() {
  const opts = args({
    name: { type: 'string' },
    kind: { type: 'string' },
    env: { type: 'string' },
    shortcode: { type: 'string' },
    till: { type: 'string' },
    sandbox: { type: 'boolean' },
  });
  if (!opts.name) fail('--name is required, e.g. --name "ISA main till"');

  const creds = credentialsFromEnv();
  const till = new Till(
    opts.sandbox
      ? { name: opts.name, kind: 'paybill', environment: 'sandbox', shortcode: SANDBOX.shortcode }
      : { name: opts.name, kind: opts.kind, environment: opts.env, shortcode: opts.shortcode, tillNumber: opts.till },
  );
  till.source = 'cli';
  till.slot = await Till.nextSlot();
  if (opts.sandbox) creds.passkey ||= SANDBOX.passkey;
  if (!opts.sandbox && !['till', 'paybill'].includes(opts.kind)) fail('--kind must be "till" (Buy Goods) or "paybill"');
  if (!opts.sandbox && !['sandbox', 'production'].includes(opts.env)) fail('--env must be "sandbox" or "production"');
  if (!creds.consumerKey || !creds.consumerSecret || !creds.passkey) {
    fail('Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET and MPESA_PASSKEY in the environment first (see the comment at the top of this script)');
  }
  till.setCredentials(creds);
  await till.save();
  await audit(by, 'till.created', { type: 'till', id: till.id, label: till.name }, { slot: till.slot, kind: till.kind, environment: till.environment, payNumber: till.payNumber });
  console.log(`
  Added M-Pesa till ${till.slot}: ${till.environment} ${till.kind === 'till' ? 'Buy Goods till' : 'Paybill'} "${till.name}"
    id:           ${till.id}
    signs with:   ${till.shortcode}
    customers pay ${till.payNumber}
    callbacks:    ${env.publicUrl}/mpesa/callback/${till.id}/<secret>  (sent with every STK push; nothing to register)

  Next: in the dashboard, add a platform and choose this till.
`);
}

async function list() {
  const tills = await Till.find().sort({ slot: 1, createdAt: 1 }).select('+consumerKey +consumerSecret +passkey');
  if (!tills.length) return console.log('\n  No tills yet. Add one with: npm run till -- add …\n');
  console.log('');
  for (const till of tills) {
    const platforms = await Platform.find({ till: till._id }).select('slug');
    const ready = till.consumerKey && till.consumerSecret && till.passkey;
    console.log(`  ${till.active ? '●' : '○'} ${till.id}  ${till.slot ? `M-Pesa till ${till.slot}: ` : ''}${till.name}`);
    console.log(`      ${till.environment} ${till.kind}, signs with ${till.shortcode}, customers pay ${till.payNumber}`);
    console.log(`      credentials: ${ready ? 'set' : 'MISSING'}; platforms: ${platforms.map((p) => p.slug).join(', ') || 'none'}`);
  }
  console.log('');
}

async function setCredentials() {
  const till = await findTill();
  const creds = credentialsFromEnv();
  const changed = Object.keys(creds).filter((key) => creds[key]);
  if (!changed.length) fail('Set at least one of MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY');
  till.setCredentials(creds);
  await till.save();
  await audit(by, 'till.credentials_changed', { type: 'till', id: till.id, label: till.name }, { changed });
  console.log(`\n  Updated ${changed.join(', ')} for "${till.name}"\n`);
}

async function setActive(active) {
  const till = await findTill();
  till.active = active;
  await till.save();
  await audit(by, active ? 'till.activated' : 'till.deactivated', { type: 'till', id: till.id, label: till.name });
  console.log(`\n  "${till.name}" is now ${active ? 'active' : 'inactive (new payments on its platforms are refused)'}\n`);
}

async function rotateCallbackSecret() {
  const till = await findTill();
  till.callbackSecret = randomToken(24);
  await till.save();
  await audit(by, 'till.callback_secret_rotated', { type: 'till', id: till.id, label: till.name });
  console.log(`\n  New callback secret for "${till.name}". Payments already in progress will be settled by the status sweep.\n`);
}

const commands = {
  add,
  list,
  'set-credentials': setCredentials,
  deactivate: () => setActive(false),
  activate: () => setActive(true),
  'rotate-callback-secret': rotateCallbackSecret,
};
if (!commands[command]) fail(`Commands: ${Object.keys(commands).join(', ')}`);
run(commands[command]);
