// Small helpers shared by the command-line scripts.
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';

export function args(options) {
  return parseArgs({ args: process.argv.slice(3), options, allowPositionals: false }).values;
}

export function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

export async function run(task) {
  try {
    await connectDb();
    await task();
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
