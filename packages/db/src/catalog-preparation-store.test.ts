import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceObservationDocumentId } from '@vibelingan-channel/catalog-import/observations';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
} from '@vibelingan-channel/shared/catalog-preparation';
import { runStagedApproval } from './catalog-detail-staging.ts';
import { runCatalogApprovalWorkflow } from './catalog-detail-workflow.ts';
import {
  catalogPreparationInputDigest,
  storeCatalogPreparationReport,
} from './catalog-preparation-store.ts';
function fixture() {
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Website',
    productFamily: 'misc',
    imageIds: ['image'],
    published: true,
    archived: false,
    catalogContentGeneration: 3,
    catalogLifecycleVersion: 2,
    catalogDetailPublication: { state: 'approved', revision: 'retained' },
    updatedAt: '2026-10-14T00:00:00.000Z',
  };
  const records: Record<string, CollectionDoc | undefined> = {
    'users/admin': { _id: 'admin', role: 'admin' },
    'products/p': product,
  };
  const report = CatalogPreparationReportSchema.parse({
    schemaVersion: 'catalog-preparation-report-v2',
    productId: 'p',
    inputDigest: catalogPreparationInputDigest({
      product,
      source: null,
      observation: null,
      link: null,
    }),
    policyVersion: CATALOG_PREPARATION_POLICY,
    contentGeneration: 3,
    checkedAt: '2026-10-14T00:00:00.000Z',
    state: 'preparing',
    previewReady: true,
    mediaReady: false,
    issues: [],
  });
  const writes: Array<{ collection: string; row: CollectionDoc }> = [];
  const tx = {
    get: async (collection: string, id: string) =>
      structuredClone(records[`${collection}/${id}`] ?? null),
    set: async (collection: string, row: CollectionDoc) => {
      writes.push({ collection, row: structuredClone(row) });
      records[`${collection}/${row._id}`] = structuredClone(row);
    },
  };
  const run = () => runStagedApproval(tx, 'admin', { action: 'preparation-report', report });
  return { product, records, report, writes, tx, run };
}
test('a current private check stores only the report on its product without advancing edit or public state', async () => {
  const h = fixture();
  const before = structuredClone(h.product);
  const result = await h.run();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]?.collection, 'products');
  const saved = h.records['products/p'];
  assert.ok(saved);
  assert.deepEqual(saved, {
    ...before,
    catalogPreparationState: 'preparing',
    catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
    catalogPreparationReport: h.report,
  });
});
test('replaying exactly the stored check performs no writes', async () => {
  const h = fixture();
  assert.ok((await h.run()).ok);
  h.writes.length = 0;
  const before = structuredClone(h.records);
  assert.ok((await h.run()).ok);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.records, before);
});
for (const change of [
  { name: 'Edited' },
  { catalogContentGeneration: 4 },
  { imageIds: ['other'] },
  { configurationPhotos: { sku: ['image'] } },
  { productFamily: 'toys' },
  { alibabaPhotosPending: true },
  {
    alibabaAutoPhotos: {
      configurations: {
        sources: ['https://sc04.alicdn.com/a.jpg'],
        imageIds: [],
        missing: [],
        unusable: [],
      },
    },
  },
])
  test(`stale computed check cannot overwrite a changed product: ${Object.keys(change)[0]}`, async () => {
    const h = fixture();
    Object.assign(h.records['products/p'] ?? {}, change);
    const before = structuredClone(h.records);
    assert.deepEqual(await h.run(), { ok: false, code: 'CONFLICT' });
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.records, before);
  });
test('a report calculated under an older policy is refused before writes', async () => {
  const h = fixture();
  h.report.policyVersion = 'old-policy';
  assert.deepEqual(await h.run(), { ok: false, code: 'CONFLICT' });
  assert.equal(h.writes.length, 0);
});
for (const actor of [
  { _id: 'admin', role: 'contributor' },
  { _id: 'admin', role: 'admin', status: 'suspended' },
  { _id: 'other', role: 'admin' },
])
  test(`private check persistence rechecks its actor: ${JSON.stringify(actor)}`, async () => {
    const h = fixture();
    h.records['users/admin'] = actor;
    assert.deepEqual(await h.run(), { ok: false, code: 'FORBIDDEN' });
    assert.equal(h.writes.length, 0);
  });
test('a missing product cannot be created by a stale report', async () => {
  const h = fixture();
  h.records['products/p'] = undefined;
  assert.deepEqual(await h.run(), { ok: false, code: 'NOT_FOUND' });
  assert.equal(h.writes.length, 0);
});

for (const [field, value] of [
  ['catalogContentGeneration', '3'],
  ['catalogContentGeneration', -1],
] as const)
  test('corrupt stored generations cannot receive a check report', async () => {
    const h = fixture();
    Object.assign(h.records['products/p'] ?? {}, { [field]: value });
    const result = await h.run();
    assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
    assert.equal(result.validation?.issues[0]?.remedy, 'system-repair');
    assert.equal(h.writes.length, 0);
  });

test('current lifecycle and subcategory changes survive a content-only check writeback', async () => {
  const h = fixture();
  const current = h.records['products/p'];
  assert.ok(current);
  current.published = false;
  current.catalogLifecycleVersion = 3;
  current.subcategoryIds = ['leaf'];
  current.catalogClassificationRevision = 1;
  assert.ok((await h.run()).ok);
  assert.equal(h.records['products/p']?.published, false);
  assert.equal(h.records['products/p']?.catalogLifecycleVersion, 3);
  assert.deepEqual(h.records['products/p']?.subcategoryIds, ['leaf']);
});

function sourceFixture() {
  const h = fixture();
  const product = h.records['products/p'];
  assert.ok(product);
  product.alibabaPrimarySourceKey = 'source';
  const source: CollectionDoc = {
    _id: 'source',
    connectionId: 'c',
    sourceProductId: 'external',
    contentHash: 'a'.repeat(64),
    payloadId: 'raw-old',
    active: true,
  };
  const observation: CollectionDoc = {
    _id: sourceObservationDocumentId('alibaba', 'source'),
    provider: 'alibaba',
    sourceProductKey: 'source',
    evidenceId: 'raw-old',
    observation: {
      source: { provider: 'alibaba', sourceProductKey: 'source' },
      identity: { title: 'Clock' },
    },
  };
  const link: CollectionDoc = {
    _id: 'source',
    sourceKey: 'source',
    productId: 'p',
    connectionId: 'c',
    sourceProductId: 'external',
  };
  h.records['alibabaSourceProducts/source'] = source;
  h.records[`catalogSourceObservations/${observation._id}`] = observation;
  h.records['alibabaProductLinks/source'] = link;
  h.report.inputDigest = catalogPreparationInputDigest({ product, source, observation, link });
  return { ...h, source, observation, link };
}
for (const field of [
  'source-content',
  'source-capture',
  'observation-content',
  'observation-capture',
  'link',
  'missing-observation',
] as const)
  test(`the final transaction refuses a changed ${field} even without a forged generation advance`, async () => {
    const h = sourceFixture();
    if (field === 'source-content') h.source.contentHash = 'b'.repeat(64);
    if (field === 'source-capture') h.source.payloadId = 'raw-new';
    if (field === 'observation-content')
      h.observation.observation = {
        source: { provider: 'alibaba', sourceProductKey: 'source' },
        identity: { title: 'Changed' },
      };
    if (field === 'observation-capture') h.observation.evidenceId = 'raw-new';
    if (field === 'link') h.link.productId = 'other';
    if (field === 'missing-observation')
      h.records[`catalogSourceObservations/${h.observation._id}`] = undefined;
    const before = structuredClone(h.records);
    assert.deepEqual(await h.run(), { ok: false, code: 'CONFLICT' });
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.records, before);
  });
test('modern capture metadata changes preserve the exact check input and allow a current report', async () => {
  const h = sourceFixture();
  h.observation.sourceContentHash = h.source.contentHash;
  h.report.inputDigest = catalogPreparationInputDigest({
    product: h.product,
    source: h.source,
    observation: h.observation,
    link: h.link,
  });
  h.source.payloadId = 'raw-new';
  h.observation.evidenceId = 'raw-new';
  assert.ok((await h.run()).ok);
});
test('HTTP approval commands cannot submit an internal check report', async () => {
  const h = fixture();
  const result = await runCatalogApprovalWorkflow(
    {
      get: h.tx.get,
      persist: async () => {
        throw new Error('Client snapshots must not reach persistence');
      },
    },
    'admin',
    { action: 'preparation-report', report: h.report },
  );
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
  assert.equal(h.writes.length, 0);
});

test('the raw private report command cannot forge ready even with a valid sealed report shape', async () => {
  const h = fixture();
  const report = CatalogPreparationReportSchema.parse({
    ...h.report,
    state: 'ready',
    mediaReady: true,
    seal: {
      kind: 'catalog-preparation-ready-seal-v1',
      jobId: 'b'.repeat(64),
      receiptId: 'c'.repeat(64),
      planDigest: 'd'.repeat(64),
      imageIdsDigest: 'e'.repeat(64),
      imageCount: 0,
      mediaPolicyVersion: 'catalog-protected-media-seal-v1',
      pixelPolicyVersion: 'catalog-pixels-v1',
    },
  });
  assert.deepEqual(
    await storeCatalogPreparationReport(h.tx, 'admin', { action: 'preparation-report', report }),
    { ok: false, code: 'VALIDATION_ERROR' },
  );
  const result = await runStagedApproval(h.tx, 'admin', { action: 'preparation-report', report });
  assert.ok(!result.ok && result.code === 'VALIDATION_ERROR');
  assert.equal(h.writes.length, 0);
});
