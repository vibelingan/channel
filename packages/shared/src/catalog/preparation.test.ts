import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
  readCurrentCatalogPreparation,
} from './preparation.ts';
const report = () => ({
  schemaVersion: 'catalog-preparation-report-v2',
  productId: 'p',
  inputDigest: 'a'.repeat(64),
  policyVersion: CATALOG_PREPARATION_POLICY,
  contentGeneration: 3,
  checkedAt: '2026-10-14T00:00:00.000Z',
  state: 'ready',
  seal: {
    kind: 'catalog-preparation-ready-seal-v1',
    jobId: 'b'.repeat(64),
    receiptId: 'c'.repeat(64),
    planDigest: 'd'.repeat(64),
    imageIdsDigest: 'e'.repeat(64),
    imageCount: 3,
    mediaPolicyVersion: 'catalog-protected-media-seal-v1',
    pixelPolicyVersion: 'catalog-pixels-v1',
  },
  previewReady: true,
  mediaReady: true,
  issues: [],
});
const product = () => ({
  _id: 'p',
  catalogContentGeneration: 3,
  catalogPreparationState: 'ready',
  catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
  catalogPreparationReport: report(),
});
const issue = {
  code: 'INVALID_VALUE',
  stage: 'effective-content',
  path: 'name',
  severity: 'error',
  remedy: 'edit',
};
test('current valid bounded report is readable without changing the product', () => {
  const row = product();
  const before = structuredClone(row);
  assert.deepEqual(readCurrentCatalogPreparation(row), report());
  assert.deepEqual(row, before);
});
for (const patch of [
  { catalogPreparationReport: undefined },
  { catalogPreparationReport: null },
  { catalogPreparationReport: { state: 'ready' } },
  { catalogPreparationPolicy: 'older-policy' },
  { catalogPreparationState: 'stale' },
  { catalogContentGeneration: 4 },
  { catalogContentGeneration: '3' },
  { _id: 'other' },
])
  test(`legacy, malformed or stale checks never grant readiness: ${Object.keys(patch)[0]} ${JSON.stringify(patch)}`, () => {
    assert.equal(readCurrentCatalogPreparation({ ...product(), ...patch }), null);
  });
test('missing and null legacy generation are zero only when the report actually checked zero', () => {
  for (const generation of [undefined, null]) {
    assert.equal(
      readCurrentCatalogPreparation({ ...product(), catalogContentGeneration: generation }),
      null,
    );
    assert.ok(
      readCurrentCatalogPreparation({
        ...product(),
        catalogContentGeneration: generation,
        catalogPreparationReport: { ...report(), contentGeneration: 0 },
      }),
    );
  }
});
for (const patch of [
  { mediaReady: false },
  { previewReady: false },
  { issues: [issue] },
  { state: 'preparing' },
  { state: 'blocked' },
  { contentGeneration: -1 },
  { contentGeneration: 0.5 },
  { contentGeneration: Number.MAX_SAFE_INTEGER + 1 },
  { inputDigest: 'wrong' },
  { checkedAt: 'wrong' },
  { rawSource: 'PRIVATE_SOURCE' },
  { issues: Array.from({ length: 51 }, () => ({ ...issue, severity: 'warning' })) },
])
  test(`invalid report combinations are refused: ${Object.keys(patch)[0]} ${JSON.stringify(patch).slice(0, 90)}`, () => {
    assert.equal(
      CatalogPreparationReportSchema.safeParse({ ...report(), ...patch }).success,
      false,
    );
  });
test('blocked and preparing are distinct from ready and preserve safe issues', () => {
  const { seal: _seal, ...nonready } = report();
  const blocked = {
    ...nonready,
    state: 'blocked',
    previewReady: false,
    mediaReady: false,
    issues: [issue],
  };
  assert.ok(CatalogPreparationReportSchema.safeParse(blocked).success);
  assert.ok(
    CatalogPreparationReportSchema.safeParse({ ...nonready, state: 'preparing', mediaReady: false })
      .success,
  );
  assert.equal(
    readCurrentCatalogPreparation({
      ...product(),
      catalogPreparationState: 'blocked',
      catalogPreparationReport: blocked,
    })?.state,
    'blocked',
  );
});
test('a structurally valid older policy is not a current check', () => {
  const old = { ...report(), policyVersion: 'catalog-preparation-old' };
  assert.ok(CatalogPreparationReportSchema.safeParse(old).success);
  assert.equal(
    readCurrentCatalogPreparation({
      ...product(),
      catalogPreparationPolicy: old.policyVersion,
      catalogPreparationReport: old,
    }),
    null,
  );
});

test('a syntactically valid timestamp cannot make the private report unbounded', () => {
  const checkedAt = `2026-10-14T00:00:00.${'1'.repeat(70_000)}Z`;
  assert.equal(CatalogPreparationReportSchema.safeParse({ ...report(), checkedAt }).success, false);
});

test('a historical v1 ready snapshot cannot satisfy the new sealed-ready contract', () => {
  assert.equal(
    readCurrentCatalogPreparation({
      ...product(),
      catalogPreparationReport: { ...report(), schemaVersion: 'catalog-preparation-report-v1' },
    }),
    null,
  );
});
test('v2 ready requires an explicit bounded media seal', () => {
  const candidate = {
    ...report(),
    schemaVersion: 'catalog-preparation-report-v2',
    seal: {
      kind: 'catalog-preparation-ready-seal-v1',
      jobId: 'b'.repeat(64),
      receiptId: 'c'.repeat(64),
      planDigest: 'd'.repeat(64),
      imageIdsDigest: 'e'.repeat(64),
      imageCount: 3,
      mediaPolicyVersion: 'catalog-protected-media-seal-v1',
      pixelPolicyVersion: 'catalog-pixels-v1',
    },
  };
  assert.equal(CatalogPreparationReportSchema.safeParse(candidate).success, true);
  const { seal: _seal, ...missing } = candidate;
  assert.equal(CatalogPreparationReportSchema.safeParse(missing).success, false);
});
