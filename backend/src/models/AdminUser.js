import bcrypt from 'bcryptjs';
import mongoose from '../config/mongoose.js';

// People who sign in to the dashboard. admin: everything; viewer: read-only.
// Created from the command line (scripts/admin.js), so nobody can sign themselves up.
const adminUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ['admin', 'viewer'], default: 'admin' },
    active: { type: Boolean, default: true },
    // Bumped on password change, which signs the person out everywhere.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

adminUserSchema.methods.setPassword = async function setPassword(password) {
  this.passwordHash = await bcrypt.hash(password, 12);
};

adminUserSchema.methods.checkPassword = function checkPassword(password) {
  return this.passwordHash ? bcrypt.compare(password, this.passwordHash) : Promise.resolve(false);
};

adminUserSchema.methods.toPublic = function toPublic() {
  return { id: this.id, name: this.name, email: this.email, role: this.role, lastLoginAt: this.lastLoginAt || null };
};

export const AdminUser = mongoose.model('AdminUser', adminUserSchema);
