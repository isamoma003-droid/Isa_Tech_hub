import { AuditLog } from '../models/AuditLog.js';

// Records who changed what. `by` is the request (dashboard) or a label (command line).
export async function audit(by, action, target, details) {
  const fromRequest = typeof by === 'object' && by !== null;
  const admin = fromRequest ? by.admin : null;
  try {
    await AuditLog.create({
      actor: admin?._id,
      actorLabel: admin ? `${admin.name} <${admin.email}>` : String(by || 'system'),
      action,
      target,
      details,
      ip: fromRequest ? by.ip : undefined,
    });
  } catch (err) {
    // Never let a logging failure undo the change itself, but make it loud.
    console.error(`AUDIT LOG WRITE FAILED for ${action}:`, err);
  }
}
