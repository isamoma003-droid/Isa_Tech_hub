import mongoose from './mongoose.js';
import { env } from './env.js';

export async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri);
  console.log(`MongoDB connected (${mongoose.connection.name})`);
  return mongoose.connection;
}
