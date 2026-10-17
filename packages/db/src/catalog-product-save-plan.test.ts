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

test('ordinary status writes reject newly linked sources and pending supplier review atomically', () => {
  const input: CatalogProductSaveInput = {
    mode: 'update',
    productId: 'review-product',
    data: { published: true },
    rejectPendingReview: true,
    expectedPrimarySourceKey: null,
  };
  const unlinked = reviewProduct({
    alibabaPrimarySourceKey: undefined,
    alibabaReviewPending: undefined,
    imageIds: ['image'],
    description: 'Ready to publish',
  });
  assert.equal(planCatalogProductSave(unlinked, input, '2026-09-24T00:00:00.000Z').result, 'ready');
  for (const current of [
    { ...unlinked, alibabaPrimarySourceKey: 'source-a', alibabaReviewPending: null },
    { ...unlinked, alibabaPrimarySourceKey: 'source-a', alibabaReviewPending: true },
  ]) {
    assert.deepEqual(planCatalogProductSave(current, input, '2026-09-24T00:00:00.000Z'), {
      result: 'stale',
    });
  }
  assert.deepEqual(
    planCatalogProductSave(
      reviewProduct({ alibabaReviewPending: true }),
      { ...input, expectedPrimarySourceKey: 'source-a' },
      '2026-09-24T00:00:00.000Z',
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
  // A price saved on a published row reaches buyers only through the next
  // approval (MIU-31): the draft save is accepted, publishing it is not.
  const concurrent: CollectionDoc = { ...product, unitPrice: 4 };
  concurrent.catalogDetailApprovalReceipt = {
    contentFingerprint: publicationContentFingerprint(concurrent),
  };
  assert.equal(planCatalogProductSave(concurrent, input, 'now').result, 'ready');
  assert.equal(
    planCatalogProductSave(
      concurrent,
      { ...input, data: { ...input.data, published: true } },
      'now',
    ).result,
    'invalid-product',
  );
  assert.deepEqual(product, unchanged);
});

function manualProduct(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: 'manual-product',
    name: 'Manual headset',
    description: 'Typed by the admin',
    productFamily: 'headphones',
    imageIds: ['image'],
    series: 'S1',
    detailSourceOwner: 'manual:manual-product',
    published: false,
    archived: false,
    ...overrides,
  };
}
const publishManual: CatalogProductSaveInput = {
  mode: 'update',
  productId: 'manual-product',
  data: { published: true },
  requireDetailApproval: 'publication-or-pricing',
};
const approvedNow = (product: CollectionDoc): CollectionDoc => ({
  ...product,
  catalogDetailApprovalReceipt: { contentFingerprint: publicationContentFingerprint(product) },
});

test('publishing a manual product needs its approved version, like a synced one (MIU-31)', () => {
  const issues = planCatalogProductSave(manualProduct(), publishManual, 'now');
  assert.equal(issues.result, 'invalid-product');
  const approved = approvedNow(manualProduct());
  const published = planCatalogProductSave(approved, publishManual, 'now');
  assert.equal(published.result, 'ready');
  if (published.result === 'ready') assert.equal(published.doc.published, true);
  // A spec field edited after approval must be approved again (MIU-29).
  assert.equal(
    planCatalogProductSave({ ...approved, series: 'S2' }, publishManual, 'now').result,
    'invalid-product',
  );
  // Approval switched off: today's behaviour.
  const { requireDetailApproval: _off, ...ungated } = publishManual;
  assert.equal(planCatalogProductSave(manualProduct(), ungated, 'now').result, 'ready');
});

test('a leftover Headphones category cleared by the save does not block publishing an approved product', () => {
  // Approval fingerprinted the stored row, stale category included; the
  // publish write clears that category (legacy cleanup) and must still pass.
  const approved = approvedNow(manualProduct({ productFamily: 'toys', category: 'wired' }));
  const published = planCatalogProductSave(approved, publishManual, 'now');
  assert.equal(published.result, 'ready');
  if (published.result === 'ready') {
    assert.equal(published.doc.published, true);
    assert.equal(published.doc.category, '');
  }
  // Any other change still needs a new approval.
  assert.equal(
    planCatalogProductSave({ ...approved, name: 'Renamed' }, publishManual, 'now').result,
    'invalid-product',
  );
});

test('a price change saved on a published product waits for approval instead of being refused (MIU-31)', () => {
  for (const linked of [false, true]) {
    const product = approvedNow(
      manualProduct({
        published: true,
        ...(linked ? { alibabaPrimarySourceKey: 'source-a', detailSourceOwner: undefined } : {}),
      }),
    );
    const draft = planCatalogProductSave(
      product,
      {
        ...publishManual,
        data: {
          manualCatalogPricing: {
            schemaVersion: 'manual-catalog-pricing-v1',
            currency: 'USD',
            tiers: [{ minQuantity: 10, unitAmountMinor: 250 }],
          },
        },
      },
      'now',
    );
    assert.equal(draft.result, 'ready', linked ? 'synced' : 'manual');
    if (draft.result === 'ready') {
      assert.equal(draft.doc.published, true);
      assert.deepEqual(
        draft.doc.catalogDetailApprovalReceipt,
        product.catalogDetailApprovalReceipt,
      );
    }
  }
});

test('a new product cannot be created already published while approval is on (MIU-37)', () => {
  const create: CatalogProductSaveInput = {
    mode: 'create',
    productId: 'manual-product',
    data: { ...manualProduct({ published: true }) },
    requireDetailApproval: 'publication-or-pricing',
  };
  const refused = planCatalogProductSave(null, create, 'now');
  assert.equal(refused.result, 'invalid-product');
  if (refused.result === 'invalid-product')
    assert.match(refused.issues.map((issue) => issue.message).join(' '), /draft/i);
  const { published: _published, ...draftData } = manualProduct();
  const draft = planCatalogProductSave(null, { ...create, data: draftData }, 'now');
  assert.equal(draft.result, 'ready');
  if (draft.result === 'ready') assert.equal(draft.doc.published, false);
  const { requireDetailApproval: _off, ...ungated } = create;
  assert.equal(planCatalogProductSave(null, ungated, 'now').result, 'ready');
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

test('unrelated updates preserve legacy Headphones classification without an explicit family', () => {
  for (const category of ['wired', 'office', 'bluetooth']) {
    for (const data of [{ published: false }, { name: 'Updated headset' }]) {
      const existing: CollectionDoc = {
        _id: 'legacy-headset',
        name: 'Legacy headset',
        category,
        published: Object.hasOwn(data, 'published'),
        description: 'Ready for publication',
        imageIds: ['image'],
        wholesalePrice: 5.5,
        moq: 500,
      };
      const plan = planCatalogProductSave(
        existing,
        { mode: 'update', productId: existing._id, data },
        '2026-10-02T00:00:00.000Z',
      );
      assert.equal(plan.result, 'ready');
      if (plan.result !== 'ready') continue;
      assert.equal(plan.doc.category, category);
      assert.equal(plan.doc.productFamily, undefined);
      assert.deepEqual(plan.doc.imageIds, existing.imageIds);
      assert.equal(plan.doc.wholesalePrice, existing.wholesalePrice);
    }
  }
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

test('the photo job never changes a product approved, published or archived meanwhile (PT-G)', () => {
  const draft = manualProduct({
    alibabaPrimarySourceKey: 'source-a',
    detailSourceOwner: undefined,
  });
  const fill: CatalogProductSaveInput = {
    mode: 'update',
    productId: 'manual-product',
    data: { imageIds: ['copied'] },
    requireUnapprovedDraft: true,
  };
  assert.equal(planCatalogProductSave(draft, fill, 'now').result, 'ready');
  for (const changed of [
    { catalogDetailApprovalReceipt: { contentFingerprint: 'x' } },
    { published: true },
    { archived: true },
  ])
    assert.equal(planCatalogProductSave({ ...draft, ...changed }, fill, 'now').result, 'stale');
});

for (const stored of [undefined, null]) {
  test(`legacy opening revision remains guarded when stored updatedAt is ${stored}`, () => {
    const input: CatalogProductSaveInput = {
      mode: 'update',
      productId: 'review-product',
      data: { description: 'Operator edit' },
      expectedUpdatedAt: null,
    };
    const current = reviewProduct();
    Reflect.set(current, 'updatedAt', stored);
    assert.equal(
      planCatalogProductSave(current, input, '2026-10-13T00:00:00.000Z').result,
      'ready',
    );
    assert.deepEqual(
      planCatalogProductSave(
        { ...current, updatedAt: '2026-10-13T00:00:01.000Z' },
        input,
        '2026-10-13T00:00:02.000Z',
      ),
      { result: 'stale' },
    );
  });
}

function readyVersionedProduct(): CollectionDoc {
  return {
    _id: 'p',
    name: 'Before',
    description: 'Website description',
    productFamily: 'misc',
    imageIds: ['img'],
    unitPrice: 5,
    published: false,
    archived: false,
    detailSourceReady: true,
    catalogPreparationState: 'ready',
    catalogContentGeneration: 3,
    catalogLifecycleVersion: 4,
    catalogClassificationRevision: 2,
    catalogDetailPublication: { state: 'approved', revision: 'retained' },
    updatedAt: '2026-10-13T00:00:00.000Z',
  };
}
function savedVersion(current: CollectionDoc, data: Record<string, unknown>): CollectionDoc {
  const plan = planCatalogProductSave(
    current,
    { mode: 'update', productId: current._id, data },
    '2026-10-13T00:00:00.000Z',
  );
  assert.equal(plan.result, 'ready');
  if (plan.result !== 'ready') throw new Error('Unexpected save refusal');
  return plan.doc;
}
for (const patch of [
  { name: 'After' },
  { description: 'After' },
  { imageIds: ['other'] },
  { configurationPhotos: { sku: ['img'] } },
  { supplierDecisions: { description: { choice: 'keep', incomingDigest: 'a'.repeat(64) } } },
  { unitPrice: 6 },
  { series: 'After' },
]) {
  test(`ordinary content save invalidates preparation atomically: ${Object.keys(patch)[0]}`, () => {
    const before = readyVersionedProduct();
    const after = savedVersion(before, patch);
    assert.equal(after.catalogContentGeneration, 4);
    assert.equal(after.detailSourceReady, false);
    assert.equal(after.catalogPreparationState, 'stale');
    assert.equal(after.catalogLifecycleVersion, 4);
    assert.equal(after.catalogDetailPublication, before.catalogDetailPublication);
    assert.equal(before.detailSourceReady, true);
  });
}
test('ordinary same-millisecond ABA cannot restore the old generation', () => {
  const before = readyVersionedProduct();
  const changed = savedVersion(before, { name: 'After' });
  const reverted = savedVersion(changed, { name: 'Before' });
  assert.equal(reverted.catalogContentGeneration, 5);
  assert.equal(reverted.updatedAt, '2026-10-13T00:00:00.002Z');
});
test('publication lifecycle advances independently and detects toggle ABA', () => {
  const before = readyVersionedProduct();
  const live = savedVersion(before, { published: true });
  const withdrawn = savedVersion(live, { published: false });
  assert.equal(live.catalogLifecycleVersion, 5);
  assert.equal(withdrawn.catalogLifecycleVersion, 6);
  assert.equal(withdrawn.catalogContentGeneration, 3);
  assert.equal(withdrawn.detailSourceReady, true);
});
test('subcategory changes advance classification without invalidating website content', () => {
  const before = readyVersionedProduct();
  const after = savedVersion(before, { subcategoryIds: ['leaf'] });
  assert.equal(after.catalogClassificationRevision, 3);
  assert.equal(after.catalogContentGeneration, 3);
  assert.equal(after.detailSourceReady, true);
});
test('semantic no-op and capture metadata do not invalidate preparation', () => {
  const before = readyVersionedProduct();
  const after = savedVersion(before, {
    name: 'Before',
    imageIds: ['img'],
    alibabaSourceLastSyncedAt: 'later',
  });
  assert.equal(after.catalogContentGeneration, 3);
  assert.equal(after.detailSourceReady, true);
});

test('a supplier price capture timestamp alone does not invalidate ready content', () => {
  const before = readyVersionedProduct();
  before.alibabaCatalogPricing = {
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 500,
    syncedAt: '2026-10-12T00:00:00.000Z',
  };
  const after = savedVersion(before, {
    alibabaCatalogPricing: {
      mode: 'fixed',
      currency: 'USD',
      amountMinor: 500,
      syncedAt: '2026-10-13T00:00:00.000Z',
    },
  });
  assert.equal(after.catalogContentGeneration, 3);
  assert.equal(after.detailSourceReady, true);
});

test('ordinary writes cannot restore preparation output from an old snapshot', () => {
  const before = {
    ...readyVersionedProduct(),
    detailSourceReady: false,
    catalogPreparationState: 'stale',
  };
  const after = savedVersion(before, {
    detailSourceReady: true,
    catalogPreparationState: 'ready',
    catalogContentGeneration: 1,
  });
  assert.equal(after.detailSourceReady, false);
  assert.equal(after.catalogPreparationState, 'stale');
  assert.equal(after.catalogContentGeneration, 3);
});
test('an empty offer selection is semantically the same as an absent selection', () => {
  const before = readyVersionedProduct();
  const after = savedVersion(before, { alibabaPinnedOfferKey: '' });
  assert.equal(after.catalogContentGeneration, 3);
  assert.equal(after.detailSourceReady, true);
});

for (const [field, patch] of [
  ['catalogContentGeneration', { name: 'After' }],
  ['catalogLifecycleVersion', { published: true }],
  ['catalogClassificationRevision', { subcategoryIds: ['leaf'] }],
] as const) {
  for (const value of [-1, 1.5, '1', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    test(`${field} cannot be corrupt or wrap on its transition (${value})`, () => {
      const before = readyVersionedProduct();
      before[field] = value;
      const plan = planCatalogProductSave(
        before,
        { mode: 'update', productId: before._id, data: patch },
        '2026-10-13T00:00:01.000Z',
      );
      assert.equal(plan.result, 'invalid-product');
      assert.equal(before.detailSourceReady, true);
    });
  }
}

for (const patch of [
  { published: false },
  { archived: true },
  { published: false, archived: true },
])
  test(`explicit withdrawal cancels pending publication even in the same state: ${JSON.stringify(patch)}`, () => {
    const before: CollectionDoc = { ...readyVersionedProduct(), archived: patch.archived === true };
    const after = savedVersion(before, patch);
    assert.equal(after.catalogLifecycleVersion, 5);
    assert.equal(after.catalogContentGeneration, 3);
    assert.equal(after.detailSourceReady, true);
    assert.equal(after.catalogDetailPublication, before.catalogDetailPublication);
    assert.equal(after.published, false);
    const repeated = savedVersion(after, patch);
    assert.equal(repeated.catalogLifecycleVersion, 6);
    assert.equal(before.catalogLifecycleVersion, 4);
  });
test('legacy missing publication state is fenced by explicit Disable without fabricating live state', () => {
  const before = readyVersionedProduct();
  Reflect.deleteProperty(before, 'published');
  Reflect.deleteProperty(before, 'catalogLifecycleVersion');
  const unchanged = savedVersion(before, { alibabaSourceLastSyncedAt: 'capture' });
  assert.equal(Object.hasOwn(unchanged, 'published'), false);
  assert.equal(Object.hasOwn(unchanged, 'catalogLifecycleVersion'), false);
  const disabled = savedVersion(before, { published: false });
  assert.equal(disabled.catalogLifecycleVersion, 1);
  assert.equal(disabled.published, false);
  assert.equal(disabled.catalogContentGeneration, 3);
  assert.equal(disabled.detailSourceReady, true);
});
test('same-state withdrawal refuses an exhausted version instead of accepting an ineffective barrier', () => {
  const before = { ...readyVersionedProduct(), catalogLifecycleVersion: Number.MAX_SAFE_INTEGER };
  const result = planCatalogProductSave(
    before,
    { mode: 'update', productId: before._id, data: { published: false } },
    '2026-10-18T00:00:00.000Z',
  );
  assert.equal(result.result, 'invalid-product');
  assert.equal(before.catalogLifecycleVersion, Number.MAX_SAFE_INTEGER);
});

test('ordinary draft saves and same-live saves do not invent withdrawal commands', () => {
  for (const [current, patch] of [
    [readyVersionedProduct(), {}],
    [readyVersionedProduct(), { archived: false }],
    [{ ...readyVersionedProduct(), published: true }, { published: true }],
  ] as const) {
    assert.equal(savedVersion(current, patch).catalogLifecycleVersion, 4);
  }
  const initial = planCatalogProductSave(
    null,
    {
      mode: 'create',
      productId: 'new',
      data: { name: 'Clock', productFamily: 'misc', published: false, archived: true },
    },
    '2026-10-18T00:00:00.000Z',
  );
  assert.equal(initial.result, 'ready');
  if (initial.result === 'ready') assert.equal(initial.doc.catalogLifecycleVersion, 0);
});
