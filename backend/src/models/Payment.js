import mongoose from '../config/mongoose.js';
import { maskPhone } from '../utils/phone.js';

const { Schema } = mongoose;

export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'disputed'];

// Plain-language reasons for the STK result codes payers actually hit.
const RESULT_MESSAGES = {
  0: 'Payment received',
  1: 'The M-Pesa balance was too low for this payment',
  1001: 'Another M-Pesa payment was already in progress on this phone',
  1019: 'The payment request expired before it was answered',
  1025: 'M-Pesa could not send the prompt. Please try again',
  1032: 'The payment was cancelled on the phone',
  1037: "M-Pesa couldn't reach the phone. Check it's on and has signal, then try again",
  2001: 'The M-Pesa PIN was wrong',
};

export const resultMessage = (code, fallback) =>
  RESULT_MESSAGES[code] ?? (fallback || 'The payment did not go through');

// One STK push attempt for one platform. Status changes go through services/payments.js only.
const paymentSchema = new Schema(
  {
    platform: { type: Schema.Types.ObjectId, ref: 'Platform', required: true, index: true },
    paymentLink: { type: Schema.Types.ObjectId, ref: 'PaymentLink', index: true },
    singleUseLink: { type: Boolean, default: false },
    till: { type: Schema.Types.ObjectId, ref: 'Till', required: true },
    // The platform's own id for what is being paid for (order, booking, donation…).
    reference: { type: String, required: true, trim: true, maxlength: 64 },
    idempotencyKey: { type: String, trim: true, maxlength: 100 },
    purpose: { type: String, trim: true, maxlength: 40 },
    description: { type: String, trim: true, maxlength: 100 },
    metadata: { type: Schema.Types.Mixed, default: undefined },
    phone: { type: String, required: true },
    customerName: { type: String, trim: true, maxlength: 80 },
    customerEmail: { type: String, trim: true, lowercase: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'KES' },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'pending', index: true },
    checkoutRequestId: { type: String, unique: true, sparse: true },
    merchantRequestId: String,
    receipt: { type: String, unique: true, sparse: true },
    // What M-Pesa says was paid, when it differs from `amount` the payment is "disputed".
    paidAmount: Number,
    resultCode: Number,
    resultDesc: String,
    paidAt: Date,
    failedAt: Date,
    // Safaricom's callback, kept until Safaricom's own status check agrees with it.
    callback: {
      resultCode: Number,
      receipt: String,
      amount: Number,
      phone: String,
      receivedAt: Date,
    },
    lastCheckedAt: Date,
    checks: { type: Number, default: 0 },
    // A short history for the dashboard: what was sent, what came back, who did what.
    events: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        type: { type: String, required: true },
        source: String,
        note: String,
        data: Schema.Types.Mixed,
      },
    ],
  },
  { timestamps: true },
);

paymentSchema.index(
  { platform: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentSchema.index({ platform: 1, reference: 1, createdAt: -1 });
paymentSchema.index(
  { paymentLink: 1, status: 1 },
  { unique: true, partialFilterExpression: { singleUseLink: true, status: 'pending' } },
);
paymentSchema.index({ status: 1, createdAt: 1 });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ phone: 1, createdAt: -1 });

paymentSchema.virtual('message').get(function message() {
  if (this.status === 'pending') return 'Waiting for the payer to enter their M-Pesa PIN';
  if (this.status === 'disputed') return 'M-Pesa reported a different amount; held for review';
  return resultMessage(this.resultCode, this.resultDesc);
});

// What platforms see, in API responses and webhooks.
paymentSchema.methods.toPlatform = function toPlatform(platformSlug) {
  return {
    id: this.id,
    object: 'payment',
    platform: platformSlug,
    reference: this.reference,
    purpose: this.purpose || null,
    description: this.description || null,
    amount: this.amount,
    paidAmount: this.paidAmount ?? null,
    currency: this.currency,
    phone: this.phone,
    ...(this.customerName ? { customerName: this.customerName } : {}),
    ...(this.customerEmail ? { customerEmail: this.customerEmail } : {}),
    ...(this.paymentLink ? { paymentLink: String(this.paymentLink) } : {}),
    status: this.status,
    receipt: this.receipt || null,
    resultCode: this.resultCode ?? null,
    message: this.message,
    metadata: this.metadata || {},
    createdAt: this.createdAt,
    paidAt: this.paidAt || null,
    failedAt: this.failedAt || null,
  };
};

// For dashboard lists: the phone is masked, everything else is as stored.
paymentSchema.methods.toAdminRow = function toAdminRow() {
  return {
    id: this.id,
    platform: this.platform?.toPublic ? { id: this.platform.id, name: this.platform.name, slug: this.platform.slug } : this.platform,
    reference: this.reference,
    purpose: this.purpose || null,
    amount: this.amount,
    paidAmount: this.paidAmount ?? null,
    phone: maskPhone(this.phone),
    ...(this.customerName ? { customerName: this.customerName } : {}),
    ...(this.customerEmail ? { customerEmail: this.customerEmail } : {}),
    status: this.status,
    receipt: this.receipt || null,
    message: this.message,
    createdAt: this.createdAt,
    paidAt: this.paidAt || null,
  };
};

export const Payment = mongoose.model('Payment', paymentSchema);
