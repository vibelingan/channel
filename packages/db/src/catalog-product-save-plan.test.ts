import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type CatalogProductSaveInput, planCatalogProductSave } from './adapter.ts';
import { publicationContentFingerprint } from './catalog-publication-fingerprint.ts';

function reviewProduct(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'review-product',
    name: 'Headset',
    productFamily: 'headphones',
    published: false,
    archived: false,
    alibabaPrimarySourceKey: 'source-a',
    alibabaLinkRevision: 1,
    alibabaReviewPending: true,
    ...overrides,
  };
}

function reviewSave(overrides: Partial<CatalogProductSaveInput> = {}): CatalogProductSaveInput {
  return {
    mode: 'update',
    productId: 'review-product',
    data: {
      alibabaReviewPending: false,
      alibabaReviewedAt: '2026-09-15T01:00:00.000Z',
      alibabaReviewedByUserId: 'admin-a',
    },
    expectedAlibabaIdentity: { revision: 1, primarySourceKey: 'source-a' },
    ...overrides,
  };
}

test('classification publication rejects a concurrent product edit inside the save transaction', () => {
  const { expectedAlibabaIdentity: _identity, ...input } = reviewSave({
    data: { published: true },
    expectedUpdatedAt: '2026-09-24T00:00:00.000Z',
  });
  const current = reviewProduct({
    alibabaPrimarySourceKey: undefined,
    alibabaReviewPending: false,
    description: 'Ready for publication',
    imageIds: ['image'],
    unitPrice: 5.7,
    updatedAt: '2026-09-24T00:00:00.000Z',
  });
  assert.equal(planCatalogProductSave(current, input, '2026-09-24T00:01:00.000Z').result, 'ready');
  assert.deepEqual(
    planCatalogProductSave(
      { ...current, updatedAt: '2026-09-24T00:00:30.000Z' },
      input,
      '2026-09-24T00:01:00.000Z',
    ),
    { result: 'stale' },
  );
});

test('Alibaba review CAS checks revision and primary source independently before validation or identities', () => {
  for (const product of [
    reviewProduct({ alibabaLinkRevision: 2 }),
    reviewProduct({ alibabaPrimarySourceKey: 'source-b' }),
    reviewProduct({ alibabaPrimarySourceKey: null }),
    reviewProduct({ alibabaLinkRevision: '1' }),
    reviewProduct({ alibabaLinkRevision: null }),
    reviewProduct({ alibabaLinkRevision: -1 }),
    reviewProduct({ alibabaLinkRevision: 1.5 }),
    null,
  ]) {
    const input = reviewSave({ data: { ...reviewSave().data, published: true, slug: {} } });
    const snapshot = structuredClone(product);
    assert.deepEqual(planCatalogProductSave(product, input, 'now'), {
      result: 'alibaba-identity-conflict',
    });
    assert.deepEqual(product, snapshot);
  }
  assert.deepEqual(
    planCatalogProductSave(
      reviewProduct({ alibabaLinkRevision: null }),
      reviewSave({ expectedAlibabaIdentity: { revision: null, primarySourceKey: 'source-a' } }),
      'now',
    ),
    { result: 'alibaba-identity-conflict' },
  );
});

test('Alibaba review CAS accepts legacy revision zero and leaves unguarded updates unchanged', () => {
  const product = reviewProduct({ alibabaLinkRevision: undefined });
  const result = planCatalogProductSave(
    product,
    reviewSave({ expectedAlibabaIdentity: { revision: 0, primarySourceKey: 'source-a' } }),
    'now',
  );
  assert.equal(result.result, 'ready');
  if (result.result !== 'ready') return;
  assert.equal(result.doc.alibabaReviewPending, false);
  assert.equal(result.doc.alibabaReviewedByUserId, 'admin-a');
  assert.equal(result.doc.alibabaLinkRevision, undefined);
  const { expectedAlibabaIdentity: _expectation, ...input } = reviewSave({
    data: { name: 'Ordinary edit' },
  });
  for (const stored of [product, reviewProduct({ alibabaLinkRevision: 'corrupt' })]) {
    const ordinary = planCatalogProductSave(stored, input, 'now');
    assert.equal(ordinary.result, 'ready');
    if (ordinary.result === 'ready') {
      assert.equal(ordinary.doc.name, 'Ordinary edit');
      assert.equal(ordinary.doc.alibabaReviewPending, true);
      assert.equal(ordinary.doc.alibabaReviewedAt, undefined);
    }
  }
  assert.deepEqual(planCatalogProductSave(null, input, 'now'), { result: 'missing' });
});

test('Alibaba review CAS preserves the first acknowledgement and rejects relinks even after review', () => {
  const product = reviewProduct({
    alibabaReviewPending: false,
    alibabaReviewedAt: '2026-09-15T00:00:00.000Z',
    alibabaReviewedByUserId: 'first-admin',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
  const result = planCatalogProductSave(product, reviewSave(), 'later');
  assert.equal(result.result, 'ready');
  if (result.result !== 'ready') return;
  assert.deepEqual(result.doc, product);
  const archive = planCatalogProductSave(
    product,
    reviewSave({ data: { ...reviewSave().data, archived: true } }),
    'later',
  );
  assert.equal(archive.result, 'ready');
  if (archive.result !== 'ready') return;
  assert.equal(archive.doc.archived, true);
  assert.equal(archive.doc.alibabaReviewedAt, product.alibabaReviewedAt);
  assert.equal(archive.doc.alibabaReviewedByUserId, 'first-admin');
  assert.deepEqual(
    planCatalogProductSave({ ...product, alibabaLinkRevision: 2 }, reviewSave(), 'later'),
    { result: 'alibaba-identity-conflict' },
  );
});

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
    { descriptionImageIds: ['new-detail'] },
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

test('admin save scope compares pricing against the current atomic row, not an earlier form read', () => {
  const product = reviewProduct({
    published: true,
    description: 'Reviewed product description',
    imageIds: ['image'],
    unitPrice: 3,
    moq: 5,
    manualCatalogPricing: {
      schemaVersion: 'manual-catalog-pricing-v1',
      currency: 'USD',
      tiers: [{ minQuantity: 5, unitAmountMinor: 300 }],
    },
  });
  product.catalogDetailApprovalReceipt = {
    contentFingerprint: publicationContentFingerprint(product),
  };
  const input: CatalogProductSaveInput = {
    mode: 'update',
    productId: product._id,
    requireDetailApproval: 'publication-or-pricing',
    data: {
      productFamily: 'misc',
      unitPrice: 3,
      moq: 5,
      manualCatalogPricing: structuredClone(product.manualCatalogPricing),
    },
  };
  const unchanged = structuredClone(product);
  const result = planCatalogProductSave(product, input, 'now');
  assert.equal(result.result, 'ready');
  if (result.result === 'ready') {
    assert.equal(result.doc.published, true);
    assert.equal(result.doc.alibabaReviewPending, true);
    assert.deepEqual(result.doc.catalogDetailApprovalReceipt, product.catalogDetailApprovalReceipt);
  }
  assert.equal(
    planCatalogProductSave(product, { ...input, requireDetailApproval: true }, 'now').result,
    'invalid-product',
  );
  assert.equal(
    planCatalogProductSave(product, { ...input, data: { ...input.data, published: true } }, 'now')
      .result,
    'invalid-product',
  );
  const concurrent: CollectionDoc = { ...product, unitPrice: 4 };
  concurrent.catalogDetailApprovalReceipt = {
    contentFingerprint: publicationContentFingerprint(concurrent),
  };
  assert.equal(planCatalogProductSave(concurrent, input, 'now').result, 'invalid-product');
  assert.deepEqual(product, unchanged);
});

test('adding optional description media leaves historical publication receipts unchanged until edited', () => {
  const product = { _id: 'historical', name: 'Historical', description: 'Text', imageIds: ['old'] };
  assert.equal(
    publicationContentFingerprint(product),
    publicationContentFingerprint({ ...product, descriptionImageIds: undefined }),
  );
  assert.notEqual(
    publicationContentFingerprint(product),
    publicationContentFingerprint({ ...product, descriptionImageIds: ['detail'] }),
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
