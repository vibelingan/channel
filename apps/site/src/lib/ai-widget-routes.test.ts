import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { AI_WIDGET_ROUTES } from './ai-widget-routes.ts';

const page = (path: string) => new URL(`../pages/${path}`, import.meta.url).pathname;
const pageFiles: Record<string, string> = {
  '/': page('index.astro'),
  '/headphones': page('headphones.astro'),
  '/oem': page('oem.astro'),
  '/products/item': page('products/item.astro'),
  '/products/[publicKey]': page('products/[publicKey].astro'),
  '/portfolio': page('portfolio.astro'),
  '/privacy': page('privacy.astro'),
  '/admin': page('admin.astro'),
  '/account': page('account.astro'),
  '/login': page('login.astro'),
  '/register': page('register.astro'),
  '/reset': page('reset.astro'),
  '/oem_submit_result': page('oem_submit_result.astro'),
};

test('direct_product_visit_has_single_widget: one assistant on exactly the allowlisted pages', async () => {
  assert.deepEqual(AI_WIDGET_ROUTES, [
    '/',
    '/headphones',
    '/oem',
    '/products/item',
    '/products/[publicKey]',
  ]);
  let enumerated = 0;
  for (const [route, file] of Object.entries(pageFiles)) {
    const source = await readFile(file, 'utf8');
    const mounts = source.split('<AssistantHost').length - 1;
    assert.equal(
      mounts,
      AI_WIDGET_ROUTES.includes(route as (typeof AI_WIDGET_ROUTES)[number]) ? 1 : 0,
      route,
    );
    enumerated += 1;
  }
  assert.ok(enumerated >= 12, 'the test must enumerate positive and negative route surfaces');
});

test('only the host mounts the assistant island, and the shared layout does not', async () => {
  const sources = new URL('..', import.meta.url).pathname;
  const files = (await readdir(sources, { recursive: true })).filter((file) =>
    file.endsWith('.astro'),
  );
  const mounting = [];
  for (const file of files)
    if ((await readFile(`${sources}${file}`, 'utf8')).includes('<AssistantWidget'))
      mounting.push(file);
  assert.deepEqual(mounting, ['components/AssistantHost.astro']);
  const layout = await readFile(new URL('../layouts/BaseLayout.astro', import.meta.url), 'utf8');
  assert.ok(!layout.includes('AssistantHost'));
});
