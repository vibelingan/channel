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

test('HeadphonesPage props omit hero strings owned by the Astro route', () => {
  const pageStringsInterface = sourceBetween(
    islandSource,
    'interface PageStrings',
    'interface Props',
  );
  const pageStringsObject = sourceBetween(routeSource, 'const pageStrings = {', '// SEO metadata');
  for (const key of ['heroEyebrow', 'heroHeading', 'heroBody', 'heroBadges']) {
    const declaration = new RegExp(`\\b${key}\\s*:`);
    assert.doesNotMatch(pageStringsInterface, declaration);
    assert.match(pageStringsObject, declaration);
    assert.match(routeSource, new RegExp(`pageStrings\\.${key}\\b`));
  }
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
