import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { runCatalogImageReferenceRead } from './catalog-image-reference-store.ts';
import {
  CatalogImageReferenceError,
  buildCatalogImageReferencePlan,
  catalogImageReferenceEntry,
} from './catalog-image-references.ts';

const root = (n: number) => n.toString(16).padStart(64, '0');
function fixture(changes: Array<{ delta: 1 | -1; committed: boolean }>, base = 0) {
  const plans = changes.map(({ delta }, index) =>
    buildCatalogImageReferencePlan(
      root(index + 1),
      delta === -1 ? ['image'] : [],
      delta === 1 ? ['image'] : [],
    ),
  );
  const pending = plans.map((plan) => catalogImageReferenceEntry(plan, 0));
  const image: CollectionDoc = {
    _id: 'image',
    publishedRefCount: base,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 4,
      pending,
    },
    imageMutationOwner: 'same-mutex-owner',
    imageMutationStartedAt: '2026-10-18T00:00:00.000Z',
    storagePath: 'private/original.png',
    status: 'active',
    updatedAt: '2026-10-18T00:00:00.000Z',
    checksumSha256: 'f'.repeat(64),
    privateValue: { nested: ['keep'] },
  };
  const rows: Record<string, CollectionDoc[]> = {
    images: [image],
    catalogDetailApprovals: plans
      .filter((_, index) => changes[index]?.committed)
      .map((plan) => plan.proof),
  };
  const calls: string[] = [];
  let writing = false;
  const tx = {
    get: async (collection: string, id: string) => {
      assert.equal(writing, false, 'all snapshot reads must precede image writes');
      calls.push(`get:${collection}:${id}`);
      assert.ok(
        collection === 'images' || collection === 'catalogDetailApprovals',
        'committed truth must not read actor/source/full operation root',
      );
      return structuredClone(rows[collection]?.find((row) => row._id === id) ?? null);
    },
    set: async (collection: string, row: CollectionDoc) => {
      writing = true;
      calls.push(`set:${collection}:${row._id}`);
      assert.equal(collection, 'images');
      rows.images = [structuredClone(row)];
    },
  };
  return {
    tx,
    image,
    rows,
    calls,
    plans,
    bytes: () => JSON.stringify(rows),
    reset: () => {
      writing = false;
      calls.length = 0;
    },
  };
}
const command = { action: 'read' as const, imageId: 'image' };

test('snapshot read applies every committed delta and keeps missing proof inactive without writes', async () => {
  const h = fixture(
    [
      { delta: 1, committed: true },
      { delta: -1, committed: true },
      { delta: 1, committed: false },
      { delta: 1, committed: true },
    ],
    2,
  );
  const before = h.bytes();
  const result = await runCatalogImageReferenceRead(h.tx, command);
  assert.equal(result.state, 'counted');
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 3);
  assert.equal(result.documentReads, 5);
  assert.equal(result.settled, false);
  assert.deepEqual(result.image, h.image);
  assert.equal(h.calls.length, 5);
  assert.equal(h.bytes(), before);
});

test('settlement atomically applies all committed deltas once, preserves inactive proof and private image fields', async () => {
  const h = fixture(
    [
      { delta: 1, committed: true },
      { delta: -1, committed: true },
      { delta: 1, committed: false },
    ],
    1,
  );
  const original = structuredClone(h.image);
  const result = await runCatalogImageReferenceRead(h.tx, { ...command, action: 'settle' });
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 1);
  assert.equal(result.settled, true);
  assert.equal(h.calls.length, 5);
  const remaining = h.plans[2];
  assert.ok(remaining);
  const expected = {
    ...original,
    publishedRefCount: 1,
    catalogPublishedReferenceLedger: {
      version: 'catalog-image-reference-ledger-v1',
      epoch: 5,
      pending: [catalogImageReferenceEntry(remaining, 0)],
    },
  };
  assert.deepEqual(h.rows.images?.[0], expected);
  assert.deepEqual(result.image, expected);
  const before = h.bytes();
  h.reset();
  const replay = await runCatalogImageReferenceRead(h.tx, { ...command, action: 'settle' });
  assert.equal(replay.settled, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.bytes(), before);
});

for (const action of ['read', 'settle'] as const) {
  test(`${action} keeps a genuinely absent counter as legacy and never invents zero`, async () => {
    const h = fixture([]);
    Reflect.deleteProperty(h.image, 'publishedRefCount');
    Reflect.deleteProperty(h.image, 'catalogPublishedReferenceLedger');
    const before = h.bytes();
    const result = await runCatalogImageReferenceRead(h.tx, { ...command, action });
    assert.equal(result.state, 'legacy');
    assert.equal(result.settled, false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.bytes(), before);
  });
  test(`${action} handles a missing image without any proof lookup or writes`, async () => {
    const h = fixture([]);
    h.rows.images = [];
    const result = await runCatalogImageReferenceRead(h.tx, { ...command, action });
    assert.equal(result.state, 'missing');
    assert.equal(result.settled, false);
    assert.equal(h.calls.length, 1);
  });
  for (const empty of ['absent', 'empty'] as const)
    test(`${action} keeps a counted ${empty} ledger read-only`, async () => {
      const h = fixture([], 3);
      if (empty === 'absent') Reflect.deleteProperty(h.image, 'catalogPublishedReferenceLedger');
      const before = h.bytes();
      const result = await runCatalogImageReferenceRead(h.tx, {
        ...command,
        action,
        maxDocumentOperations: 1,
      });
      assert.ok(result.state === 'counted');
      assert.equal(result.effectiveCount, 3);
      assert.equal(result.settled, false);
      assert.equal(result.documentReads, 1);
      assert.equal(h.bytes(), before);
    });
}

for (const count of [1, 20, 80])
  for (const action of ['read', 'settle'] as const)
    test(`${action} ${count} pending references fits its exact document budget`, async () => {
      const h = fixture(Array.from({ length: count }, () => ({ delta: 1, committed: true })));
      const budget = count + 1 + (action === 'settle' ? 1 : 0);
      const result = await runCatalogImageReferenceRead(h.tx, {
        ...command,
        action,
        maxDocumentOperations: budget,
      });
      assert.ok(result.state === 'counted');
      assert.equal(result.effectiveCount, count);
      assert.equal(result.documentReads, count + 1);
      assert.equal(h.calls.length, budget);
      const retry = fixture(Array.from({ length: count }, () => ({ delta: 1, committed: true })));
      const before = retry.bytes();
      await assert.rejects(
        runCatalogImageReferenceRead(retry.tx, {
          ...command,
          action,
          maxDocumentOperations: budget - 1,
        }),
      );
      assert.equal(retry.calls.length, 1, 'reject before fetching a proof set that cannot fit');
      assert.equal(retry.bytes(), before);
    });

for (const value of [undefined, null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
  test(`snapshot refuses present invalid counter ${String(value)} instead of legacy fallback`, async () => {
    const h = fixture([{ delta: 1, committed: true }]);
    h.image.publishedRefCount = value;
    const before = h.bytes();
    await assert.rejects(runCatalogImageReferenceRead(h.tx, command), CatalogImageReferenceError);
    assert.equal(h.calls.length, 1);
    assert.equal(h.bytes(), before);
  });

for (const damage of [
  'missing-counter',
  'undefined-ledger',
  'null-ledger',
  'duplicate-root',
  'wrong-image-member',
  'bad-proof',
  'wrong-proof-id',
  'proof-extra',
  '81-pending',
  'wrong-image-id',
] as const)
  test(`snapshot refuses ${damage} and never overwrites the image`, async () => {
    const h = fixture([{ delta: 1, committed: true }]);
    const ledger = h.image.catalogPublishedReferenceLedger as { pending: unknown[] };
    if (damage === 'missing-counter') Reflect.deleteProperty(h.image, 'publishedRefCount');
    if (damage === 'undefined-ledger') h.image.catalogPublishedReferenceLedger = undefined;
    if (damage === 'null-ledger') h.image.catalogPublishedReferenceLedger = null;
    if (damage === 'duplicate-root') ledger.pending.push(ledger.pending[0]);
    if (damage === '81-pending')
      ledger.pending = Array.from({ length: 81 }, () => ledger.pending[0]);
    if (damage === 'wrong-image-member')
      ledger.pending = [
        catalogImageReferenceEntry(buildCatalogImageReferencePlan(root(5), [], ['another']), 0),
      ];
    const proof = h.rows.catalogDetailApprovals?.[0];
    assert.ok(proof);
    if (damage === 'bad-proof') proof.treeRoot = 'b'.repeat(64);
    if (damage === 'proof-extra') proof.extra = 'not-an-immutable-proof';
    if (damage === 'wrong-proof-id') {
      const get = h.tx.get;
      h.tx.get = async (collection, id) => {
        const row = await get(collection, id);
        if (collection === 'catalogDetailApprovals' && row) row._id = 'b'.repeat(64);
        return row;
      };
    }
    if (damage === 'wrong-image-id') {
      const get = h.tx.get;
      h.tx.get = async (collection, id) => {
        const row = await get(collection, id);
        if (collection === 'images' && row) row._id = 'wrong-image';
        return row;
      };
    }
    const before = h.bytes();
    await assert.rejects(runCatalogImageReferenceRead(h.tx, { ...command, action: 'settle' }));
    assert.equal(h.bytes(), before);
    assert.ok(!h.calls.some((call) => call.startsWith('set:')));
  });

test('a missing proof is distinct from a failed proof read', async () => {
  const h = fixture([{ delta: 1, committed: false }]);
  const result = await runCatalogImageReferenceRead(h.tx, command);
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 0);
  h.reset();
  const get = h.tx.get;
  h.tx.get = async (collection, id) => {
    if (collection === 'catalogDetailApprovals') throw Error('owned proof read unavailable');
    return get(collection, id);
  };
  await assert.rejects(runCatalogImageReferenceRead(h.tx, command), /owned proof read unavailable/);
});

for (const input of [
  null,
  {},
  { ...command, imageId: '' },
  { ...command, imageId: '../private' },
  { ...command, imageId: 'image\n' },
  { ...command, maxDocumentOperations: 0 },
  { ...command, maxDocumentOperations: 99 },
  { ...command, maxDocumentOperations: 1.5 },
  { ...command, extra: true },
])
  test(`invalid reference snapshot command performs no IO: ${JSON.stringify(input)}`, async () => {
    const h = fixture([]);
    await assert.rejects(runCatalogImageReferenceRead(h.tx, input));
    assert.deepEqual(h.calls, []);
  });

test('reference proof fetches are bounded to four concurrent point reads', async () => {
  const h = fixture(Array.from({ length: 20 }, () => ({ delta: 1, committed: true })));
  const get = h.tx.get;
  let active = 0;
  let maximum = 0;
  h.tx.get = async (collection, id) => {
    if (collection !== 'catalogDetailApprovals') return get(collection, id);
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await get(collection, id);
    } finally {
      active--;
    }
  };
  const result = await runCatalogImageReferenceRead(h.tx, command);
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 20);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
});

test('reference snapshot captures the original scalar command before its first await', async () => {
  const h = fixture([{ delta: 1, committed: true }]);
  const input = { ...command, action: 'settle' };
  const get = h.tx.get;
  h.tx.get = async (collection, id) => {
    input.action = 'read';
    input.imageId = 'another';
    return get(collection, id);
  };
  const result = await runCatalogImageReferenceRead(h.tx, input);
  assert.ok(result.state === 'counted');
  assert.equal(result.settled, true);
  assert.equal(result.image._id, 'image');
});

test('committed reference truth does not consult expired or cancelled operation roots', async () => {
  const h = fixture([{ delta: 1, committed: true }]);
  h.rows.users = [{ _id: 'former-admin', status: 'suspended' }];
  h.rows.products = [{ _id: 'later-product', published: false }];
  h.rows.catalogDetailApprovals?.push({
    _id: root(1),
    operation: { cancelledAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
  });
  const result = await runCatalogImageReferenceRead(h.tx, { ...command, action: 'settle' });
  assert.ok(result.state === 'counted');
  assert.equal(result.effectiveCount, 1);
  assert.equal(h.calls.filter((call) => call.startsWith('get:catalogDetailApprovals:')).length, 1);
  assert.ok(!h.calls.some((call) => call.endsWith(`:${root(1)}`)));
});

test('an undefined proof response cannot masquerade as a confirmed missing document', async () => {
  const h = fixture([{ delta: 1, committed: true }]);
  const get = h.tx.get;
  await assert.rejects(
    runCatalogImageReferenceRead(
      {
        ...h.tx,
        get: async (collection, id) =>
          collection === 'catalogDetailApprovals'
            ? Reflect.get({}, 'missing')
            : get(collection, id),
      },
      command,
    ),
    CatalogImageReferenceError,
  );
});

test('a failed proof batch drains every started read before returning its failure', async () => {
  const h = fixture(Array.from({ length: 4 }, () => ({ delta: 1, committed: true })));
  const get = h.tx.get;
  let reads = 0;
  let active = 0;
  h.tx.get = async (collection, id) => {
    if (collection !== 'catalogDetailApprovals') return get(collection, id);
    const index = reads++;
    active++;
    try {
      if (index === 0) throw Error('owned first proof read failed');
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await get(collection, id);
    } finally {
      active--;
    }
  };
  await assert.rejects(
    runCatalogImageReferenceRead(h.tx, command),
    /owned first proof read failed/,
  );
  assert.equal(reads, 4);
  assert.equal(active, 0, 'transaction teardown must not race an unfinished point read');
});

test('an undefined image response cannot masquerade as a missing image', async () => {
  const h = fixture([]);
  await assert.rejects(
    runCatalogImageReferenceRead({ ...h.tx, get: async () => Reflect.get({}, 'missing') }, command),
    CatalogImageReferenceError,
  );
});
