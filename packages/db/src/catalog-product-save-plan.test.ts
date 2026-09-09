import { strict as assert } from 'node:assert';
import test from 'node:test';
import { planCatalogProductSave } from './adapter.ts';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';

test('publication requires the exact reviewed website content inside the atomic save, including concurrent edits', () => {
  const product = {
    _id: 'linked',
    name: 'Headset',
    description: 'Reviewed description',
    productFamily: 'headphones',
    imageIds: ['image'],
    published: false,
    archived: false,
    alibabaPrimarySourceKey: 'source',
  };
  const input = {
    mode: 'update' as const,
    productId: 'linked',
    data: { published: true },
    requireDetailApproval: true,
  };
  assert.equal(planCatalogProductSave(product, input, 'now').result, 'invalid-product');
  const approved = {
    ...product,
    catalogDetailApprovalReceipt: { contentFingerprint: publicationContentFingerprint(product) },
  };
  assert.equal(planCatalogProductSave(approved, input, 'now').result, 'ready');
  for (const patch of [
    { name: 'Changed' },
    { imageIds: ['other'] },
    { productFamily: 'toys' },
    { unitPrice: 20 },
    { detailSourceRevision: 'new' },
  ]) {
    assert.equal(
      planCatalogProductSave({ ...approved, ...patch }, input, 'now').result,
      'invalid-product',
    );
  }
  assert.equal(
    planCatalogProductSave({ ...approved, published: true }, input, 'now').result,
    'ready',
  );
});

test('an unrelated update clears stale non-Headphones subcategory in the atomic save plan', () => {
  const now = '2026-08-21T00:00:00.000Z';
  const plan = planCatalogProductSave(
    {
      _id: 'toy-1',
      name: 'Legacy toy',
      productFamily: 'toys',
      category: 'wired',
      published: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      mode: 'update',
      productId: 'toy-1',
      data: {
        manualCatalogPricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
        },
      },
    },
    '2026-08-21T01:00:00.000Z',
  );
  assert.equal(plan.result, 'ready');
  if (plan.result !== 'ready') return;
  assert.equal(plan.doc.category, '');
  assert.deepEqual(plan.doc.manualCatalogPricing, {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
  });
});
