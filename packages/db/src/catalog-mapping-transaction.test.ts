import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { categoryRuleId } from './catalog-classification.ts';
import { resolveCatalogMappingEvidence } from './catalog-mapping-transaction.ts';
import { type CategoryTransaction, runCategoryCommand } from './category-transaction.ts';

const now = '2026-09-18T12:00:00.000Z';
const mappingId = categoryRuleId('100');

function mapping(overrides: Partial<CollectionDoc> = {}): CollectionDoc {
  return {
    _id: mappingId,
    provider: 'alibaba',
    sourceTaxonomy: 'alibaba:icbu',
    sourceCategoryId: '100',
    productFamily: 'toys',
    subcategoryIds: ['toys-blocks'],
    reviewRequired: false,
    createdAt: now,
    updatedAt: now,
    notes: 'Keep this operator note',
    ...overrides,
  };
}

function registry(): CollectionDoc {
  return {
    _id: 'toys',
    family: 'toys',
    revision: 3,
    name: 'Toys',
    children: [{ id: 'toys-blocks', name: 'Blocks', slug: 'blocks', order: 0, status: 'active' }],
    updatedAt: now,
    metadata: 'retain registry metadata',
  };
}

function command(data: Record<string, unknown> = { notes: 'Changed' }) {
  return { kind: 'mapping', id: mappingId, expectedUpdatedAt: now, data };
}

function fixture(stored: CollectionDoc | null = mapping()) {
  const buckets: Record<string, Record<string, CollectionDoc>> = {
    users: { admin: { _id: 'admin', role: 'admin', status: 'active', name: 'Operator' } },
    sourceCategoryMappings: stored ? { [stored._id]: structuredClone(stored) } : {},
    catalogTaxonomies: { toys: registry() },
    products: {
      product: {
        _id: 'product',
        productFamily: 'toys',
        subcategoryIds: ['toys-blocks'],
        published: true,
        price: 42,
        alibabaPrimarySourceKey: 'source',
        approval: { accepted: true },
      },
    },
  };
  const writes: { collection: string; row: CollectionDoc }[] = [];
  let queue = Promise.resolve();
  function run(input: unknown, actorId = 'admin', timestamp = now) {
    const pending = queue.then(async () => {
      const draft = structuredClone(buckets);
      const staged: typeof writes = [];
      const tx: CategoryTransaction = {
        async get(collection, id) {
          return structuredClone(draft[collection]?.[id] ?? null);
        },
        async set(collection, row) {
          staged.push({ collection, row: structuredClone(row) });
          draft[collection] ??= {};
          draft[collection][row._id] = structuredClone(row);
        },
      };
      const result = await runCategoryCommand(tx, actorId, input, timestamp);
      if (result.status === 'configured' || result.status === 'applied') {
        Object.assign(buckets, draft);
        writes.push(...staged);
      } else {
        assert.deepEqual(staged, [], 'Rejected commands must not attempt any writes');
      }
      return result;
    });
    queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  return { buckets, writes, run };
}

test('concurrent mapping edits have one winner; same-clock stale replay writes nothing', async () => {
  const current = fixture();
  const productsBefore = structuredClone(current.buckets.products);
  const results = await Promise.all([
    current.run(command({ notes: 'First' })),
    current.run(command({ subcategoryIds: [], productFamily: 'misc' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'applied').length, 1);
  assert.equal(results.filter((result) => result.status === 'conflict').length, 1);
  assert.equal(results[0]?.kind, 'mapping');
  const stored = current.buckets.sourceCategoryMappings?.[mappingId];
  assert.equal(stored?.notes, 'First');
  assert.equal(stored?.productFamily, 'toys');
  assert.deepEqual(stored?.subcategoryIds, ['toys-blocks']);
  assert.equal(stored?.updatedAt, '2026-09-18T12:00:00.001Z');
  current.writes.length = 0;
  assert.equal((await current.run(command({ notes: 'Stale replay' }))).status, 'conflict');
  assert.deepEqual(current.writes, []);
  assert.deepEqual(current.buckets.products, productsBefore);
});

test('concurrent deterministic creates cannot overwrite each other', async () => {
  const current = fixture(null);
  const { _id, createdAt: _created, updatedAt: _updated, ...data } = mapping();
  const create = { ...command(data), expectedUpdatedAt: null };
  const results = await Promise.all([current.run(create), current.run(create)]);
  assert.equal(results.filter((result) => result.status === 'configured').length, 1);
  assert.equal(results.filter((result) => result.status === 'conflict').length, 1);
  assert.equal(Object.keys(current.buckets.sourceCategoryMappings ?? {}).length, 1);
});

test('mapping saves fence both the validated taxonomy and current actor', async () => {
  const current = fixture();
  const result = await current.run(command());
  assert.equal(result.status, 'applied');
  assert.deepEqual(current.writes.map(({ collection }) => collection).sort(), [
    'catalogTaxonomies',
    'sourceCategoryMappings',
    'users',
  ]);
  assert.equal(current.buckets.catalogTaxonomies?.toys?.revision, 3);
  assert.equal(current.buckets.catalogTaxonomies?.toys?.metadata, 'retain registry metadata');
  assert.equal(current.buckets.users?.admin?.name, 'Operator');
  assert.equal(current.buckets.sourceCategoryMappings?.[mappingId]?.createdAt, now);
});

test('transaction validates the merged family and children, never the isolated patch', async () => {
  const current = fixture();
  const before = structuredClone(current.buckets);
  assert.equal((await current.run(command({ productFamily: 'misc' }))).status, 'invalid');
  assert.deepEqual(current.buckets, before);
  assert.deepEqual(current.writes, []);
});

test('archived children and revoked actors reject with zero writes', async () => {
  const current = fixture();
  const taxonomy = current.buckets.catalogTaxonomies?.toys;
  assert.ok(taxonomy);
  taxonomy.children = [
    { id: 'toys-blocks', name: 'Blocks', slug: 'blocks', order: 0, status: 'archived' },
  ];
  assert.equal((await current.run(command())).status, 'invalid');
  const users = current.buckets.users;
  assert.ok(users);
  for (const actor of [
    { _id: 'admin', role: 'contributor', status: 'active' },
    { _id: 'admin', role: 'admin', status: 'suspended' },
  ]) {
    users.admin = actor;
    assert.equal((await current.run(command())).status, 'forbidden');
  }
  assert.equal((await current.run(command(), 'missing')).status, 'forbidden');
  assert.deepEqual(current.writes, []);
});

test('invalid commands, timestamps and source identity edits never write', async () => {
  const current = fixture();
  for (const invalid of [
    { ...command(), extra: true },
    { ...command(), expectedUpdatedAt: undefined },
    { ...command(), id: ' bad ' },
    command({ provider: 'other' }),
    command({ sourceTaxonomy: 'other' }),
    command({ sourceCategoryId: '101' }),
    command({ _id: 'other' }),
    command({ notes: 'x'.repeat(17 * 1024) }),
  ]) {
    assert.equal((await current.run(invalid)).status, 'invalid');
  }
  assert.equal((await current.run(command(), 'admin', 'not-a-time')).status, 'invalid');
  assert.deepEqual(current.writes, []);
});

test('mapping evidence is pure, preserves the existing digest, and ignores transaction fences', () => {
  const row = mapping();
  const taxonomy = registry();
  const before = structuredClone({ row, taxonomy });
  const evidence = resolveCatalogMappingEvidence(row, taxonomy);
  assert.equal(evidence.status, 'ready');
  assert.ok(evidence.status === 'ready');
  assert.equal(
    evidence.mapping.revision,
    createHash('sha256')
      .update(
        JSON.stringify([
          mappingId,
          'alibaba',
          'alibaba:icbu',
          '100',
          'toys',
          ['toys-blocks'],
          undefined,
          false,
          undefined,
          now,
        ]),
      )
      .digest('hex'),
  );
  assert.deepEqual({ row, taxonomy }, before);
  assert.deepEqual(
    resolveCatalogMappingEvidence({ ...row, categoryAssignmentFence: 'other' }, taxonomy),
    evidence,
  );
  assert.notDeepEqual(
    resolveCatalogMappingEvidence({ ...row, subcategoryIds: [] }, taxonomy),
    evidence,
  );
  assert.notDeepEqual(
    resolveCatalogMappingEvidence({ ...row, updatedAt: '2026-09-18T12:00:00.001Z' }, taxonomy),
    evidence,
  );
});

test('mapping evidence rejects archived or wrong-family registries and manual review', () => {
  assert.equal(
    resolveCatalogMappingEvidence(mapping({ reviewRequired: true }), registry()).status,
    'review-required',
  );
  assert.equal(
    resolveCatalogMappingEvidence(mapping(), { ...registry(), family: 'misc' }).status,
    'invalid',
  );
  assert.equal(
    resolveCatalogMappingEvidence(mapping(), {
      ...registry(),
      children: [
        { id: 'toys-blocks', name: 'Blocks', slug: 'blocks', order: 0, status: 'archived' },
      ],
    }).status,
    'invalid',
  );
});

test('backward clocks still advance revisions and valid legacy mapping IDs remain editable', async () => {
  const current = fixture(mapping({ _id: 'legacy-id' }));
  assert.equal(
    (
      await current.run(
        { ...command({ notes: 'Legacy edit' }), id: 'legacy-id' },
        'admin',
        '2026-09-18T11:00:00.000Z',
      )
    ).status,
    'applied',
  );
  assert.equal(
    current.buckets.sourceCategoryMappings?.['legacy-id']?.updatedAt,
    '2026-09-18T12:00:00.001Z',
  );
});

test('foreign taxonomies retain mutable source identities but cannot take deterministic Alibaba IDs', async () => {
  const current = fixture(mapping({ _id: 'foreign', sourceTaxonomy: 'alibaba:other' }));
  assert.equal(
    (await current.run({ ...command({ sourceCategoryId: 'other-category' }), id: 'foreign' }))
      .status,
    'applied',
  );
  const empty = fixture(null);
  assert.equal(
    (
      await empty.run({
        ...command({ provider: 'alibaba', sourceTaxonomy: 'alibaba:other', productFamily: 'toys' }),
        expectedUpdatedAt: null,
      })
    ).status,
    'invalid',
  );
  assert.deepEqual(empty.writes, []);
});

for (const changedCollection of ['catalogTaxonomies', 'users']) {
  test(`a concurrent ${changedCollection} change aborts mapping commit and retry writes nothing`, async () => {
    const current = fixture();
    const before = structuredClone(current.buckets);
    const snapshot = structuredClone(current.buckets);
    const staged: { collection: string; row: CollectionDoc }[] = [];
    const committed: typeof staged = [];
    let markRead!: () => void;
    let markChanged!: () => void;
    const hasRead = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      markChanged = resolve;
    });
    const tx: CategoryTransaction = {
      async get(collection, id) {
        if (collection === 'catalogTaxonomies') {
          markRead();
          await changed;
        }
        return structuredClone(snapshot[collection]?.[id] ?? null);
      },
      async set(collection, row) {
        staged.push({ collection, row });
      },
    };
    const pending = (async () => {
      const result = await runCategoryCommand(tx, 'admin', command(), now);
      assert.equal(result.status, 'applied');
      for (const { collection, row } of staged) {
        assert.deepEqual(
          current.buckets[collection]?.[row._id],
          snapshot[collection]?.[row._id],
          'snapshot write conflict',
        );
      }
      committed.push(...staged);
      return result;
    })();
    await hasRead;
    if (changedCollection === 'catalogTaxonomies') {
      current.buckets.catalogTaxonomies = {
        toys: {
          ...registry(),
          revision: 4,
          children: [
            { id: 'toys-blocks', name: 'Blocks', slug: 'blocks', order: 0, status: 'archived' },
          ],
        },
      };
    } else {
      current.buckets.users = { admin: { _id: 'admin', role: 'contributor', status: 'active' } };
    }
    markChanged();
    await assert.rejects(pending, /snapshot write conflict/);
    assert.deepEqual(committed, []);
    assert.deepEqual(current.buckets.sourceCategoryMappings, before.sourceCategoryMappings);
    assert.deepEqual(current.buckets.products, before.products);
    assert.equal(
      (await current.run(command())).status,
      changedCollection === 'catalogTaxonomies' ? 'invalid' : 'forbidden',
    );
    assert.deepEqual(current.writes, []);
  });
}
