import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
if (!process.env.SEO_BLOG_RELEASE_INPUT || !process.env.SEO_BLOG_TASK_ID || process.env.SEO_BLOG_SNAPSHOT)
  throw new Error('Dummy build requires an explicit task-bound candidate input');
export default defineConfig({
  site: process.env.SITE_URL,
  base: '/__blog-dummy/', srcDir: './src/dummy', publicDir: './src/dummy/public',
  build: { inlineStylesheets: 'always' },
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});
