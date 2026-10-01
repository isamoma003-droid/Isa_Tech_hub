import mongoose from 'mongoose';

// API responses expose `id` instead of `_id` and drop the version key.
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret._id;
    return ret;
  },
});
mongoose.set('strictQuery', true);

export default mongoose;
