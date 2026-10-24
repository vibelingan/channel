import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const pageSource = readFileSync(
  fileURLToPath(new URL('../pages/headphones.astro', import.meta.url)),
  'utf8',
);

test('headphones pins its canonical override to the trailing-slash path', () => {
  assert.match(pageSource, /<BaseLayout[\s\S]*?canonicalPath="\/headphones\/"/);
  assert.doesNotMatch(pageSource, /<BaseLayout[\s\S]*?canonicalPath="\/headphones"/);
});
