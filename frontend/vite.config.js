import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the Hub API runs on :5100; the proxy avoids CORS setup.
    proxy: { '/api': 'http://localhost:5100' },
  },
});
