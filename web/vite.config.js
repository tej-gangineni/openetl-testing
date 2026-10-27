import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server on 127.0.0.1:5173. /api is proxied to the backend so the browser
// sees one origin (no CORS, and EventSource works the same as in production).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:4100', changeOrigin: false } },
  },
});
