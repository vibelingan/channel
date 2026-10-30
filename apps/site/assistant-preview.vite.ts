import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
export default defineConfig({
  cacheDir: 'node_modules/.vite-assistant-preview',
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api/ai': 'http://127.0.0.1:62382' },
    fs: { allow: ['../..'] },
  },
});
