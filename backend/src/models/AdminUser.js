import bcrypt from 'bcryptjs';
import mongoose from '../config/mongoose.js';

export const ROLES = ['admin', 'viewer', 'merchant'];
export const STAFF_ROLES = ['admin', 'viewer'];
export const APPROVAL_STATES = ['pending', 'approved', 'rejected'];

// People who sign in to the dashboard.
//   admin, viewer: the ISA Tech team. admin can change everything; viewer is read-only. Created
//                  from the command line, the BOOTSTRAP_ADMIN_* variables or the Accounts page.
//   merchant:      a business using IsaPay as its M-Pesa gateway. Signs up itself (email and
//                  password, or Google) and sees only its own platforms, tills and payments. It can
//                  set everything up at once, but live payments start only once an admin approves it.
const adminUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 120 },
    // Missing for accounts that only ever signed in with Google.
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, default: 'admin' },
    active: { type: Boolean, default: true },
    // Bumped on password change, which signs the person out everywhere.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: Date,
    // "Sign in with Google": Google's permanent id for the person (the token's `sub`).
    googleId: { type: String, unique: true, sparse: true, select: false },
    avatarUrl: { type: String, trim: true, maxlength: 500 },
    emailVerifiedAt: Date,
    phone: { type: String, trim: true, maxlength: 20 },
    // Merchants: who they are, and where IsaPay sends their money when it lands in an ISA till.
    business: {
      name: { type: String, trim: true, maxlength: 100 },
      website: { type: String, trim: true, maxlength: 200 },
      description: { type: String, trim: true, maxlength: 500 },
    },
    payout: {
      method: { type: String, enum: ['mpesa', 'bank'] },
      phone: { type: String, trim: true, maxlength: 20 },
      bankName: { type: String, trim: true, maxlength: 80 },
      accountName: { type: String, trim: true, maxlength: 100 },
      accountNumber: { type: String, trim: true, maxlength: 40 },
    },
    approval: {
      status: { type: String, enum: APPROVAL_STATES },
      at: Date,
      by: String,
      note: { type: String, trim: true, maxlength: 500 },
    },
  },
  { timestamps: true },
);

adminUserSchema.index({ role: 1, 'approval.status': 1, createdAt: -1 });

adminUserSchema.methods.setPassword = async function setPassword(password) {
  this.passwordHash = await bcrypt.hash(password, 12);
};

adminUserSchema.methods.checkPassword = function checkPassword(password) {
  return this.passwordHash ? bcrypt.compare(password, this.passwordHash) : Promise.resolve(false);
};

adminUserSchema.virtual('isStaff').get(function isStaff() {
  return STAFF_ROLES.includes(this.role);
});

// Merchants take live payments once approved; staff accounts don't need approving.
adminUserSchema.virtual('approved').get(function approved() {
  return this.role !== 'merchant' || this.approval?.status === 'approved';
});

// What the person sees about themselves. hasPassword / googleLinked need the document loaded with
// +passwordHash / +googleId; otherwise they're left out.
adminUserSchema.methods.toPublic = function toPublic() {
  const loaded = (path) => this.isSelected(path);
  return {
    id: this.id,
    name: this.name,
    email: this.email,
    role: this.role,
    active: this.active,
    lastLoginAt: this.lastLoginAt || null,
    avatarUrl: this.avatarUrl || null,
    emailVerified: Boolean(this.emailVerifiedAt),
    phone: this.phone || '',
    ...(loaded('passwordHash') ? { hasPassword: Boolean(this.passwordHash) } : {}),
    ...(loaded('googleId') ? { googleLinked: Boolean(this.googleId) } : {}),
    ...(this.role === 'merchant'
      ? {
          business: { name: this.business?.name || '', website: this.business?.website || '', description: this.business?.description || '' },
          payout: {
            method: this.payout?.method || '',
            phone: this.payout?.phone || '',
            bankName: this.payout?.bankName || '',
            accountName: this.payout?.accountName || '',
            accountNumber: this.payout?.accountNumber || '',
          },
          approval: {
            status: this.approval?.status || 'pending',
            at: this.approval?.at || null,
            note: this.approval?.note || '',
          },
        }
      : {}),
    createdAt: this.createdAt,
  };
};

export const AdminUser = mongoose.model('AdminUser', adminUserSchema);
