import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import type { CollectionDoc, ProductFamily } from '@vibelingan-channel/shared';
import { PRODUCT_FAMILY_OPTIONS } from '@vibelingan-channel/shared';
import {
  type CatalogTaxonomy,
  CatalogTaxonomySchema,
  initialCatalogTaxonomy,
} from '../../shared/src/catalog-taxonomy.ts';
import { type CategoryTransaction, runCategoryCommand } from './category-transaction.ts';

const now = '2026-09-18T12:00:00.000Z';

function child(overrides: Partial<CatalogTaxonomy['children'][number]> = {}) {
  return {
    id: 'toys-blocks',
    name: 'Building Blocks',
    slug: 'building-blocks',
    order: 0,
    status: 'active' as const,
    ...overrides,
  };
}

function registry(overrides: Partial<CatalogTaxonomy> = {}): CatalogTaxonomy {
  return {
    family: 'toys',
    revision: 3,
    name: 'Toys',
    children: [child()],
    ...overrides,
  };
}

function save(candidate: CatalogTaxonomy = registry()) {
  return {
    kind: 'taxonomy' as const,
    operation: 'save' as const,
    family: candidate.family,
    expectedRevision: candidate.revision,
    name: candidate.name,
    children: candidate.children,
  };
}

function read(family: ProductFamily = 'toys') {
  return { kind: 'taxonomy' as const, operation: 'read' as const, family };
}

function fixture(stored?: CollectionDoc) {
  const products: Record<string, CollectionDoc> = {
    legacy: { _id: 'legacy', category: 'wired', name: 'Legacy product' },
    assigned: {
      _id: 'assigned',
      productFamily: 'toys',
      subcategoryIds: ['toys-blocks'],
      name: 'Assigned product',
      details: { untouched: ['first', 'second'] },
    },
  };
  const users: Record<string, CollectionDoc> = {
    admin: { _id: 'admin', role: 'admin', status: 'active' },
    contributor: { _id: 'contributor', role: 'contributor', status: 'active' },
    suspended: { _id: 'suspended', role: 'admin', status: 'suspended' },
  };
  const catalogTaxonomies: Record<string, CollectionDoc> = stored
    ? { [stored._id]: structuredClone(stored) }
    : {};
  const buckets: Record<string, Record<string, CollectionDoc>> = {
    users,
    products,
    catalogTaxonomies,
  };
  const writes: { collection: string; row: CollectionDoc }[] = [];
  const reads: { collection: string; id: string }[] = [];
  const tx: CategoryTransaction = {
    async get(collection, id) {
      reads.push({ collection, id });
      return structuredClone(buckets[collection]?.[id] ?? null);
    },
    async set(collection, row) {
      writes.push({ collection, row: structuredClone(row) });
      buckets[collection] ??= {};
      buckets[collection][row._id] = structuredClone(row);
    },
  };
  return { tx, buckets, users, products, catalogTaxonomies, writes, reads };
}

function storedRegistry(candidate: CatalogTaxonomy = registry()): CollectionDoc {
  return { ...candidate, _id: candidate.family, updatedAt: now, fence: 7 };
}

for (const family of PRODUCT_FAMILY_OPTIONS) {
  test(`${family}: missing registry reads are deterministic and never write`, async () => {
    const current = fixture();
    const expected = {
      kind: 'taxonomy',
      status: 'replayed',
      registry: initialCatalogTaxonomy(family),
    };
    assert.deepEqual(await runCategoryCommand(current.tx, 'admin', read(family), now), expected);
    assert.deepEqual(await runCategoryCommand(current.tx, 'admin', read(family), now), expected);
    assert.deepEqual(current.writes, []);
    assert.deepEqual(current.catalogTaxonomies, {});
    assert.ok(
      current.reads.every(({ collection }) => ['users', 'catalogTaxonomies'].includes(collection)),
    );
  });

  test(`${family}: stored registry reads select public registry fields`, async () => {
    const candidate = registry({ family });
    const current = fixture(storedRegistry(candidate));
    assert.deepEqual(await runCategoryCommand(current.tx, 'admin', read(family), now), {
      kind: 'taxonomy',
      status: 'replayed',
      registry: candidate,
    });
    assert.deepEqual(current.writes, []);
  });

  test(`${family}: first save creates only its registry and advances revision`, async () => {
    const current = fixture();
    const before = JSON.stringify(current.products);
    const candidate = initialCatalogTaxonomy(family);
    candidate.children.push(child({ id: `${family}-new` }));
    const expected = { ...candidate, revision: 1 };
    assert.deepEqual(await runCategoryCommand(current.tx, 'admin', save(candidate), now), {
      kind: 'taxonomy',
      status: 'configured',
      registry: expected,
    });
    assert.equal(current.writes.length, 1);
    assert.equal(current.writes[0]?.collection, 'catalogTaxonomies');
    assert.deepEqual(current.catalogTaxonomies[family], {
      ...expected,
      _id: family,
      updatedAt: now,
    });
    assert.equal(JSON.stringify(current.products), before);
  });
}

test('rename, reorder and archive retain identifiers, metadata and product bytes', async () => {
  const current = fixture(storedRegistry());
  current.catalogTaxonomies.misc = storedRegistry(registry({ family: 'misc' }));
  const productsBefore = JSON.stringify(current.products);
  const otherFamilyBefore = JSON.stringify(current.catalogTaxonomies.misc);
  const candidate = registry({
    name: 'Play',
    children: [child({ name: 'Construction Blocks', order: 4, status: 'archived' })],
  });
  const nextTime = '2026-09-18T13:00:00.000Z';
  const expected = { ...candidate, revision: 4 };
  assert.deepEqual(await runCategoryCommand(current.tx, 'admin', save(candidate), nextTime), {
    kind: 'taxonomy',
    status: 'applied',
    registry: expected,
  });
  assert.deepEqual(current.catalogTaxonomies.toys, {
    ...expected,
    _id: 'toys',
    updatedAt: nextTime,
    fence: 7,
  });
  assert.equal(JSON.stringify(current.products), productsBefore);
  assert.equal(JSON.stringify(current.catalogTaxonomies.misc), otherFamilyBefore);
  assert.equal(current.writes.length, 1);
});

test('stale saves conflict, including repeat and absent-registry requests', async () => {
  const current = fixture(storedRegistry());
  assert.equal((await runCategoryCommand(current.tx, 'admin', save(), now)).status, 'applied');
  current.writes.length = 0;
  const before = structuredClone(current.buckets);
  for (const revision of [0, 2, 3, 5]) {
    assert.deepEqual(
      await runCategoryCommand(current.tx, 'admin', save(registry({ revision })), now),
      {
        kind: 'taxonomy',
        status: 'conflict',
      },
    );
  }
  assert.deepEqual(current.buckets, before);
  assert.deepEqual(current.writes, []);
  const empty = fixture();
  assert.equal((await runCategoryCommand(empty.tx, 'admin', save(), now)).status, 'conflict');
  assert.deepEqual(empty.writes, []);
});

test('permissions are rechecked inside every read and save transaction', async () => {
  const current = fixture(storedRegistry());
  for (const actor of ['missing', 'contributor', 'suspended']) {
    for (const command of [read(), save()]) {
      assert.deepEqual(await runCategoryCommand(current.tx, actor, command, now), {
        kind: 'taxonomy',
        status: 'forbidden',
      });
    }
  }
  assert.equal((await runCategoryCommand(current.tx, 'admin', read(), now)).status, 'replayed');
  current.users.admin = { _id: 'admin', role: 'contributor', status: 'active' };
  assert.equal((await runCategoryCommand(current.tx, 'admin', save(), now)).status, 'forbidden');
  assert.deepEqual(current.writes, []);
});

test('malformed commands and unknown fields never write', async () => {
  const { expectedRevision: _revision, ...withoutRevision } = save();
  const { children: _children, ...withoutChildren } = save();
  const invalid: unknown[] = [
    { kind: 'taxonomy' },
    { ...read(), family: 'other' },
    { ...read(), operation: 'delete' },
    { ...read(), name: 'unexpected' },
    { ...save(), extra: true },
    { ...save(), registry: registry() },
    { ...save(), expectedRevision: -1 },
    { ...save(), expectedRevision: 0.5 },
    { ...save(), expectedRevision: '3' },
    { ...save(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...save(), children: null },
    { ...save(), children: [null] },
    { ...save(), children: [{ ...child(), family: 'misc' }] },
    { ...save(), name: ' Leading space' },
    { ...save(), children: [child({ name: '' })] },
    { ...save(), children: [child({ slug: 'Bad Slug' })] },
    { ...save(), children: [child({ order: -1 })] },
    { ...save(), children: [{ ...child(), status: 'deleted' }] },
    withoutRevision,
    withoutChildren,
  ];
  for (const command of invalid) {
    const current = fixture(storedRegistry());
    assert.deepEqual(await runCategoryCommand(current.tx, 'admin', command, now), {
      kind: 'taxonomy',
      status: 'invalid',
    });
    assert.deepEqual(current.writes, []);
  }
});

test('invalid timestamps never authorize or write', async () => {
  for (const timestamp of [
    '',
    'not-a-date',
    '2026-02-30T00:00:00.000Z',
    '2026-09-18',
    '2026-09-18T25:00:00Z',
  ]) {
    for (const command of [read(), save()]) {
      const current = fixture(storedRegistry());
      assert.deepEqual(await runCategoryCommand(current.tx, 'admin', command, timestamp), {
        kind: 'taxonomy',
        status: 'invalid',
      });
      assert.deepEqual(current.writes, []);
      assert.deepEqual(current.reads, []);
    }
  }
});

test('hard deletion, changed IDs, changed slugs and reparent payloads reject without writes', async () => {
  for (const children of [[], [child({ id: 'replacement' })], [child({ slug: 'changed' })]]) {
    for (const status of ['active', 'archived'] as const) {
      const current = fixture(storedRegistry(registry({ children: [child({ status })] })));
      const before = structuredClone(current.buckets);
      assert.equal(
        (await runCategoryCommand(current.tx, 'admin', save(registry({ children })), now)).status,
        'invalid',
      );
      assert.deepEqual(current.buckets, before);
      assert.deepEqual(current.writes, []);
    }
  }
  const current = fixture(storedRegistry());
  assert.equal(
    (await runCategoryCommand(current.tx, 'admin', { ...save(), targetFamily: 'misc' }, now))
      .status,
    'invalid',
  );
  assert.deepEqual(current.writes, []);
  const initial = fixture();
  assert.equal(
    (
      await runCategoryCommand(
        initial.tx,
        'admin',
        save({ ...initialCatalogTaxonomy('headphones'), children: [] }),
        now,
      )
    ).status,
    'invalid',
  );
  assert.deepEqual(initial.writes, []);
});

test('full candidate validates duplicates and child-count limits before any write', async () => {
  for (const children of [
    [child(), child({ name: 'Other', slug: 'other' })],
    [child(), child({ id: 'other', name: 'BUILDING BLOCKS', slug: 'other' })],
    [child(), child({ id: 'other', name: 'Other' })],
    [
      child(),
      ...Array.from({ length: 64 }, (_, index) =>
        child({ id: `child-${index}`, name: `Child ${index}`, slug: `child-${index}` }),
      ),
    ],
  ]) {
    const current = fixture(storedRegistry());
    assert.equal(
      (await runCategoryCommand(current.tx, 'admin', save(registry({ children })), now)).status,
      'invalid',
    );
    assert.deepEqual(current.writes, []);
  }
});

test('stored registry corruption fails closed on reads and saves', async () => {
  for (const corrupt of [
    { ...storedRegistry(), family: 'misc' },
    { ...storedRegistry(), revision: -1 },
    { ...storedRegistry(), revision: '3' },
    { ...storedRegistry(), children: null },
    { ...storedRegistry(), children: [child(), child()] },
    { ...storedRegistry(), children: [{ ...child(), hidden: true }] },
    { ...storedRegistry(), name: undefined },
  ]) {
    for (const command of [read(), save()]) {
      const current = fixture(corrupt);
      const before = structuredClone(current.buckets);
      assert.deepEqual(await runCategoryCommand(current.tx, 'admin', command, now), {
        kind: 'taxonomy',
        status: 'invalid',
      });
      assert.deepEqual(current.buckets, before);
      assert.deepEqual(current.writes, []);
    }
  }
});

test('revision overflow rejects the merged registry without writing', async () => {
  const candidate = registry({ revision: Number.MAX_SAFE_INTEGER });
  const current = fixture(storedRegistry(candidate));
  assert.equal(
    (await runCategoryCommand(current.tx, 'admin', save(candidate), now)).status,
    'invalid',
  );
  assert.deepEqual(current.writes, []);
});

test('UTF-8 request limit is 16 KiB, including valid candidates', async () => {
  function sizedCommand(byteLength: number) {
    const candidate = initialCatalogTaxonomy('toys');
    candidate.children = Array.from({ length: 64 }, (_, index) =>
      child({
        id: `toys-${index}`,
        name: `${index}${'\u4e2d'.repeat(51)}`,
        slug: `child-${index}`,
        order: index,
      }),
    );
    const command = save(candidate);
    const originalSize = Buffer.byteLength(JSON.stringify(command));
    let remaining = byteLength - originalSize;
    assert.ok(remaining >= 0);
    for (const entry of command.children) {
      const extra = Math.min(80 - entry.name.length, remaining);
      entry.name += 'x'.repeat(extra);
      remaining -= extra;
    }
    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(command)), byteLength);
    assert.equal(CatalogTaxonomySchema.safeParse(candidate).success, true);
    return command;
  }
  for (const byteLength of [16 * 1024, 16 * 1024 + 1]) {
    const current = fixture();
    const command = sizedCommand(byteLength);
    const result = await runCategoryCommand(current.tx, 'admin', command, now);
    assert.equal(result.status, byteLength === 16 * 1024 ? 'configured' : 'invalid');
    assert.equal(current.writes.length, byteLength === 16 * 1024 ? 1 : 0);
  }
});

test('serialization failures reject input without hiding transaction exceptions', async () => {
  const circular = { ...read(), self: {} };
  circular.self = circular;
  for (const input of [circular, { ...read(), unexpected: 1n }]) {
    const current = fixture();
    assert.equal((await runCategoryCommand(current.tx, 'admin', input, now)).status, 'invalid');
    assert.deepEqual(current.writes, []);
  }
  for (const failureAt of ['users', 'catalogTaxonomies', 'set']) {
    const current = fixture(storedRegistry());
    const failure = new Error(`transaction failure: ${failureAt}`);
    const tx: CategoryTransaction = {
      async get(collection, id) {
        if (collection === failureAt) throw failure;
        return current.tx.get(collection, id);
      },
      async set(collection, row) {
        if (failureAt === 'set') throw failure;
        await current.tx.set(collection, row);
      },
    };
    await assert.rejects(
      runCategoryCommand(tx, 'admin', save(), now),
      (error) => error === failure,
    );
    assert.deepEqual(current.writes, []);
  }
});

test('shared command and result schemas are strict and exported', async () => {
  const { CatalogTaxonomyCommandSchema, CatalogTaxonomyResultSchema } = await import(
    '../../shared/src/index.ts'
  );
  assert.equal(CatalogTaxonomyCommandSchema.safeParse(read()).success, true);
  assert.equal(CatalogTaxonomyCommandSchema.safeParse(save()).success, true);
  assert.equal(CatalogTaxonomyCommandSchema.safeParse({ ...save(), unknown: true }).success, false);
  for (const status of ['replayed', 'configured', 'applied'] as const) {
    const result = { kind: 'taxonomy', status, registry: registry() };
    assert.equal(CatalogTaxonomyResultSchema.safeParse(result).success, true);
    assert.equal(
      CatalogTaxonomyResultSchema.safeParse({ ...result, registry: storedRegistry() }).success,
      false,
    );
    assert.equal(
      CatalogTaxonomyResultSchema.safeParse({ ...result, unknown: true }).success,
      false,
    );
    assert.equal(
      CatalogTaxonomyResultSchema.safeParse({ kind: 'taxonomy', status }).success,
      false,
    );
  }
  for (const status of ['invalid', 'conflict', 'forbidden'] as const) {
    assert.equal(CatalogTaxonomyResultSchema.safeParse({ kind: 'taxonomy', status }).success, true);
    assert.equal(
      CatalogTaxonomyResultSchema.safeParse({ kind: 'taxonomy', status, registry: registry() })
        .success,
      false,
    );
  }
});
