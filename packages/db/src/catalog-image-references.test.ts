import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CATALOG_IMAGE_REFERENCE_MAX_PENDING,
  CatalogImageReferenceError,
  type CatalogImageReferenceLedger,
  type CatalogImageReferencePlan,
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
  catalogImageReferenceProofId,
  planImageReferenceSettlement,
  stageCatalogImageReference,
} from './catalog-image-references.ts';

const root = (n = 1) => n.toString(16).padStart(64, '0');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ledger(pending: CatalogImageReferenceLedger['pending'], epoch = 0) {
  return { version: 'catalog-image-reference-ledger-v1' as const, epoch, pending };
}
function entry(plan: CatalogImageReferencePlan, imageId: string) {
  const index = plan.changes.findIndex((value) => value.imageId === imageId);
  return catalogImageReferenceEntry(plan, index);
}
function failure(run: () => unknown, code?: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CatalogImageReferenceError);
    if (code) assert.equal(error.code, code);
    assert.ok(!error.message.includes('private-image'));
    return true;
  });
}

test('a plan deduplicates public references and leaves shared unchanged images read-only', () => {
  const plan = buildCatalogImageReferencePlan(
    root(),
    ['old', 'shared', 'old'],
    ['new', 'shared', 'new'],
  );
  assert.deepEqual(plan.changes, [
    { imageId: 'new', delta: 1 },
    { imageId: 'old', delta: -1 },
  ]);
  assert.equal(plan.proof.leafCount, 2);
  assert.deepEqual(
    buildCatalogImageReferencePlan(root(), ['new', 'shared'], ['shared', 'new']).changes,
    [],
  );
  assert.equal(plan.proof._id, catalogImageReferenceProofId(plan.proof));
  assert.notEqual(
    plan.proof._id,
    buildCatalogImageReferencePlan(root(2), ['old'], ['new']).proof._id,
  );
});

for (const size of [0, 1, 2, 3, 5, 20, 21, 105, 10000, 20126])
  test(`a ${size}-image plan has a small commit proof and independently verified paths`, () => {
    const ids = Array.from({ length: size }, (_, i) => `image-${String(i).padStart(5, '0')}`);
    const plan = buildCatalogImageReferencePlan(root(), [], ids);
    let level = ids.map((imageId) => hash(['catalog-image-reference-leaf-v1', imageId, 1]));
    if (level.length === 0) level = [hash(['catalog-image-reference-empty-v1'])];
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2)
        next.push(hash(['catalog-image-reference-node-v1', level[i], level[i + 1] ?? level[i]]));
      level = next;
    }
    assert.equal(plan.proof.treeRoot, level[0]);
    assert.ok(Buffer.byteLength(JSON.stringify(plan.proof)) < 400);
    for (const index of new Set([0, Math.floor(size / 2), size - 1])) {
      if (index < 0 || index >= size) continue;
      const imageId = ids[index];
      assert.ok(imageId);
      const pending = catalogImageReferenceEntry(plan, index);
      assert.ok(pending.siblings.length <= 16);
      const result = planImageReferenceSettlement(
        imageId,
        0,
        ledger([pending]),
        new Map([[plan.proof._id, plan.proof]]),
      );
      assert.equal(result.effectiveCount, 1);
      assert.deepEqual(result.resolvedProofIds, [plan.proof._id]);
      assert.equal(result.settlement?.ledger.epoch, 1);
      assert.deepEqual(result.settlement?.ledger.pending, []);
    }
  });

test('uncommitted work cannot expose private images and an explicit missing-proof read is required', () => {
  const plan = buildCatalogImageReferencePlan(root(), [], ['private-image']);
  const pending = entry(plan, 'private-image');
  const before = ledger([pending], 17);
  const result = planImageReferenceSettlement(
    'private-image',
    0,
    before,
    new Map([[plan.proof._id, null]]),
  );
  assert.equal(result.effectiveCount, 0);
  assert.equal(result.settlement, null);
  assert.deepEqual(result.resolvedProofIds, []);
  assert.deepEqual(before, ledger([pending], 17));
  failure(
    () => planImageReferenceSettlement('private-image', 0, before, new Map()),
    'MISSING_SNAPSHOT_READ',
  );
});

test('all committed deltas settle together, including a later unpublish, without negative intermediate counts', () => {
  const a = buildCatalogImageReferencePlan(root(), [], ['shared']);
  const b = buildCatalogImageReferencePlan(root(2), ['shared'], []);
  const c = buildCatalogImageReferencePlan(root(3), [], ['shared']);
  const pending = [entry(b, 'shared'), entry(c, 'shared'), entry(a, 'shared')];
  const before = ledger(pending, 5);
  const proofs = new Map<string, unknown>([
    [a.proof._id, a.proof],
    [b.proof._id, b.proof],
    [c.proof._id, null],
  ]);
  const result = planImageReferenceSettlement('shared', 0, before, proofs);
  assert.equal(result.effectiveCount, 0);
  assert.deepEqual(result.settlement, {
    publishedRefCount: 0,
    ledger: ledger([entry(c, 'shared')], 6),
  });
  assert.deepEqual(new Set(result.resolvedProofIds), new Set([a.proof._id, b.proof._id]));
  assert.deepEqual(before, ledger(pending, 5));
  assert.ok(result.settlement);
  assert.equal(
    planImageReferenceSettlement('shared', 0, result.settlement.ledger, proofs).settlement,
    null,
  );
  proofs.set(c.proof._id, c.proof);
  assert.equal(
    planImageReferenceSettlement('shared', 0, result.settlement.ledger, proofs).effectiveCount,
    1,
  );
});

test('a committed proof stays effective when later product operations replace their own root markers', () => {
  const first = buildCatalogImageReferencePlan(root(), [], ['shared']);
  const second = buildCatalogImageReferencePlan(root(2), ['shared'], []);
  const before = ledger([entry(first, 'shared'), entry(second, 'shared')]);
  const proofRows = new Map<string, unknown>([
    [first.proof._id, first.proof],
    [second.proof._id, null],
  ]);
  assert.equal(planImageReferenceSettlement('shared', 0, before, proofRows).effectiveCount, 1);
  proofRows.set(second.proof._id, second.proof);
  assert.equal(planImageReferenceSettlement('shared', 0, before, proofRows).effectiveCount, 0);
  // Proving a past commit is independent of the actor's current role, source and lifecycle.
  assert.ok(!JSON.stringify(first.proof).includes('role'));
});

test('the non-snapshot counterexample stays public at every valid snapshot', () => {
  const a = buildCatalogImageReferencePlan(root(), [], ['shared']);
  const b = buildCatalogImageReferencePlan(root(2), ['shared'], []);
  const c = buildCatalogImageReferencePlan(root(3), [], ['shared']);
  const before = ledger([entry(c, 'shared'), entry(a, 'shared'), entry(b, 'shared')]);
  const snapshots = [
    new Map<string, unknown>([
      [a.proof._id, a.proof],
      [b.proof._id, null],
      [c.proof._id, null],
    ]),
    new Map<string, unknown>([
      [a.proof._id, a.proof],
      [b.proof._id, null],
      [c.proof._id, c.proof],
    ]),
    new Map<string, unknown>([
      [a.proof._id, a.proof],
      [b.proof._id, b.proof],
      [c.proof._id, c.proof],
    ]),
  ];
  assert.deepEqual(
    snapshots.map(
      (proofs) => planImageReferenceSettlement('shared', 0, before, proofs).effectiveCount,
    ),
    [1, 2, 1],
  );
  // This deliberately demonstrates why a future caller must supply one transaction snapshot.
  const mixed = new Map<string, unknown>([
    [c.proof._id, null],
    [a.proof._id, a.proof],
    [b.proof._id, b.proof],
  ]);
  assert.equal(planImageReferenceSettlement('shared', 0, before, mixed).effectiveCount, 0);
});

const pendingMutations: readonly [string, Record<string, unknown>][] = [
  ['wrong image', {}],
  ['reversed delta', { delta: -1 }],
  ['wrong position', { index: 1 }],
  ['wrong sibling', { siblings: [root(888)] }],
  ['short path', { siblings: [] }],
  ['long path', { siblings: [root(888), root(999)] }],
  ['wrong leaf count', { leafCount: 3 }],
  ['wrong root', { treeRoot: root(888) }],
  ['zero delta', { delta: 0 }],
  ['fractional delta', { delta: 0.5 }],
  ['unknown field', { privateSource: 'private-image' }],
];
for (const [label, patch] of pendingMutations)
  test(`pending membership rejects ${label} even before activation`, () => {
    const plan = buildCatalogImageReferencePlan(root(), [], ['a', 'b']);
    const pending = { ...entry(plan, 'a'), ...patch };
    const imageId = label === 'wrong image' ? 'b' : 'a';
    failure(() =>
      planImageReferenceSettlement(
        imageId,
        0,
        ledger([pending]),
        new Map([[catalogImageReferenceProofId(pending), null]]),
      ),
    );
  });

const proofMutations: readonly [string, Record<string, unknown>][] = [
  ['wrong id', { _id: root(888) }],
  ['wrong root owner', { operationRootId: root(888) }],
  ['wrong tree', { treeRoot: root(888) }],
  ['wrong count', { leafCount: 99 }],
  ['wrong kind', { kind: 'anything' }],
  ['extra value', { privateValue: 'private-image' }],
];
for (const [label, patch] of proofMutations)
  test(`a present malformed commit proof fails closed: ${label}`, () => {
    const plan = buildCatalogImageReferencePlan(root(), [], ['a']);
    failure(
      () =>
        planImageReferenceSettlement(
          'a',
          0,
          ledger([entry(plan, 'a')]),
          new Map([[plan.proof._id, { ...plan.proof, ...patch }]]),
        ),
      'INVALID_PROOF',
    );
  });

for (const count of [
  undefined,
  null,
  '1',
  -1,
  0.1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
])
  test(`invalid materialized counter ${String(count)} cannot pass the gate`, () => {
    failure(() => planImageReferenceSettlement('a', count, undefined, new Map()), 'INVALID_COUNT');
  });

test('counter overflow/underflow and duplicate operations cannot be hidden by replay or ordering', () => {
  const add = buildCatalogImageReferencePlan(root(), [], ['a']);
  const remove = buildCatalogImageReferencePlan(root(2), ['a'], []);
  const plus = entry(add, 'a');
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        Number.MAX_SAFE_INTEGER,
        ledger([plus]),
        new Map([[add.proof._id, add.proof]]),
      ),
    'INVALID_COUNT',
  );
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([entry(remove, 'a')]),
        new Map([[remove.proof._id, remove.proof]]),
      ),
    'INVALID_COUNT',
  );
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([plus, plus]),
        new Map([[add.proof._id, add.proof]]),
      ),
    'INVALID_LEDGER',
  );
  const otherPlan = buildCatalogImageReferencePlan(root(), [], ['a', 'b']);
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([plus, entry(otherPlan, 'a')]),
        new Map([
          [add.proof._id, add.proof],
          [otherPlan.proof._id, otherPlan.proof],
        ]),
      ),
    'INVALID_LEDGER',
  );
});

test('80 shared operations fit a bounded ledger; the 81st must be settled/queued before append', () => {
  const plans = Array.from({ length: CATALOG_IMAGE_REFERENCE_MAX_PENDING }, (_, i) =>
    buildCatalogImageReferencePlan(root(i + 1), [], ['a']),
  );
  const before = ledger(plans.map((plan) => entry(plan, 'a')));
  const proofs = new Map(plans.map((plan) => [plan.proof._id, plan.proof]));
  assert.equal(planImageReferenceSettlement('a', 0, before, proofs).effectiveCount, 80);
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 128 * 1024);
  const extra = buildCatalogImageReferencePlan(root(999), [], ['a']);
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([...before.pending, entry(extra, 'a')]),
        new Map([...proofs, [extra.proof._id, extra.proof]]),
      ),
    'INVALID_LEDGER',
  );
});

test('absent/empty ledgers perform no writes; invalid versions and saturated epochs reject safely', () => {
  assert.deepEqual(planImageReferenceSettlement('a', 7, undefined, new Map()), {
    effectiveCount: 7,
    resolvedProofIds: [],
    settlement: null,
  });
  assert.equal(planImageReferenceSettlement('a', 7, ledger([], 3), new Map()).settlement, null);
  for (const value of [
    null,
    {},
    { ...ledger([]), version: 'unknown' },
    { ...ledger([]), epoch: -1 },
    { ...ledger([]), extra: 1 },
  ])
    failure(() => planImageReferenceSettlement('a', 7, value, new Map()), 'INVALID_LEDGER');
  const plan = buildCatalogImageReferencePlan(root(), [], ['a']);
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([entry(plan, 'a')], Number.MAX_SAFE_INTEGER),
        new Map([[plan.proof._id, plan.proof]]),
      ),
    'INVALID_LEDGER',
  );
});

test('plan input and entry indexes reject rather than construct ambiguous proofs', () => {
  for (const ids of [['private/image'], ['$field'], [''], ['a.b']])
    failure(() => buildCatalogImageReferencePlan(root(), [], ids), 'INVALID_PLAN');
  failure(() => buildCatalogImageReferencePlan('bad-root', [], ['a']), 'INVALID_PLAN');
  failure(
    () =>
      buildCatalogImageReferencePlan(
        root(),
        [],
        Array.from({ length: 65537 }, (_, i) => `a${i}`),
      ),
    'INVALID_PLAN',
  );
  const plan = buildCatalogImageReferencePlan(root(), [], ['a']);
  for (const index of [-1, 0.5, 1, Number.NaN])
    failure(() => catalogImageReferenceEntry(plan, index), 'INVALID_PLAN');
});

test('20/50/100 sequential product transitions with arbitrary settlement order match independent public truth', () => {
  for (const size of [20, 50, 100]) {
    const images = ['shared', 'first', 'second'];
    const truth = new Map<number, Set<string>>();
    const rows = new Map(images.map((id) => [id, { count: 0, ledger: ledger([]) }]));
    const proofs = new Map<string, unknown>();
    let sequence = 1;
    function check() {
      for (const imageId of images) {
        const row = rows.get(imageId);
        assert.ok(row);
        const expected = [...truth.values()].filter((ids) => ids.has(imageId)).length;
        assert.equal(
          planImageReferenceSettlement(imageId, row.count, row.ledger, proofs).effectiveCount,
          expected,
        );
      }
    }
    function settle(imageId: string) {
      const row = rows.get(imageId);
      assert.ok(row);
      const result = planImageReferenceSettlement(imageId, row.count, row.ledger, proofs);
      if (result.settlement) {
        row.count = result.settlement.publishedRefCount;
        row.ledger = result.settlement.ledger;
      }
      check();
    }
    for (const publishing of [true, false])
      for (let offset = 0; offset < size; offset += 4) {
        const batch = [];
        for (let i = offset; i < Math.min(size, offset + 4); i++) {
          const before = truth.get(i) ?? new Set<string>();
          const after = publishing
            ? new Set(['shared', i % 2 ? 'first' : 'second'])
            : new Set<string>();
          const plan = buildCatalogImageReferencePlan(root(sequence++), [...before], [...after]);
          proofs.set(plan.proof._id, null);
          for (let index = 0; index < plan.changes.length; index++) {
            const change = plan.changes[index];
            assert.ok(change);
            const row = rows.get(change.imageId);
            assert.ok(row);
            row.ledger = stageCatalogImageReference(
              change.imageId,
              row.count,
              row.ledger,
              catalogImageReferenceEntry(plan, index),
            ).ledger;
          }
          batch.push({ i, after, plan });
          check();
        }
        // Activation is one atomic product+proof action; discard its response.
        for (const item of batch.reverse()) {
          truth.set(item.i, item.after);
          proofs.set(item.plan.proof._id, item.plan.proof);
          check();
          settle(images[(item.i + sequence) % images.length] ?? 'shared');
        }
        for (const imageId of images) settle(imageId);
      }
    assert.deepEqual(
      [...rows.values()].map((row) => row.count),
      [0, 0, 0],
    );
    assert.ok([...rows.values()].every((row) => row.ledger.pending.length === 0));
  }
});

test('80 maximum-depth proofs stay below the 128KiB ledger budget without loading approval roots', () => {
  const ids = Array.from({ length: 65536 }, (_, i) => `image-${String(i).padStart(5, '0')}`);
  const plan = buildCatalogImageReferencePlan(root(), [], ids);
  const original = catalogImageReferenceEntry(plan, 65535);
  assert.equal(original.siblings.length, 16);
  const pending = Array.from({ length: 80 }, (_, i) => ({
    ...original,
    operationRootId: root(i + 1),
  }));
  const proofs = new Map(
    pending.map((item) => [
      catalogImageReferenceProofId(item),
      {
        ...plan.proof,
        operationRootId: item.operationRootId,
        _id: catalogImageReferenceProofId(item),
      },
    ]),
  );
  const value = ledger(pending);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 128 * 1024);
  assert.equal(planImageReferenceSettlement('image-65535', 0, value, proofs).effectiveCount, 80);
});

test('net-zero signed changes at the maximum safe counter never overflow due to iteration order', () => {
  const add = buildCatalogImageReferencePlan(root(), [], ['a']);
  const remove = buildCatalogImageReferencePlan(root(2), ['a'], []);
  const proofs = new Map([
    [add.proof._id, add.proof],
    [remove.proof._id, remove.proof],
  ]);
  for (const pending of [
    [entry(add, 'a'), entry(remove, 'a')],
    [entry(remove, 'a'), entry(add, 'a')],
  ])
    assert.equal(
      planImageReferenceSettlement('a', Number.MAX_SAFE_INTEGER, ledger(pending), proofs)
        .effectiveCount,
      Number.MAX_SAFE_INTEGER,
    );
});

test('undefined proof values cannot stand in for an explicit missing-document read', () => {
  const plan = buildCatalogImageReferencePlan(root(), [], ['a']);
  failure(
    () =>
      planImageReferenceSettlement(
        'a',
        0,
        ledger([entry(plan, 'a')]),
        new Map([[plan.proof._id, undefined]]),
      ),
    'INVALID_PROOF',
  );
});

test('plan construction and settlement do not mutate or retain input array aliases', () => {
  const oldIds = ['old'];
  const newIds = ['new'];
  const plan = buildCatalogImageReferencePlan(root(), oldIds, newIds);
  oldIds.push('changed');
  newIds.length = 0;
  assert.deepEqual(plan.changes, [
    { imageId: 'new', delta: 1 },
    { imageId: 'old', delta: -1 },
  ]);
  const before = ledger([entry(plan, 'new')]);
  const result = planImageReferenceSettlement(
    'new',
    0,
    before,
    new Map([[plan.proof._id, plan.proof]]),
  );
  assert.ok(result.settlement);
  result.settlement.ledger.pending.push(entry(plan, 'new'));
  result.settlement.ledger.epoch = 77;
  assert.equal(before.epoch, 0);
  assert.equal(before.pending.length, 1);
});

test('self-consistent but noncanonical odd padding is refused even while its proof is absent', () => {
  const leaf = hash(['catalog-image-reference-leaf-v1', 'c', 1]);
  const wrongSibling = hash(['catalog-image-reference-leaf-v1', 'd', 1]);
  const left = hash(['catalog-image-reference-node-v1', root(88), root(99)]);
  const right = hash(['catalog-image-reference-node-v1', leaf, wrongSibling]);
  const pending = {
    operationRootId: root(),
    leafCount: 3,
    treeRoot: hash(['catalog-image-reference-node-v1', left, right]),
    index: 2,
    delta: 1 as const,
    siblings: [wrongSibling, left],
  };
  failure(
    () =>
      planImageReferenceSettlement(
        'c',
        0,
        ledger([pending]),
        new Map([[catalogImageReferenceProofId(pending), null]]),
      ),
    'INVALID_LEDGER',
  );
});

test('a deterministic linearized model covers stale/cancelled intents and arbitrary shared settlement', () => {
  let seed = 99173;
  const next = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const images = ['a', 'b', 'c', 'd'];
  const products = Array.from({ length: 12 }, () => ({ version: 0, imageIds: new Set<string>() }));
  const rows = new Map(images.map((id) => [id, { count: 0, ledger: ledger([]) }]));
  const proofs = new Map<string, unknown>();
  const intents: {
    product: number;
    version: number;
    after: Set<string>;
    plan: CatalogImageReferencePlan;
    state: 'pending' | 'committed' | 'cancelled';
  }[] = [];
  let sequence = 1000;
  let activated = 0;
  let stale = 0;
  let cancelled = 0;
  function check() {
    for (const imageId of images) {
      const row = rows.get(imageId);
      assert.ok(row);
      const truth = products.reduce((n, product) => n + BigInt(product.imageIds.has(imageId)), 0n);
      assert.equal(
        BigInt(planImageReferenceSettlement(imageId, row.count, row.ledger, proofs).effectiveCount),
        truth,
      );
    }
  }
  function settle(imageId: string) {
    const row = rows.get(imageId);
    assert.ok(row);
    const result = planImageReferenceSettlement(imageId, row.count, row.ledger, proofs);
    if (result.settlement) {
      row.count = result.settlement.publishedRefCount;
      row.ledger = result.settlement.ledger;
    }
    assert.equal(
      planImageReferenceSettlement(imageId, row.count, row.ledger, proofs).settlement,
      null,
    );
  }
  for (let step = 0; step < 2000; step++) {
    const choice = next(5);
    if (choice < 2) {
      const productId = next(products.length);
      const product = products[productId];
      assert.ok(product);
      const after = new Set(images.filter(() => next(3) === 0));
      const plan = buildCatalogImageReferencePlan(
        root(sequence++),
        [...product.imageIds],
        [...after],
      );
      intents.push({ product: productId, version: product.version, after, plan, state: 'pending' });
      proofs.set(plan.proof._id, null);
      for (let i = 0; i < plan.changes.length; i++) {
        const change = plan.changes[i];
        assert.ok(change);
        const row = rows.get(change.imageId);
        assert.ok(row);
        row.ledger = stageCatalogImageReference(
          change.imageId,
          row.count,
          row.ledger,
          catalogImageReferenceEntry(plan, i),
        ).ledger;
      }
    } else if (choice === 2) {
      const pending = intents.filter((intent) => intent.state === 'pending');
      const intent = pending[next(pending.length)];
      if (intent) {
        const product = products[intent.product];
        assert.ok(product);
        if (product.version === intent.version) {
          product.imageIds = intent.after;
          product.version++;
          proofs.set(intent.plan.proof._id, intent.plan.proof);
          intent.state = 'committed';
          activated++;
        } else {
          intent.state = 'cancelled';
          stale++;
        }
      }
    } else if (choice === 3) {
      const pending = intents.filter((intent) => intent.state === 'pending');
      const intent = pending[next(pending.length)];
      if (intent) {
        intent.state = 'cancelled';
        cancelled++;
      }
    } else settle(images[next(images.length)] ?? 'a');
    // Model permanent cancellation independently: it never creates a commit proof.
    const retired = new Set(
      intents
        .filter((intent) => intent.state === 'cancelled')
        .map((intent) => intent.plan.proof.operationRootId),
    );
    for (const row of rows.values())
      row.ledger = ledger(
        row.ledger.pending.filter((item) => !retired.has(item.operationRootId)),
        row.ledger.epoch,
      );
    check();
    if (step % 11 === 0) for (const imageId of images) settle(imageId);
  }
  assert.ok(activated > 100 && stale > 10 && cancelled > 100);
  for (const imageId of images) settle(imageId);
  check();
});
