import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  type AlibabaProductLinkIdentity,
  runAlibabaProductMutation,
} from './alibaba-product-identity.ts';

for (const action of ['pin', 'unlink'] as const) {
  test(`Alibaba ${action} invalidates preparation and preserves monotonic time`, async () => {
    const now = '2026-10-13T00:00:00.000Z';
    const link: AlibabaProductLinkIdentity = {
      _id: 'source',
      sourceKey: 'source',
      connectionId: 'connection',
      sourceProductId: 'external',
      productId: 'p',
      linkedAt: now,
    };
    const buckets: Record<string, Record<string, CollectionDoc>> = {
      products: {
        p: {
          _id: 'p',
          name: 'Before',
          productFamily: 'misc',
          alibabaPrimarySourceKey: 'source',
          alibabaLinkRevision: 1,
          alibabaPinnedOfferKey: 'previous-offer',
          catalogContentGeneration: 3,
          catalogLifecycleVersion: 2,
          detailSourceReady: true,
          published: true,
          updatedAt: '2026-10-13T00:00:00.010Z',
        },
      },
      alibabaProductLinks: { source: { ...link } },
      alibabaSourceProducts: {
        source: {
          _id: 'source',
          connectionId: 'connection',
          sourceProductId: 'external',
          active: true,
        },
      },
    };
    const tx = {
      get: async (c: string, id: string) => buckets[c]?.[id] ?? null,
      set: async (c: string, row: CollectionDoc) => {
        buckets[c] ??= {};
        buckets[c][row._id] = row;
      },
      remove: async (c: string, id: string) => {
        if (buckets[c]) delete buckets[c][id];
      },
    };
    const base = {
      productId: 'p',
      expectedRevision: 1,
      expectedPrimarySourceKey: 'source',
      expectedLinks: [link],
      now,
    };
    const input =
      action === 'pin'
        ? { ...base, action, sourceKey: 'source', offerKey: '' }
        : { ...base, action };
    const result = await runAlibabaProductMutation(tx, [{ ...link }], input);
    assert.equal(result.ok, true);
    const saved = buckets.products?.p;
    assert.ok(saved);
    assert.equal(saved.catalogContentGeneration, 4);
    assert.equal(saved.catalogLifecycleVersion, 2);
    assert.equal(saved.detailSourceReady, false);
    assert.equal(saved.published, true);
    assert.equal(saved.updatedAt, '2026-10-13T00:00:00.011Z');
  });
}
