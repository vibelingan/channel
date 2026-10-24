import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogImageReferenceError,
  type CatalogImageReferencePlan,
  buildCatalogImageReferencePlan,
  catalogImageReferenceCancelProof,
  catalogImageReferenceEntry,
  planImageReferenceSettlement,
} from './catalog-image-references.ts';

const root = (n: number) => n.toString(16).padStart(64, '0');
function cancelled(plan: CatalogImageReferencePlan) {
  return { ...plan.proof, kind: 'catalog-image-reference-cancel-v1' };
}
function ledger(plans: CatalogImageReferencePlan[], epoch = 0) {
  return {
    version: 'catalog-image-reference-ledger-v1',
    epoch,
    pending: plans.map((plan) => catalogImageReferenceEntry(plan, 0)),
  };
}
for (const delta of [1, -1] as const)
  test(`a cancelled ${delta} reference clears its slot without changing the public count`, () => {
    const plan = buildCatalogImageReferencePlan(
      root(1),
      delta === -1 ? ['image'] : [],
      delta === 1 ? ['image'] : [],
    );
    const base = delta === 1 ? 0 : 1;
    const result = planImageReferenceSettlement(
      'image',
      base,
      ledger([plan], 5),
      new Map([[plan.proof._id, cancelled(plan)]]),
    );
    assert.equal(result.effectiveCount, base);
    assert.deepEqual(result.resolvedProofIds, [plan.proof._id]);
    assert.deepEqual(result.settlement, {
      publishedRefCount: base,
      ledger: { version: 'catalog-image-reference-ledger-v1', epoch: 6, pending: [] },
    });
    const replay = planImageReferenceSettlement(
      'image',
      base,
      result.settlement?.ledger,
      new Map(),
    );
    assert.equal(replay.effectiveCount, base);
    assert.equal(replay.settlement, null);
    assert.deepEqual(replay.resolvedProofIds, []);
  });

for (const base of [0, 1])
  test(`mixed commit/cancel/missing references from base${base} preserve every other operation`, () => {
    const commit = buildCatalogImageReferencePlan(
      root(1),
      base === 1 ? ['image'] : [],
      base === 1 ? [] : ['image'],
    );
    const cancel = buildCatalogImageReferencePlan(
      root(2),
      base === 1 ? [] : ['image'],
      base === 1 ? ['image'] : [],
    );
    const missing = buildCatalogImageReferencePlan(root(3), [], ['image']);
    const result = planImageReferenceSettlement(
      'image',
      base,
      ledger([commit, cancel, missing]),
      new Map<string, unknown>([
        [commit.proof._id, commit.proof],
        [cancel.proof._id, cancelled(cancel)],
        [missing.proof._id, null],
      ]),
    );
    assert.equal(result.effectiveCount, base === 0 ? 1 : 0);
    assert.deepEqual(
      new Set(result.resolvedProofIds),
      new Set([commit.proof._id, cancel.proof._id]),
    );
    assert.deepEqual(result.settlement?.ledger.pending, [catalogImageReferenceEntry(missing, 0)]);
  });

for (const delta of [1, -1] as const)
  test(`all80 cancelled ${delta} slots can be released even at a counter boundary`, () => {
    const plans = Array.from({ length: 80 }, (_, index) =>
      buildCatalogImageReferencePlan(
        root(index + 1),
        delta === -1 ? ['image'] : [],
        delta === 1 ? ['image'] : [],
      ),
    );
    const base = delta === 1 ? Number.MAX_SAFE_INTEGER : 0;
    const result = planImageReferenceSettlement(
      'image',
      base,
      ledger(plans),
      new Map(plans.map((plan) => [plan.proof._id, cancelled(plan)])),
    );
    assert.equal(result.effectiveCount, base);
    assert.equal(result.resolvedProofIds.length, 80);
    assert.deepEqual(result.settlement?.ledger.pending, []);
    assert.equal(result.settlement?.ledger.epoch, 1);
  });

test('cancel and commit share one terminal slot without copying private input fields', () => {
  const plan = buildCatalogImageReferencePlan(root(1), [], ['image']);
  const input = {
    ...plan.proof,
    privateToken: 'never-copy-this',
    source: { huge: 'x'.repeat(10000) },
  };
  const result = catalogImageReferenceCancelProof(input);
  assert.deepEqual(result, cancelled(plan));
  assert.equal(result._id, plan.proof._id);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 400);
  assert.equal(JSON.stringify(result).includes('never-copy-this'), false);
  assert.equal(plan.proof.kind, 'catalog-image-reference-commit-v1');
});

for (const damage of ['wrong-id', 'root', 'tree', 'leaves', 'extra', 'kind'] as const)
  test(`a cancelled proof with ${damage} corruption cannot resolve a pending reference`, () => {
    const plan = buildCatalogImageReferencePlan(root(1), [], ['image']);
    const row: Record<string, unknown> = cancelled(plan);
    if (damage === 'wrong-id') row._id = root(9);
    if (damage === 'root') row.operationRootId = root(9);
    if (damage === 'tree') row.treeRoot = root(9);
    if (damage === 'leaves') row.leafCount = 2;
    if (damage === 'extra') row.extra = true;
    if (damage === 'kind') row.kind = 'catalog-image-reference-pending-v1';
    assert.throws(
      () =>
        planImageReferenceSettlement('image', 0, ledger([plan]), new Map([[plan.proof._id, row]])),
      CatalogImageReferenceError,
    );
  });

for (const change of [
  { operationRootId: 'bad' },
  { treeRoot: 'bad' },
  { leafCount: -1 },
  { leafCount: 1.5 },
  { leafCount: 65537 },
])
  test(`cancel proof factory refuses invalid commitment ${JSON.stringify(change)}`, () => {
    const plan = buildCatalogImageReferencePlan(root(1), [], ['image']);
    assert.throws(
      () => catalogImageReferenceCancelProof({ ...plan.proof, ...change }),
      CatalogImageReferenceError,
    );
  });
