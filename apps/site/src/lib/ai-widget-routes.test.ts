import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AI_WIDGET_ROUTES } from './ai-widget-routes.ts';

const pageFiles: Record<string, string> = {
  '/': new URL('../pages/index.astro', import.meta.url).pathname,
  '/headphones': new URL('../pages/headphones.astro', import.meta.url).pathname,
  '/oem': new URL('../pages/oem.astro', import.meta.url).pathname,
  '/portfolio': new URL('../pages/portfolio.astro', import.meta.url).pathname,
  '/admin': new URL('../pages/admin.astro', import.meta.url).pathname,
  '/account': new URL('../pages/account.astro', import.meta.url).pathname,
  '/login': new URL('../pages/login.astro', import.meta.url).pathname,
  '/register': new URL('../pages/register.astro', import.meta.url).pathname,
  '/reset': new URL('../pages/reset.astro', import.meta.url).pathname,
  '/oem_submit_result': new URL('../pages/oem_submit_result.astro', import.meta.url).pathname,
};

test('assistant island is mounted on exactly the explicit public route allowlist', async () => {
  assert.deepEqual(AI_WIDGET_ROUTES, ['/', '/headphones', '/oem']);
  let enumerated = 0;
  for (const [route, file] of Object.entries(pageFiles)) {
    const source = await readFile(file, 'utf8');
    const mounted = source.includes('<AssistantWidget');
    assert.equal(
      mounted,
      AI_WIDGET_ROUTES.includes(route as (typeof AI_WIDGET_ROUTES)[number]),
      route,
    );
    enumerated += 1;
  }
  assert.ok(enumerated >= 10, 'the test must enumerate positive and negative route surfaces');
});
