import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const islandSource = readFileSync(
  fileURLToPath(new URL('./islands/shop/CatalogFamilyPage.tsx', import.meta.url)),
  'utf8',
);
const routeSource = readFileSync(
  fileURLToPath(new URL('./pages/headphones.astro', import.meta.url)),
  'utf8',
);

function sourceBetween(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  assert.ok(startAt >= 0, `missing source boundary: ${start}`);
  assert.ok(endAt > startAt, `missing source boundary: ${end}`);
  return source.slice(startAt, endAt);
}

test('hero strings come from the content contract, not route-local declarations', () => {
  // MIU 12: the hero consumes `hp.hero` (typed HeadphonesContent) exclusively;
  // neither the island nor the route redeclares hero copy.
  for (const key of ['heroEyebrow', 'heroHeading', 'heroBody', 'heroBadges']) {
    const declaration = new RegExp(`\\b${key}\\s*:`);
    assert.doesNotMatch(islandSource, declaration);
    assert.doesNotMatch(routeSource, declaration);
  }
  for (const field of ['eyebrow', 'heading', 'body', 'proof', 'primaryCta', 'secondaryCta']) {
    assert.match(routeSource, new RegExp(`hp\\.hero\\.${field}\\b`));
  }
  // The gated hero media contract: ordered sources built through apiMediaUrl
  // over the reviewed provenance, rendered by ProductMedia client:load.
  assert.match(routeSource, /hp\.hero\.sources\.map/);
  assert.match(routeSource, /apiMediaUrl\(`\/api\/images\/\$\{source\.imageId\}`\)/);
  assert.match(routeSource, /data-hero-media/);
  assert.match(routeSource, /<ProductMedia\s[^>]*client:load/);
});

// MIU 13: the route declares no copy at all — the island takes only the typed
// content contract, and route-local PageStrings are gone entirely.
test('the route declares no page-local copy and the island takes only content', () => {
  assert.doesNotMatch(routeSource, /const pageStrings\s*=/);
  assert.doesNotMatch(islandSource, /interface PageStrings/);
  assert.match(
    routeSource,
    /<CatalogFamilyPage content=\{catalog\} family=\{family\} client:load \/>/,
  );
});

// MIU 13: the controller is thin — no enquiry form, no advantages band, and no
// React `.reveal` (which is what hid asynchronously mounted products in P0).
test('the Headphones island stays a thin controller', () => {
  assert.doesNotMatch(islandSource, /InquiryForm/);
  assert.doesNotMatch(islandSource, /advItems|advHeading|advEyebrow/);
  assert.doesNotMatch(islandSource, /['"`][^'"`]*\breveal\b/);
  // Presentation is delegated, not inlined.
  assert.match(islandSource, /CatalogFamilyGrid/);
  assert.match(islandSource, /headphonesCatalogState/);
});
