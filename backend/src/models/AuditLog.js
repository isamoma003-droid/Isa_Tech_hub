import mongoose from '../config/mongoose.js';

const { Schema } = mongoose;

// Append-only record of every change made from the dashboard or the command line.
const auditLogSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    // Kept as text so the entry still reads correctly after the account is gone.
    actorLabel: { type: String, required: true },
    action: { type: String, required: true },
    target: {
      type: { type: String },
      id: String,
      label: String,
    },
    details: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ 'target.id': 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
