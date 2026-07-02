import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reads the raw en-US site content. The i18n loader itself relies on Vite's
// import.meta.glob (not available under `tsx --test`), so we assert against the
// source-of-truth markdown directly — which is exactly what must stay free of
// links to the hidden (un-routed) headphones/overstock sections.
const enUS = readFileSync(
  fileURLToPath(new URL('./content/en-US.md', import.meta.url)),
  'utf8',
);

test('site content links to no hidden section (headphones/overstock un-routed)', () => {
  assert.ok(!enUS.includes("href: '/headphones'"), 'must not link to /headphones');
  assert.ok(!enUS.includes("href: '/overstock'"), 'must not link to /overstock');
});

test('primary nav no longer lists Headphones or Overstock', () => {
  assert.ok(
    !/label: Headphones, href: '\/headphones'/.test(enUS),
    'Headphones nav/footer item removed',
  );
  assert.ok(
    !/label: Overstock, href: '\/overstock'/.test(enUS),
    'Overstock nav/footer item removed',
  );
});
