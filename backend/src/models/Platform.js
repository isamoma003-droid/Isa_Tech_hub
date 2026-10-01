import mongoose from '../config/mongoose.js';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../utils/crypto.js';

const { Schema } = mongoose;

export const API_KEY_PREFIX = 'isa_sk_';
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

// A site or app that takes payments through the Hub (egertickets, A-Read, a partner's shop…).
const platformSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // Short, permanent identifier shown in webhooks and reports.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9][a-z0-9-]{1,29}$/, 'Slug: 2–30 lowercase letters, digits or dashes'],
    },
    website: { type: String, trim: true, maxlength: 200 },
    till: { type: Schema.Types.ObjectId, ref: 'Till', required: true, index: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active', index: true },
    // own: one of your platforms. partner: someone else's, sharing a till by agreement.
    ownership: { type: String, enum: ['own', 'partner'], default: 'own' },
    contact: {
      name: { type: String, trim: true, maxlength: 80 },
      email: { type: String, trim: true, lowercase: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 20 },
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    // Shown on the payer's M-Pesa prompt and statement (Paybill account number). Max 12.
    accountReference: { type: String, trim: true, maxlength: 12 },
    // Where the Hub posts payment.paid / payment.failed / payment.disputed.
    webhookUrl: { type: String, trim: true, maxlength: 500 },
    webhookSecret: { type: String, select: false },
    // Only a hash of the API key is kept; the key itself is shown once.
    apiKeyHash: { type: String, select: false, unique: true, sparse: true },
    apiKeyHint: String,
    apiKeyCreatedAt: Date,
  },
  { timestamps: true },
);

// Issues a new API key, replacing any old one. Returns the key (shown once).
platformSchema.methods.issueApiKey = function issueApiKey() {
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  this.apiKeyHash = sha256(key);
  this.apiKeyHint = `${key.slice(0, API_KEY_PREFIX.length + 4)}…${key.slice(-4)}`;
  this.apiKeyCreatedAt = new Date();
  return key;
};

// Issues a new webhook signing secret. Returns it (shown once).
platformSchema.methods.issueWebhookSecret = function issueWebhookSecret() {
  const secret = `${WEBHOOK_SECRET_PREFIX}${randomToken(32)}`;
  this.webhookSecret = encryptSecret(secret);
  return secret;
};

// Needs the document loaded with +webhookSecret.
platformSchema.methods.signingSecret = function signingSecret() {
  return decryptSecret(this.webhookSecret);
};

platformSchema.statics.findByApiKey = function findByApiKey(key) {
  if (!key?.startsWith(API_KEY_PREFIX)) return null;
  return this.findOne({ apiKeyHash: sha256(key) }).populate('till');
};

platformSchema.methods.toPublic = function toPublic() {
  const till = this.till;
  return {
    id: this.id,
    name: this.name,
    slug: this.slug,
    website: this.website || '',
    status: this.status,
    ownership: this.ownership,
    contact: { name: this.contact?.name || '', email: this.contact?.email || '', phone: this.contact?.phone || '' },
    notes: this.notes || '',
    accountReference: this.accountReference || '',
    webhookUrl: this.webhookUrl || '',
    apiKeyHint: this.apiKeyHint || null,
    apiKeyCreatedAt: this.apiKeyCreatedAt || null,
    till: till?.toPublic ? till.toPublic() : till ? String(till) : null,
    createdAt: this.createdAt,
  };
};

export const Platform = mongoose.model('Platform', platformSchema);
