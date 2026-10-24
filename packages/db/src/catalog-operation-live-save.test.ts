import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { planCatalogProductSave } from './adapter.ts';
import type { CatalogApprovalTransaction } from './catalog-detail-commit.ts';
import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  runCatalogImageReferenceRead,
} from './catalog-image-reference-store.ts';
import { buildCatalogImageReferencePlan } from './catalog-image-references.ts';
import {
  advanceLiveSaveReferences,
  planLiveSaveReferencePage,
  prepareLiveSaveReferences,
  readLiveSaveReferences,
} from './catalog-operation-live-save.ts';
const now = '2026-10-20T00:00:00.000Z';
const root = 'a'.repeat(64);
function fixture(variants = 0) {
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Clock',
    productFamily: 'misc',
    published: true,
    archived: false,
    imageIds: ['old', 'shared'],
    descriptionImageIds: ['description'],
    updatedAt: now,
    catalogDetailPublication: {
      header: { images: [{ id: 'approved' }] },
      variantImageIds: Array.from({ length: variants }, (_, i) => `sku${i}`),
    },
  };
  const owner = {
    _id: root,
    productId: 'p',
    createdAt: now,
    operation: {
      intent: 'refresh-live',
      inputDigest: 'b'.repeat(64),
      expectedUpdatedAt: now,
      base: {},
      policy: {},
      values: { imageIds: ['new', 'shared'] } as Record<string, unknown>,
    },
  };
  return { product, owner };
}
function image(id: string, extra: Record<string, unknown> = {}): CollectionDoc {
  return {
    _id: id,
    status: 'active',
    storageProvider: 'local-disk',
    storageFileId: id,
    mimeType: 'image/png',
    byteSize: 10,
    checksumSha256: 'c'.repeat(64),
    publishedRefCount: 0,
    ...extra,
  };
}
function store(images: CollectionDoc[]) {
  const rows = new Map(images.map((row) => [`images/${row._id}`, structuredClone(row)]));
  let reads = 0;
  const tx: CatalogApprovalTransaction = {
    get: async (collection, id) => {
      reads++;
      return structuredClone(rows.get(`${collection}/${id}`) ?? null);
    },
    set: async (collection, row) => {
      rows.set(`${collection}/${row._id}`, structuredClone(row));
    },
  };
  return { tx, rows, reads: () => reads };
}
for (const size of [0, 105, 10000])
  test(`live row save keeps unchanged approval/${size} configuration references without copying them`, () => {
    const h = fixture(size);
    const before = JSON.stringify(h.product);
    const refs = prepareLiveSaveReferences(h.owner, h.product);
    assert.ok(refs);
    assert.deepEqual(refs.changes, [
      { imageId: 'new', delta: 1 },
      { imageId: 'old', delta: -1 },
    ]);
    assert.ok(Buffer.byteLength(JSON.stringify(refs)) < 1024);
    assert.equal(JSON.stringify(h.product), before);
    const read = readLiveSaveReferences(h.owner, refs);
    assert.ok(read);
    assert.equal(read.plan.proof.operationRootId, root);
    const advanced = advanceLiveSaveReferences(h.owner, refs, 2);
    assert.equal(readLiveSaveReferences(h.owner, advanced)?.references.cursor, 2);
    assert.throws(() => advanceLiveSaveReferences(h.owner, advanced, 1));
  });
test('live save handles the full historical 36-to-27 raw image change without storing 10000 approval IDs', () => {
  const h = fixture(10000);
  h.product.imageIds = Array.from({ length: 18 }, (_, i) => `oldGallery${i}`);
  h.product.descriptionImageIds = Array.from({ length: 18 }, (_, i) => `oldDescription${i}`);
  h.owner.operation.values = {
    imageIds: Array.from({ length: 9 }, (_, i) => `newGallery${i}`),
    descriptionImageIds: Array.from({ length: 18 }, (_, i) => `newDescription${i}`),
  };
  const refs = prepareLiveSaveReferences(h.owner, h.product);
  assert.ok(refs);
  assert.equal(refs.changes.length, 63);
  assert.ok(Buffer.byteLength(JSON.stringify(refs)) < 16 * 1024);
});
test('clearing manual pricing on a live row does not withdraw it or expose a new publication', () => {
  const h = fixture();
  h.owner.operation.values = { manualCatalogPricing: null };
  const plan = planCatalogProductSave(
    h.product,
    { mode: 'update', productId: 'p', expectedUpdatedAt: now, data: h.owner.operation.values },
    now,
    { clearManualPricing: true },
  );
  assert.equal(plan.result, 'ready');
  if (plan.result !== 'ready') return;
  assert.equal(plan.doc.manualCatalogPricing, '');
  assert.equal(plan.doc.published, true);
  assert.deepEqual(plan.doc.catalogDetailPublication, h.product.catalogDetailPublication);
});
for (const change of [
  'wrong-owner',
  'wrong-product',
  'wrong-input',
  'wrong-base',
  'wrong-policy',
  'wrong-intent',
  'cursor',
  'duplicate',
  'reverse',
  'extra',
] as const)
  test(`bounded live save binding rejects ${change}`, () => {
    const h = fixture();
    const refs = prepareLiveSaveReferences(h.owner, h.product);
    assert.ok(refs);
    const value: Record<string, unknown> = structuredClone(refs);
    if (change === 'wrong-owner') h.owner._id = 'd'.repeat(64);
    if (change === 'wrong-product') h.owner.productId = 'other';
    if (change === 'wrong-input') h.owner.operation.inputDigest = 'd'.repeat(64);
    if (change === 'wrong-base') h.owner.operation.base = { contentGeneration: 1 };
    if (change === 'wrong-policy') h.owner.operation.policy = { pixels: 'next' };
    if (change === 'wrong-intent') h.owner.operation.intent = 'publish';
    if (change === 'cursor') value.cursor = 2;
    if (change === 'duplicate') value.changes = [...refs.changes, refs.changes[0]];
    if (change === 'reverse') value.changes = [...refs.changes].reverse();
    if (change === 'extra') value.untrusted = true;
    assert.equal(readLiveSaveReferences(h.owner, value), null);
  });
for (const patch of [
  { published: false },
  { archived: true },
  { _id: 'other' },
  { updatedAt: '2026-10-19T00:00:00.000Z' },
])
  test(`live reference preparation rejects stale or withdrawn product ${JSON.stringify(patch)}`, () => {
    const h = fixture();
    assert.equal(prepareLiveSaveReferences(h.owner, { ...h.product, ...patch }), null);
  });
test('pending live row references do not grant public image rights before atomic proof', async () => {
  const h = fixture();
  const refs = prepareLiveSaveReferences(h.owner, h.product);
  assert.ok(refs);
  const read = readLiveSaveReferences(h.owner, refs);
  assert.ok(read);
  // Broken removed bytes are not a reason to prevent their removal.
  const db = store([
    image('new', { imageMutationOwner: root, imageMutationStartedAt: now }),
    { _id: 'old', publishedRefCount: 1 },
  ]);
  const page = await planLiveSaveReferencePage(db.tx, read.plan, 0, root, 90, Date.parse(now));
  assert.ok(page.ok, JSON.stringify(page));
  assert.equal(page.nextCursor, 2);
  for (const row of page.images) await db.tx.set('images', row);
  const before = await runCatalogImageReferenceRead(db.tx, { action: 'read', imageId: 'new' });
  assert.equal(before.state === 'counted' && before.effectiveCount, 0);
  await db.tx.set('catalogDetailApprovals', read.plan.proof);
  const after = await runCatalogImageReferenceRead(db.tx, { action: 'read', imageId: 'new' });
  const old = await runCatalogImageReferenceRead(db.tx, { action: 'read', imageId: 'old' });
  assert.equal(after.state === 'counted' && after.effectiveCount, 1);
  assert.equal(old.state === 'counted' && old.effectiveCount, 0);
});
test('raw reference stage stops at its actual document budget and resumes without doubling deltas', async () => {
  const plan = buildCatalogImageReferencePlan(root, [], ['a', 'b', 'c']);
  const db = store(['a', 'b', 'c'].map((id) => image(id)));
  let cursor = 0;
  while (cursor < 3) {
    const beforeReads = db.reads();
    const page = await planLiveSaveReferencePage(db.tx, plan, cursor, root, 2, Date.parse(now));
    assert.ok(page.ok, JSON.stringify(page));
    assert.equal(page.nextCursor, cursor + 1);
    assert.ok(db.reads() - beforeReads + page.images.length <= 2);
    for (const row of page.images) await db.tx.set('images', row);
    cursor = page.nextCursor;
  }
  const replay = await planLiveSaveReferencePage(db.tx, plan, 0, root, 90, Date.parse(now));
  assert.ok(replay.ok);
  assert.equal(replay.images.length, 0);
  await db.tx.set('catalogDetailApprovals', plan.proof);
  for (const id of ['a', 'b', 'c']) {
    const row = await runCatalogImageReferenceRead(db.tx, { action: 'read', imageId: id });
    assert.equal(row.state === 'counted' && row.effectiveCount, 1);
  }
});
for (const [extra, code] of [
  [{ imageMutationOwner: 'other', imageMutationStartedAt: now }, 'MEDIA_BUSY'],
  [
    { imageMutationOwner: root, imageMutationStartedAt: '2026-10-19T00:00:00.000Z' },
    'MEDIA_NOT_READY',
  ],
  [
    { imageMutationOwner: root, imageMutationStartedAt: '2026-10-20T00:01:00.000Z' },
    'MEDIA_NOT_READY',
  ],
  [{ imageMutationOwner: root }, 'MEDIA_NOT_READY'],
  [{ status: 'deleted' }, 'MEDIA_NOT_READY'],
  [{ publishedRefCount: '1' }, 'MEDIA_NOT_READY'],
  [{ storageFileId: '' }, 'MEDIA_NOT_READY'],
] as const)
  test(`new row image fails closed for ${JSON.stringify(extra)}`, async () => {
    const db = store([image('new', extra)]);
    const plan = buildCatalogImageReferencePlan(root, [], ['new']);
    const page = await planLiveSaveReferencePage(db.tx, plan, 0, root, 90, Date.parse(now));
    assert.equal(page.ok, false);
    assert.equal(!page.ok && page.code, code);
    assert.equal(db.rows.get('images/new')?.[CATALOG_IMAGE_REFERENCE_LEDGER_FIELD], undefined);
  });

test('a corrupt zero base cannot commit a live reference removal into a negative public count', async () => {
  const db = store([{ _id: 'old', publishedRefCount: 0 }]);
  const page = await planLiveSaveReferencePage(
    db.tx,
    buildCatalogImageReferencePlan(root, ['old'], []),
    0,
    root,
    90,
    Date.parse(now),
  );
  assert.equal(page.ok, false);
  assert.equal(!page.ok && page.code, 'MEDIA_NOT_READY');
});
