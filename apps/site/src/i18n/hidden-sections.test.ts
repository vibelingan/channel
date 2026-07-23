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
  { hidden: '../pages/_headphones.astro', publicName: 'headphones' },
  { hidden: '../pages/_headphone-item.astro', publicName: 'headphone-item' },
  { hidden: '../pages/_overstock.astro', publicName: 'overstock' },
  { hidden: '../pages/_overstock-item.astro', publicName: 'overstock-item' },
];

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
