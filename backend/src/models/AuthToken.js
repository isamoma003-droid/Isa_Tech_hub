import mongoose from '../config/mongoose.js';

const { Schema } = mongoose;

export const TOKEN_PURPOSES = ['reset-password', 'verify-email'];

// One-time links sent by email (password reset, email check). Only a hash of the token is kept,
// each works once, and MongoDB deletes expired ones by itself.
const authTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true, index: true },
    purpose: { type: String, enum: TOKEN_PURPOSES, required: true },
    hash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const AuthToken = mongoose.model('AuthToken', authTokenSchema);
