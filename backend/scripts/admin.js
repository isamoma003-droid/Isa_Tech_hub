// Dashboard accounts. Run from backend/ with the production MONGODB_URI in .env:
//   npm run admin:create -- --email you@example.com --name "Your Name" [--role viewer]
//   node scripts/admin.js list
//   node scripts/admin.js reset-password --email you@example.com
//   node scripts/admin.js deactivate --email someone@example.com
import { randomToken } from '../src/utils/crypto.js';
import { AdminUser } from '../src/models/AdminUser.js';
import { audit } from '../src/services/audit.js';
import { args, fail, run } from './cli.js';

const command = process.argv[2];
const by = `command line (${process.env.USER || 'unknown user'})`;

async function create() {
  const { email, name, role = 'admin' } = args({ email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } });
  if (!email || !name) fail('Usage: npm run admin:create -- --email you@example.com --name "Your Name" [--role admin|viewer]');
  if (!['admin', 'viewer'].includes(role)) fail('--role must be admin or viewer');
  if (await AdminUser.exists({ email: email.toLowerCase() })) fail(`${email} already has an account`);
  const password = randomToken(15);
  const admin = new AdminUser({ email, name, role });
  await admin.setPassword(password);
  await admin.save();
  await audit(by, 'admin.created', { type: 'admin', id: admin.id, label: admin.email }, { role });
  console.log(`\n  Created ${role} ${admin.email}\n  Temporary password: ${password}\n  Sign in and change it under Account.\n`);
}

async function list() {
  const admins = await AdminUser.find().sort({ createdAt: 1 });
  if (!admins.length) return console.log('\n  No dashboard accounts yet. Create one with npm run admin:create.\n');
  console.log('');
  for (const a of admins) console.log(`  ${a.active ? '●' : '○'} ${a.email}  ${a.role}  ${a.name}`);
  console.log('');
}

async function resetPassword() {
  const { email } = args({ email: { type: 'string' } });
  const admin = email && (await AdminUser.findOne({ email: email.toLowerCase() }));
  if (!admin) fail('Usage: node scripts/admin.js reset-password --email <existing account>');
  const password = randomToken(15);
  await admin.setPassword(password);
  admin.tokenVersion += 1;
  await admin.save();
  await audit(by, 'admin.password_reset', { type: 'admin', id: admin.id, label: admin.email });
  console.log(`\n  New temporary password for ${admin.email}: ${password}\n`);
}

async function setActive(active) {
  const { email } = args({ email: { type: 'string' } });
  const admin = email && (await AdminUser.findOne({ email: email.toLowerCase() }));
  if (!admin) fail(`Usage: node scripts/admin.js ${active ? 'activate' : 'deactivate'} --email <existing account>`);
  admin.active = active;
  admin.tokenVersion += 1;
  await admin.save();
  await audit(by, active ? 'admin.activated' : 'admin.deactivated', { type: 'admin', id: admin.id, label: admin.email });
  console.log(`\n  ${admin.email} is now ${active ? 'active' : 'deactivated'}\n`);
}

const commands = { create, list, 'reset-password': resetPassword, deactivate: () => setActive(false), activate: () => setActive(true) };
if (!commands[command]) fail(`Commands: ${Object.keys(commands).join(', ')}`);
run(commands[command]);
