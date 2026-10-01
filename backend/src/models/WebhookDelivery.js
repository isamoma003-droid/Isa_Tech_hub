import mongoose from '../config/mongoose.js';

const { Schema } = mongoose;

// One event sent (or still to be sent) to a platform's webhook URL, with its retry state.
const webhookDeliverySchema = new Schema(
  {
    platform: { type: Schema.Types.ObjectId, ref: 'Platform', required: true, index: true },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment', index: true },
    event: { type: String, required: true },
    // The exact JSON body, frozen when the event happened, so retries send the same bytes.
    body: { type: String, required: true },
    url: { type: String, required: true },
    status: { type: String, enum: ['pending', 'delivered', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedUntil: Date,
    deliveredAt: Date,
    lastStatus: Number,
    lastError: String,
    history: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        status: Number,
        error: String,
        ms: Number,
      },
    ],
  },
  { timestamps: true },
);

webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export const WebhookDelivery = mongoose.model('WebhookDelivery', webhookDeliverySchema);
