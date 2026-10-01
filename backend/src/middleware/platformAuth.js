import { Platform } from '../models/Platform.js';
import { forbidden, unauthorized } from '../utils/httpError.js';

// Platforms call the API server-to-server with `Authorization: Bearer isa_sk_…`.
// The key is a secret: it must never be shipped to a browser or an app.
export async function requirePlatform(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  const key = scheme === 'Bearer' ? token : req.get('x-api-key');
  if (!key) throw unauthorized('Send your platform API key as "Authorization: Bearer isa_sk_…"');

  const platform = await Platform.findByApiKey(key);
  if (!platform) throw unauthorized('Invalid API key');
  if (platform.status !== 'active') throw forbidden('This platform is disabled. Contact the ISA Tech Hub admin.');
  req.platform = platform;
  next();
}
