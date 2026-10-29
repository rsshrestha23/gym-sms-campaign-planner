import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy versioned API paths (/v1/..., and /v<n> so unknown versions get the API's 404) plus the
// unversioned v1 alias paths; everything else belongs to the SPA.
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';
const proxy = Object.fromEntries(['^/v\\d+(/|$)', '/campaigns', '/webhooks', '/health'].map((path) => [path, { target, changeOrigin: true }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 5173, host: true, proxy },
});
