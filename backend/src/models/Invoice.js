import mongoose from '../config/mongoose.js';

const { Schema } = mongoose;

export const INVOICE_STATUSES = ['open', 'paid', 'waived', 'void'];

// What one platform owes IsaPay (or IsaPay owes it) for one month.
//   subscription: a partner on its own till pays the monthly fee. open → paid | waived | void.
//   commission:   a platform on an ISA till. The money is already in your till, so the fee is
//                 kept at once (paid); the rest is owed to the partner until the payout is sent.
const invoiceSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    platform: { type: Schema.Types.ObjectId, ref: 'Platform', required: true, index: true },
    // The Kenyan calendar month billed, YYYY-MM.
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    kind: { type: String, enum: ['subscription', 'commission'], required: true },
    // Payments received in the month.
    volume: { amount: { type: Number, default: 0 }, count: { type: Number, default: 0 } },
    freeAmount: { type: Number, default: 0 },
    percent: Number,
    monthlyFee: Number,
    // IsaPay's earnings for the month.
    fee: { type: Number, required: true, min: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'open', index: true },
    dueAt: Date,
    paidAt: Date,
    receipt: String,
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    note: { type: String, trim: true, maxlength: 300 },
    // commission only: what the partner gets, and whether it has been sent.
    payout: Number,
    payoutStatus: { type: String, enum: ['none', 'pending', 'sent'], default: 'none' },
    payoutReference: { type: String, trim: true, maxlength: 100 },
    payoutAt: Date,
  },
  { timestamps: true },
);

invoiceSchema.index({ platform: 1, period: 1 }, { unique: true });

invoiceSchema.methods.toPublic = function toPublic() {
  const platform = this.platform;
  const overdue = this.status === 'open' && this.dueAt && this.dueAt < new Date();
  return {
    id: this.id,
    number: this.number,
    platform: platform?.name ? { id: platform.id, name: platform.name, slug: platform.slug } : String(platform),
    period: this.period,
    kind: this.kind,
    volume: { amount: this.volume?.amount || 0, count: this.volume?.count || 0 },
    freeAmount: this.freeAmount,
    percent: this.percent ?? null,
    monthlyFee: this.monthlyFee ?? null,
    fee: this.fee,
    currency: 'KES',
    status: this.status,
    overdue: Boolean(overdue),
    dueAt: this.dueAt || null,
    paidAt: this.paidAt || null,
    receipt: this.receipt || null,
    note: this.note || '',
    payout: this.payout ?? null,
    payoutStatus: this.payoutStatus,
    payoutReference: this.payoutReference || null,
    payoutAt: this.payoutAt || null,
    createdAt: this.createdAt,
  };
};

export const Invoice = mongoose.model('Invoice', invoiceSchema);
