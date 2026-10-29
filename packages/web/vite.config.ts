import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API paths are rooted at / (no /api prefix); proxy exactly those so the SPA can own `/`.
const target = process.env.API_PROXY_TARGET ?? 'http://localhost:3000';
const proxy = Object.fromEntries(['/campaigns', '/webhooks', '/health'].map((path) => [path, { target, changeOrigin: true }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 5173, host: true, proxy },
});
