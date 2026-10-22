import mongoose from '../config/mongoose.js';

const { Schema } = mongoose;

const paymentLinkSchema = new Schema(
  {
    platform: { type: Schema.Types.ObjectId, ref: 'Platform', required: true, index: true },
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    amountType: { type: String, enum: ['fixed', 'customer'], required: true },
    amount: { type: Number, min: 1 },
    minAmount: { type: Number, min: 1 },
    maxAmount: { type: Number, min: 1 },
    usage: { type: String, enum: ['reusable', 'single-use'], default: 'reusable' },
    collectName: { type: Boolean, default: true },
    collectEmail: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'disabled', 'paid'], default: 'active', index: true },
    deletedAt: Date,
    checkoutLock: { type: String, select: false },
    successfulPayments: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true },
  },
  { timestamps: true },
);

paymentLinkSchema.methods.toPublic = function toPublic() {
  return {
    id: this.id,
    slug: this.slug,
    title: this.title,
    description: this.description || '',
    amountType: this.amountType,
    amount: this.amount ?? null,
    minAmount: this.minAmount ?? null,
    maxAmount: this.maxAmount ?? null,
    usage: this.usage,
    collectName: this.collectName,
    collectEmail: this.collectEmail,
    status: this.status,
    successfulPayments: this.successfulPayments,
    createdAt: this.createdAt,
  };
};

export const PaymentLink = mongoose.model('PaymentLink', paymentLinkSchema);
