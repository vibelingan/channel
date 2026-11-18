import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogImagePresentationSchema } from './image-presentation.ts';

test('presentation keeps source identity, unique real dimensions and a fixed width request', () => {
  const source = '/api/images/photo';
  const valid = { [source]: [{ url: `${source}?w=1280`, width: 800, height: 400 }] };
  assert.ok(CatalogImagePresentationSchema.safeParse(valid).success);
  for (const candidates of [
    [{ url: '/api/images/other?w=160', width: 160, height: 100 }],
    [{ url: `${source}?w=320`, width: 320, height: 200 }],
    [{ url: `${source}?w=160`, width: 1280, height: 800 }],
    [{ ...valid[source][0], storageFileId: 'private' }],
    [...valid[source], ...valid[source]],
  ])
    assert.equal(CatalogImagePresentationSchema.safeParse({ [source]: candidates }).success, false);
});
