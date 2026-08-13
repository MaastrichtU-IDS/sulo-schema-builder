import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // In dev (outside Docker), proxy API calls to the locally running api
      // service — `npm run dev` in api/, or the `api` container's published
      // dev port (docker-compose.override.yml).
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
