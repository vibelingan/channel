import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Reads the raw en-US site content. The i18n loader itself relies on Vite's
// import.meta.glob (not available under `tsx --test`), so we assert against the
// source-of-truth markdown directly — which is exactly what must stay free of
// links to the hidden (un-routed) headphones/overstock sections.
const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');
const headphonesContent = readFileSync(
  fileURLToPath(new URL('./content/headphones/en-US.md', import.meta.url)),
  'utf8',
);
const overstockContent = readFileSync(
  fileURLToPath(new URL('./content/overstock/en-US.md', import.meta.url)),
  'utf8',
);
const normalizedHeadphonesContent = headphonesContent.replace(/\s+/g, ' ');
const normalizedOverstockContent = overstockContent.replace(/\s+/g, ' ');
const storefronts = [
  { hidden: '../pages/_overstock.astro', publicName: 'overstock' },
  { hidden: '../pages/_overstock-item.astro', publicName: 'overstock-item' },
];

test('site content links to no hidden section (overstock un-routed)', () => {
  assert.ok(!enUS.includes("href: '/overstock'"), 'must not link to /overstock');
});

test('site content links to no hidden Teardown Lab / Blue Ocean route', () => {
  // Both sections are temporarily hidden (2026-08): pages un-routed via the `_`
  // prefix, so no nav/footer link anywhere may point at them.
  assert.ok(!enUS.includes("href: '/teardown-lab'"), 'must not link to /teardown-lab');
  assert.ok(!enUS.includes("href: '/blue-ocean'"), 'must not link to /blue-ocean');
});

test('primary nav no longer lists Overstock', () => {
  assert.ok(
    !/label: Overstock, href: '\/overstock'/.test(enUS),
    'Overstock nav/footer item removed',
  );
});

test('hidden storefront sources use the approved response time without restoring routes', () => {
  assert.match(normalizedHeadphonesContent, /Our team typically replies within 24 hours\./);
  assert.match(normalizedOverstockContent, /inquiry and reply within 24 hours\./);
  assert.doesNotMatch(`${headphonesContent}\n${overstockContent}`, /business[-\s]+days?/i);

  for (const storefront of storefronts) {
    assert.ok(existsSync(fileURLToPath(new URL(storefront.hidden, import.meta.url))));
    for (const publicPath of [
      `../pages/${storefront.publicName}.astro`,
      `../pages/${storefront.publicName}/index.astro`,
    ]) {
      assert.ok(!existsSync(fileURLToPath(new URL(publicPath, import.meta.url))));
    }
  }
});
