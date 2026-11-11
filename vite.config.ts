import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': `http://127.0.0.1:${process.env.FORGEHAND_API_PORT || 8787}` },
    // Test reports contain HTML and traces. Watching them causes unrelated
    // page reloads and unnecessary work on this low-memory development host.
    watch: { ignored: ['**/.npm-cache/**', '**/artifacts/**', '**/test-results/**', '**/playwright-report/**', '**/coverage/**'] },
  },
  build: { chunkSizeWarningLimit: 700 },
});
