import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogWebObjectPath } from '@vibelingan-channel/shared/catalog-media-protection';
import { objectStoragePath } from './index.ts';
import { assertBrowserWritableMediaPath } from './protected-path.ts';
test('internal web image paths are content addressed and unavailable to browser uploads', () => {
  const path = catalogWebObjectPath('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64));
  assert.equal(
    objectStoragePath({
      namespace: 'catalog-web',
      logicalId: 'a'.repeat(64),
      fileName: `${'b'.repeat(64)}-${'c'.repeat(64)}.webp`,
    }),
    path,
  );
  assert.throws(() => assertBrowserWritableMediaPath(path), /Reserved/);
  assert.throws(
    () =>
      objectStoragePath({
        namespace: 'catalog-web',
        logicalId: '../source',
        fileName: `${'b'.repeat(64)}-${'c'.repeat(64)}.webp`,
      }),
    /identity/,
  );
  assert.throws(
    () =>
      objectStoragePath({
        namespace: 'catalog-web',
        logicalId: 'a'.repeat(64),
        fileName: 'original.png',
      }),
    /filename/,
  );
  assert.doesNotThrow(() => assertBrowserWritableMediaPath('catalog/2026/11/item/original.png'));
});
