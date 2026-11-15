import tailwindcss from '@tailwindcss/vite';
import { type Plugin, defineConfig } from 'vite';
// Product links from the chat open /products/item/?id=… in the same tab; serve
// the stand-in product page there so the conversation can continue (MIU 18).
const productRoute: Plugin = {
  name: 'assistant-product-route',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/products/item/')) req.url = '/assistant-product.html';
      next();
    });
  },
};
export default defineConfig({
  cacheDir: 'node_modules/.vite-assistant-preview',
  plugins: [tailwindcss(), productRoute],
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api/ai': 'http://127.0.0.1:62382', '/api/images': 'http://127.0.0.1:62383' },
    fs: { allow: ['../..'] },
  },
});
