import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Source-of-truth markdown (the i18n loader needs Vite's import.meta.glob, which
// isn't available under `tsx --test`), so we assert the brand config directly.
const enUS = readFileSync(fileURLToPath(new URL('./content/en-US.md', import.meta.url)), 'utf8');

test('brand.logo points to the real Diversity logo, not the placeholder', () => {
  const match = enUS.match(/^\s*logo:\s*(\S+)\s*$/m);
  assert.ok(match, 'brand.logo is defined');
  assert.equal(match[1], '/media/logo-diversity.svg');
  assert.ok(!enUS.includes('logo-channel.svg'), 'placeholder logo no longer referenced');
});

test('the referenced brand logo asset exists in public/media', () => {
  const asset = fileURLToPath(new URL('../../public/media/logo-diversity.svg', import.meta.url));
  assert.ok(existsSync(asset), 'logo-diversity.svg present in public/media');
});
