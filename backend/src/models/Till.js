import mongoose from '../config/mongoose.js';
import { decryptSecret, encryptSecret, randomToken } from '../utils/crypto.js';

const { Schema } = mongoose;

// Where money lands: one M-Pesa till (Buy Goods) or Paybill, with its Daraja credentials.
// Platforms point at a till, so several platforms can share one, and a partner can bring
// their own. Tills are set up on the server only (MPESA_* environment variables, or
// scripts/till.js), never from the dashboard: a stolen dashboard password must not be able to
// send customers' money elsewhere.
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
    // env: managed by the MPESA_* variables on the host (one till). cli: added with scripts/till.js.
    source: { type: String, enum: ['env', 'cli'] },
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
    createdAt: this.createdAt,
  };
};

export const Till = mongoose.model('Till', tillSchema);
