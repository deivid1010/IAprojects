import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // En desarrollo, /api se reenvía a la API local: mismo origen que en Docker, sin CORS.
    proxy: { '/api': { target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000', rewrite: (path) => path.replace(/^\/api/, '') } },
  },
  test: { environment: 'jsdom' },
});
