import mongoose from '../config/mongoose.js';
import { decryptSecret, encryptSecret, randomToken } from '../utils/crypto.js';

const { Schema } = mongoose;

// Where money lands: one M-Pesa till (Buy Goods) or Paybill, with its Daraja credentials.
// Platforms point at a till, so several platforms can share one, and a partner can bring
// their own. Tills come from the MPESA_* variables on the host or scripts/till.js. Admins can
// correct them in the dashboard, which asks for their password again and audits every change,
// because these numbers decide where customers' money goes.
const tillSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // till: Buy Goods (CustomerBuyGoodsOnline). paybill: CustomerPayBillOnline.
    kind: { type: String, enum: ['till', 'paybill'], required: true },
    environment: { type: String, enum: ['sandbox', 'production'], required: true },
    // The number that signs requests: the store / head office number for a till, or the Paybill.
    shortcode: { type: String, required: true, trim: true, match: [/^\d{5,8}$/, 'Shortcode must be 5–8 digits'] },
    // The Buy Goods till customers pay into (PartyB). Required for kind "till".
    tillNumber: { type: String, trim: true, match: [/^\d{5,8}$/, 'Till number must be 5–8 digits'] },
    consumerKey: { type: String, select: false },
    consumerSecret: { type: String, select: false },
    passkey: { type: String, select: false },
    // Makes this till's callback URL unguessable, so strangers can't post fake results.
    callbackSecret: { type: String, select: false, default: () => randomToken(24) },
    active: { type: Boolean, default: true },
    // Whose till it is. Platforms on an ISA till pay IsaPay a percentage of what they receive (the
    // money lands with you); platforms on a partner's own till pay a monthly subscription.
    owner: { type: String, enum: ['isa', 'partner'], default: 'isa' },
    // The till's number: "M-Pesa till 1", "M-Pesa till 2"… Its Daraja keys are labelled the same
    // way ("M-Pesa consumer key 2"), and on the host it's managed by the variables with the same
    // number: MPESA_CONSUMER_KEY for till 1, MPESA_CONSUMER_KEY_2 for till 2, and so on. So keys
    // for different tills never overlap.
    slot: { type: Number, min: 1, max: 99, unique: true, sparse: true },
    // env: created from the MPESA_* variables on the host. cli: added with scripts/till.js.
    // dashboard: added by an admin in the dashboard.
    source: { type: String, enum: ['env', 'cli', 'dashboard'] },
    // The MPESA_* values last applied to this till (secrets as fingerprints). On start-up only the
    // variables that changed since are applied, so edits made in the dashboard aren't undone.
    envApplied: { type: Schema.Types.Mixed, select: false },
  },
  { timestamps: true },
);

tillSchema.pre('validate', function requireTillNumber() {
  if (this.kind === 'till' && !this.tillNumber) this.invalidate('tillNumber', 'A Buy Goods till needs its till number');
});

tillSchema.methods.setCredentials = function setCredentials({ consumerKey, consumerSecret, passkey }) {
  if (consumerKey !== undefined) this.consumerKey = encryptSecret(consumerKey);
  if (consumerSecret !== undefined) this.consumerSecret = encryptSecret(consumerSecret);
  if (passkey !== undefined) this.passkey = encryptSecret(passkey);
};

// Needs the document loaded with +consumerKey +consumerSecret +passkey.
tillSchema.methods.credentials = function credentials() {
  return {
    consumerKey: decryptSecret(this.consumerKey),
    consumerSecret: decryptSecret(this.consumerSecret),
    passkey: decryptSecret(this.passkey),
  };
};

// The next free till number.
tillSchema.statics.nextSlot = async function nextSlot() {
  const last = await this.findOne({ slot: { $exists: true } }).sort({ slot: -1 }).select('slot');
  return (last?.slot || 0) + 1;
};

// The suffix of the host variables for till `slot`: '' for till 1 (MPESA_CONSUMER_KEY), '_2' for
// till 2 (MPESA_CONSUMER_KEY_2)…
export const envSuffix = (slot) => (!slot || slot === 1 ? '' : `_${slot}`);

// What a payer types in the M-Pesa menu.
tillSchema.virtual('payNumber').get(function payNumber() {
  return this.kind === 'till' ? this.tillNumber : this.shortcode;
});

tillSchema.methods.toPublic = function toPublic() {
  return {
    id: this.id,
    name: this.name,
    kind: this.kind,
    environment: this.environment,
    shortcode: this.shortcode,
    tillNumber: this.tillNumber || null,
    payNumber: this.payNumber,
    active: this.active,
    owner: this.owner || 'isa',
    slot: this.slot || null,
    label: this.slot ? `M-Pesa till ${this.slot}` : null,
    envSuffix: this.slot ? envSuffix(this.slot) : null,
    source: this.source || null,
    createdAt: this.createdAt,
  };
};

export const Till = mongoose.model('Till', tillSchema);
