import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AdminUser } from '../models/AdminUser.js';
import { forbidden, unauthorized } from '../utils/httpError.js';

const AUDIENCE = 'isa-hub-dashboard';

export function signAdminToken(admin) {
  return jwt.sign({ sub: admin.id, v: admin.tokenVersion }, env.jwtSecret, { expiresIn: env.jwtExpiresIn, audience: AUDIENCE });
}

export async function requireAdmin(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, { audience: AUDIENCE });
  } catch {
    throw unauthorized('Your session has ended, please sign in again');
  }

  const admin = await AdminUser.findById(payload.sub);
  if (!admin?.active || admin.tokenVersion !== payload.v) throw unauthorized('Your session has ended, please sign in again');
  req.admin = admin;
  next();
}

// Viewers can look at everything but change nothing; merchants change only their own things (the
// routes scope every query to them), and staff-only actions name 'admin' alone.
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (roles.includes(req.admin?.role)) return next();
    throw forbidden(
      req.admin?.role === 'viewer' ? 'Your account can view the dashboard but not change anything' : 'Only an IsaPay admin can do that',
    );
  };
}
