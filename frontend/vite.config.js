import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The platform client (sdk/node/isa-hub.cjs) is published with the dashboard at /sdk/isa-hub.cjs,
// so partners can download it from the Developers page.
const SDK = path.resolve(import.meta.dirname, '../sdk/node/isa-hub.cjs');
const publishSdk = {
  name: 'publish-sdk',
  configureServer(server) {
    server.middlewares.use('/sdk/isa-hub.cjs', (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(fs.readFileSync(SDK));
    });
  },
  generateBundle() {
    if (fs.existsSync(SDK)) this.emitFile({ type: 'asset', fileName: 'sdk/isa-hub.cjs', source: fs.readFileSync(SDK) });
  },
};

export default defineConfig({
  plugins: [react(), publishSdk],
  server: {
    port: 5173,
    // In development the Hub API runs on :5100; the proxy avoids CORS setup.
    proxy: { '/api': 'http://localhost:5100' },
  },
});
