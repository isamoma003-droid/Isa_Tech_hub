import { connectDb } from './config/db.js';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { startWorkers } from './services/workers.js';

async function main() {
  await connectDb();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`ISA Tech Hub listening on http://localhost:${env.port}`);
    console.log(`Safaricom callbacks go to ${env.publicUrl}/mpesa/callback/<till>/<secret>`);
  });
  if (env.workers) startWorkers();
  else console.log('Background work is off (WORKERS=false): pending payments and webhooks will wait');
}

main().catch((err) => {
  console.error('Failed to start the server:', err);
  process.exit(1);
});
