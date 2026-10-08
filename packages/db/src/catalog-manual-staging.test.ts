/** Manual products enter the same approval pipeline as synced ones (MIU-28). */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CatalogDetailPublicationSchema } from '@vibelingan-channel/shared/catalog-detail';
import { catalogApprovalDigest } from './catalog-detail-commit.ts';
import { prepareStagedApproval, runStagedApproval } from './catalog-detail-staging.ts';
import { sourceDigest } from './catalog-source-staging.ts';

const manualProduct = (extra: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'm1',
  name: 'Kids headset',
  description: 'Soft ear pads',
  imageIds: ['image'],
  productFamily: 'headphones',
  published: false,
  archived: false,
  skuCode: 'KH-01',
  series: 'S1',
  moq: 50,
  ...extra,
});

function harness(product: CollectionDoc, actorRole = 'admin') {
  let store: Record<string, Record<string, CollectionDoc>> = {
    products: { [product._id]: product },
    users: { actor: { _id: 'actor', role: actorRole } },
    images: {
      image: { _id: 'image', status: 'active', storageProvider: 'cloudbase-storage' },
    },
  };
  const writes: string[] = [];
  const run = async <T>(
    action: (tx: {
      get(collection: string, id: string): Promise<CollectionDoc | null>;
      set(collection: string, row: CollectionDoc): Promise<void>;
    }) => Promise<T>,
  ) => {
    const copy = structuredClone(store);
    const result = await action({
      get: async (collection, id) => structuredClone(copy[collection]?.[id] ?? null),
      set: async (collection, row) => {
        writes.push(`${collection}/${row._id}`);
        copy[collection] ??= {};
        copy[collection][row._id] = structuredClone(row);
      },
    });
    store = copy;
    return result;
  };
  const prepare = (configurationRowIds: string[] = []) =>
    run((tx) =>
      runStagedApproval(tx, 'actor', {
        action: 'manual-source',
        productId: product._id,
        configurationRowIds,
      }),
    );
  return { run, prepare, writes, product: () => store.products?.[product._id] as CollectionDoc };
}

test('manual prepare writes an empty manual candidate and is ready at once', async () => {
  const h = harness(manualProduct());
  const revision = sourceDigest(['manual', 'm1', 'v1']);
  assert.deepEqual(await h.prepare(), {
    ok: true,
    jobId: revision,
    revision,
    nextPage: 1,
    pages: 1,
    complete: true,
  });
  const saved = h.product();
  assert.equal(saved.detailSourceOwner, 'manual:m1');
  assert.equal(saved.detailSourceRevision, revision);
  assert.deepEqual(saved.detailSourceManifest, { revision, variantIds: [] });
  assert.equal(saved.detailSourceNextPage, 1);
  assert.equal(saved.detailSourceReady, true);
  assert.deepEqual(saved.detailSourceCandidate, {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'm1',
    name: 'Kids headset',
    images: [],
    facts: [],
    offers: [],
  });
  assert.equal(saved.detailSourceContentCandidate, null);
  assert.equal(saved.detailSourceNoteBlocksCandidate, null);
  assert.equal(saved.published, false, 'prepare never publishes');
});

test('a product unlinked from Alibaba drops its old source fingerprint on manual prepare', async () => {
  const h = harness(manualProduct({ detailSourcePublicDigest: 'f'.repeat(64) }));
  assert.equal((await h.prepare()).ok, true);
  assert.equal('detailSourcePublicDigest' in h.product(), false);
});

test('preparing again an already prepared manual product writes nothing', async () => {
  // CloudBase may report "0 updated" for an identical write, which the adapter
  // treats as a failure; an unchanged preparation is simply confirmed.
  const h = harness(manualProduct());
  const first = await h.prepare();
  const writes = h.writes.length;
  assert.deepEqual(await h.prepare(), first);
  assert.equal(h.writes.length, writes);
});

test('synced, archived and configured products, and non-admins, are refused without a write', async () => {
  const cases: Array<[CollectionDoc, string, string[], string]> = [
    [manualProduct({ alibabaPrimarySourceKey: 'source-a' }), 'admin', [], 'CONFLICT'],
    [manualProduct({ archived: true }), 'admin', [], 'CONFLICT'],
    // Only the not-yet-live Excel import creates configuration rows; approving
    // would drop them silently, so it is refused (DESIGN §5.2).
    [manualProduct(), 'admin', ['row-1'], 'VALIDATION_ERROR'],
    [manualProduct(), 'contributor', [], 'FORBIDDEN'],
  ];
  for (const [product, role, rows, code] of cases) {
    const h = harness(product, role);
    assert.deepEqual(await h.prepare(rows), { ok: false, code }, code);
    assert.deepEqual(h.writes, [], code);
  }
});

test('prepare → begin → finish approves a manual product with zero configurations', async () => {
  const h = harness(manualProduct());
  await h.prepare();
  const prepared = prepareStagedApproval(
    'actor',
    {
      productId: 'm1',
      operationId: '12345678-1234-4234-8234-123456789012',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(h.product(), []),
    },
    h.product(),
    [],
  );
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  const begin = await h.run((tx) =>
    runStagedApproval(tx, 'actor', { action: 'begin', prepared: prepared.value }),
  );
  assert.ok(begin.ok && 'pages' in begin && begin.pages === 0);
  const finish = await h.run((tx) =>
    runStagedApproval(tx, 'actor', { action: 'finish', jobId: prepared.value._id }),
  );
  assert.equal(finish.ok, true);
  const publication = CatalogDetailPublicationSchema.parse(h.product().catalogDetailPublication);
  assert.equal(publication.variantCount, 0);
  assert.deepEqual(publication.header.facts, [
    { name: 'SKU', value: 'KH-01' },
    { name: 'Series', value: 'S1' },
  ]);
  assert.deepEqual(publication.priceSummary, {
    source: 'website',
    pricing: { mode: 'unavailable', minimumOrderQuantity: 50 },
  }); // No supplier, so nothing to take from one later (MIU-39).
  const receipt = h.product().catalogDetailApprovalReceipt as Record<string, unknown>;
  assert.equal('supplierParts' in receipt, false);
});

test('a spec edit between begin and finish is a conflict', async () => {
  const h = harness(manualProduct());
  await h.prepare();
  const prepared = prepareStagedApproval(
    'actor',
    {
      productId: 'm1',
      operationId: '12345678-1234-4234-8234-123456789013',
      expectedRevision: null,
      expectedDigest: catalogApprovalDigest(h.product(), []),
    },
    h.product(),
    [],
  );
  assert.ok(prepared.ok);
  if (!prepared.ok) return;
  await h.run((tx) =>
    runStagedApproval(tx, 'actor', { action: 'begin', prepared: prepared.value }),
  );
  await h.run(async (tx) => {
    const row = await tx.get('products', 'm1');
    if (row) await tx.set('products', { ...row, series: 'S2' });
  });
  assert.deepEqual(
    await h.run((tx) =>
      runStagedApproval(tx, 'actor', { action: 'finish', jobId: prepared.value._id }),
    ),
    { ok: false, code: 'CONFLICT' },
  );
});
