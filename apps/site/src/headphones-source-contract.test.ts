import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const islandSource = readFileSync(
  fileURLToPath(new URL('./islands/shop/HeadphonesPage.tsx', import.meta.url)),
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
  const pageStringsInterface = sourceBetween(
    islandSource,
    'interface PageStrings',
    'interface Props',
  );
  const pageStringsObject = sourceBetween(routeSource, 'const pageStrings = {', '// SEO metadata');
  // MIU 12: the hero consumes `hp.hero` (typed HeadphonesContent) exclusively;
  // neither the island props nor the route redeclare hero copy.
  for (const key of ['heroEyebrow', 'heroHeading', 'heroBody', 'heroBadges']) {
    const declaration = new RegExp(`\\b${key}\\s*:`);
    assert.doesNotMatch(pageStringsInterface, declaration);
    assert.doesNotMatch(pageStringsObject, declaration);
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

test('Headphones route and island omit unused detail string declarations', () => {
  const pageStringsInterface = sourceBetween(
    islandSource,
    'interface PageStrings',
    'interface Props',
  );
  const pageStringsObject = sourceBetween(routeSource, 'const pageStrings = {', '// SEO metadata');
  for (const key of ['unitPriceLabel', 'detailHeading']) {
    const declaration = new RegExp(`\\b${key}\\s*:`);
    assert.doesNotMatch(pageStringsInterface, declaration);
    assert.doesNotMatch(pageStringsObject, declaration);
  }
});
