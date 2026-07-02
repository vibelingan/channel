import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const enUS = readFileSync(
  fileURLToPath(new URL('./content/en-US.md', import.meta.url)),
  'utf8',
);

test('home "Who we are" section uses the real team photo', () => {
  assert.ok(enUS.includes('/media/team-diversity.webp'), 'heritage image is the team photo');
  assert.ok(
    !enUS.includes('/media/section-heritage.png'),
    'placeholder heritage illustration no longer referenced',
  );
});

test('every /media asset referenced by en-US content exists in public/', () => {
  const refs = [...enUS.matchAll(/(?:image|logo):\s*(\/media\/\S+)/g)].map((m) => m[1]);
  assert.ok(refs.length > 0, 'found media references');
  for (const ref of refs) {
    const file = fileURLToPath(new URL(`../../public${ref}`, import.meta.url));
    assert.ok(existsSync(file), `referenced asset missing on disk: ${ref}`);
  }
});
