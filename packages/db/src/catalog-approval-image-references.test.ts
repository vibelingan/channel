import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { planApprovalImageReferences } from './catalog-approval-image-references.ts';
import {
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';

test('unchanged shared references consume no additional document budget even with160pending entries', async () => {
  const images = ['shared-one', 'shared-two'].map((id) => ({
    _id: id,
    publishedRefCount: 1,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: Array.from({ length: 80 }, (_, i) =>
        catalogImageReferenceEntry(
          buildCatalogImageReferencePlan(
            createHash('sha256').update(`${id}:${i}`).digest('hex'),
            [],
            [id],
          ),
          0,
        ),
      ),
    },
  }));
  const before = structuredClone(images);
  const result = await planApprovalImageReferences(
    {
      get: async () => {
        assert.fail('unchanged references must not read terminal proofs');
      },
      set: async () => {
        assert.fail('planning must be readonly');
      },
    },
    images,
    () => 0,
    0,
  );
  assert.deepEqual(result, { ok: true, images: images.map((image) => ({ image, delta: 0 })) });
  assert.deepEqual(images, before);
});

test('changed references reserve both image rereads before any terminal proof read', async () => {
  const images = [
    { id: 'old-sku', count: 48, base: 1 },
    { id: 'new-sku', count: 40, base: 0 },
  ].map(({ id, count, base }) => ({
    _id: id,
    publishedRefCount: base,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending: Array.from({ length: count }, (_, i) =>
        catalogImageReferenceEntry(
          buildCatalogImageReferencePlan(
            createHash('sha256').update(`${id}:${i}`).digest('hex'),
            [],
            [id],
          ),
          0,
        ),
      ),
    },
  }));
  const before = structuredClone(images);
  const result = await planApprovalImageReferences(
    {
      get: async () => {
        assert.fail('90 additional reads cannot fit remaining88');
      },
      set: async () => {
        assert.fail('planning must be readonly');
      },
    },
    images,
    (id) => (id === 'old-sku' ? -1 : 1),
    88,
  );
  assert.deepEqual(result, { ok: false, code: 'APPROVAL_TOO_LARGE' });
  assert.deepEqual(images, before);
});
