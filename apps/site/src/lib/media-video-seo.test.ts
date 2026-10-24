import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const componentSource = readFileSync(
  fileURLToPath(new URL('../components/MediaVideo.astro', import.meta.url)),
  'utf8',
);
const oemContentModel = readFileSync(
  fileURLToPath(new URL('../i18n/oem.ts', import.meta.url)),
  'utf8',
);

test('video and poster-only fallbacks reserve the poster intrinsic dimensions', () => {
  assert.match(componentSource, /posterWidth: number;/);
  assert.match(componentSource, /posterHeight: number;/);
  assert.match(oemContentModel, /posterWidth: number;/);
  assert.match(oemContentModel, /posterHeight: number;/);
  const imageTags = [...componentSource.matchAll(/<img[\s\S]*?\/>/g)].map(([tag]) => tag);
  assert.equal(imageTags.length, 2);
  for (const imageTag of imageTags) {
    assert.match(imageTag, /width=\{posterWidth\}/);
    assert.match(imageTag, /height=\{posterHeight\}/);
  }
});
