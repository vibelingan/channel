import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { approveCatalogDetailInCloud, catalogApprovalDigest } from './catalog-detail-commit.ts';
import type { NodeSdkDatabase } from './cloudbase-adapter.ts';

function fixture(count = 2) {
  const variants: CollectionDoc[] = Array.from({ length: count }, (_, position) => {
    const id = `v${position}`;
    return {
      _id: id,
      productId: 'p',
      detailSourceOwner: 'alibaba:source',
      detailSourceRevision: 'source-r1',
      detailSourceMissing: false,
      position,
      sku: id,
      optionValues: { Color: `${position}` },
      imageIds: ['image'],
      detailSourceCandidate: {
        id,
        options: [],
        images: ['/api/images/image'],
        offers: [],
        inventory: { state: 'unknown' },
      },
      catalogDetailRevision: 'old',
      catalogDetailApproved: {
        id,
        options: [],
        images: [],
        offers: [],
        inventory: { state: 'unknown' },
      },
    };
  });
  const header = {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'p',
    name: 'Headset',
    images: ['/api/images/image'],
    facts: [],
    offers: [],
  };
  const product: CollectionDoc = {
    _id: 'p',
    name: 'Reviewed headset',
    description: '',
    productFamily: 'headphones',
    imageIds: ['image'],
    published: false,
    archived: false,
    detailSourceReady: true,
    detailSourceRevision: 'source-r1',
    detailSourceOwner: 'alibaba:source',
    detailSourceCandidate: header,
    detailSourceManifest: { revision: 'source-r1', variantIds: variants.map((v) => v._id) },
    catalogDetailPublication: { state: 'approved', revision: 'old', header, variantCount: count },
  };
  return {
    product,
    variants,
    command: {
      productId: 'p',
      operationId: '12345678-1234-4234-8234-123456789012',
      expectedRevision: 'old',
      expectedDigest: catalogApprovalDigest(product, variants),
    },
  };
}

function harness(count = 2) {
  const f = fixture(count);
  const state = {
    products: { p: f.product },
    productVariants: Object.fromEntries(f.variants.map((v) => [v._id, v])),
    users: { admin: { _id: 'admin', role: 'admin' } } as Record<string, CollectionDoc>,
    images: {
      image: {
        _id: 'image',
        status: 'active',
        storageProvider: 'cloudbase-storage',
        publishedRefCount: 0,
      },
    } as Record<string, CollectionDoc>,
  };
  let queue = Promise.resolve();
  let failAfter = Number.POSITIVE_INFINITY;
  let writes = 0;
  const db: NodeSdkDatabase = {
    command: { set: (value) => value },
    async runTransaction(operation) {
      const work = queue.then(async () => {
        const copy: Record<string, Record<string, CollectionDoc>> = structuredClone(state);
        const result = await operation({
          collection: (name) => ({
            doc: (id) => ({
              get: async () => ({ data: copy[name]?.[id] ? [copy[name][id]] : [] }),
              set: async (data) => {
                assert.ok(!Object.hasOwn(data, '_id'));
                assert.ok(copy[name]?.[id], 'approval must not create missing rows');
                copy[name][id] = { ...data, _id: id };
                writes++;
                if (writes >= failAfter) throw new Error('injected write failure');
                return { updated: 1 };
              },
              update: async () => {
                throw new Error('unexpected update');
              },
              remove: async () => {
                throw new Error('unexpected remove');
              },
            }),
          }),
        });
        Object.assign(state, copy);
        return result;
      });
      queue = work.then(
        () => {},
        () => {},
      );
      return work;
    },
  };
  const row = (collection: 'images' | 'productVariants', id: string) => {
    const found = state[collection][id];
    assert.ok(found);
    return found;
  };
  return {
    ...f,
    state,
    db,
    row,
    writeCount: () => writes,
    fail: (after: number) => {
      failAfter = after;
    },
    recover: () => {
      failAfter = Number.POSITIVE_INFINITY;
    },
  };
}

test('atomic approval replaces the complete snapshot without publishing or altering source/identity data', async () => {
  const h = harness();
  const result = await approveCatalogDetailInCloud(h.db, 'admin', h.command);
  assert.ok(result.ok);
  assert.notEqual(
    result.revision,
    h.command.operationId,
    'server revision is not a client retry key',
  );
  assert.deepEqual(result, {
    ok: true,
    productId: 'p',
    revision: result.revision,
    variants: 2,
    replayed: false,
  });
  assert.equal(h.state.products.p.published, false);
  assert.deepEqual(h.state.products.p.detailSourceCandidate, h.product.detailSourceCandidate);
  for (const row of Object.values(h.state.productVariants)) {
    assert.equal(row.catalogDetailRevision, result.revision);
    assert.equal(row.productId, 'p');
  }
  assert.equal(h.row('images', 'image').publishedRefCount, 0);
});

test('write failure leaves every old row intact and the same request can recover', async () => {
  const h = harness();
  const before = structuredClone(h.state);
  h.fail(2);
  await assert.rejects(approveCatalogDetailInCloud(h.db, 'admin', h.command), /injected/);
  assert.deepEqual(h.state, before);
  h.recover();
  assert.equal((await approveCatalogDetailInCloud(h.db, 'admin', h.command)).ok, true);
});

test('two administrators approving one old version have one winner; response-loss retry is idempotent', async () => {
  const h = harness();
  h.state.users['admin-2'] = { _id: 'admin-2', role: 'admin' };
  const other = { ...h.command, operationId: '22345678-1234-4234-8234-123456789012' };
  const results = await Promise.all([
    approveCatalogDetailInCloud(h.db, 'admin', h.command),
    approveCatalogDetailInCloud(h.db, 'admin-2', other),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results[1], { ok: false, code: 'CONFLICT' });
  const writes = h.writeCount();
  const retry = await approveCatalogDetailInCloud(h.db, 'admin', h.command);
  assert.equal(retry.ok && retry.replayed, true);
  assert.equal(h.writeCount(), writes);
  assert.deepEqual(
    await approveCatalogDetailInCloud(h.db, 'admin', {
      ...h.command,
      expectedDigest: 'a'.repeat(64),
    }),
    { ok: false, code: 'CONFLICT' },
  );
});

test('changed review fields or malformed ownership cannot be approved under an old digest', async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => {
      h.row('productVariants', 'v0').sku = 'changed';
    },
    (h: ReturnType<typeof harness>) => {
      h.row('productVariants', 'v0').productId = 'other-product';
    },
    (h: ReturnType<typeof harness>) => {
      h.row('productVariants', 'v0').detailSourceRevision = 'source-r2';
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.name = 'New unreviewed name';
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.detailSourceManifest = null;
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.detailSourceManifest = { revision: 'source-r1', variantIds: ['v0', 'v0'] };
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.detailSourceReady = false;
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.detailSourceRevision = 'another-header-generation';
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.archived = true;
    },
    (h: ReturnType<typeof harness>) => {
      h.state.products.p.published = true;
    },
  ]) {
    const h = harness();
    change(h);
    const before = structuredClone(h.state);
    assert.equal((await approveCatalogDetailInCloud(h.db, 'admin', h.command)).ok, false);
    assert.equal(h.writeCount(), 0);
    assert.deepEqual(h.state, before);
  }
});

test('missing, busy, corrupt or unavailable media reject before any writes', async () => {
  for (const patch of [
    null,
    { status: 'deleted' },
    { imageMutationOwner: 'worker', imageMutationStartedAt: new Date().toISOString() },
    { publishedRefCount: -1 },
    { publishedRefCount: '1' },
  ]) {
    const h = harness();
    if (patch === null) Reflect.deleteProperty(h.state.images, 'image');
    else Object.assign(h.row('images', 'image'), patch);
    assert.equal((await approveCatalogDetailInCloud(h.db, 'admin', h.command)).ok, false);
    assert.equal(h.writeCount(), 0);
  }
});

test('missing or suspended/non-admin actors cannot approve or replay a prior success', async () => {
  const h = harness();
  await approveCatalogDetailInCloud(h.db, 'admin', h.command);
  for (const actor of [
    undefined,
    { _id: 'admin', role: 'contributor' },
    { _id: 'admin', role: 'admin', status: 'suspended' },
  ]) {
    if (actor) h.state.users.admin = actor;
    else Reflect.deleteProperty(h.state.users, 'admin');
    assert.deepEqual(await approveCatalogDetailInCloud(h.db, 'admin', h.command), {
      ok: false,
      code: 'FORBIDDEN',
    });
  }
});

test('empty complete variant set works, oversized sets fail closed without truncating', async () => {
  const empty = harness(0);
  assert.equal((await approveCatalogDetailInCloud(empty.db, 'admin', empty.command)).ok, true);
  const large = harness(100);
  assert.deepEqual(await approveCatalogDetailInCloud(large.db, 'admin', large.command), {
    ok: false,
    code: 'APPROVAL_TOO_LARGE',
  });
  assert.equal(large.writeCount(), 0);
});

test('malformed commands do not start writes', async () => {
  const h = harness();
  for (const value of [
    null,
    undefined,
    '',
    {},
    { ...h.command, productId: ' p ' },
    { ...h.command, published: true },
  ])
    assert.deepEqual(await approveCatalogDetailInCloud(h.db, 'admin', value), {
      ok: false,
      code: 'VALIDATION_ERROR',
    });
  assert.equal(h.writeCount(), 0);
});

test('a failure at the final product write also rolls back the SKU and media writes', async () => {
  const h = harness();
  const before = structuredClone(h.state);
  h.fail(4); // image + two variants + product
  await assert.rejects(approveCatalogDetailInCloud(h.db, 'admin', h.command), /injected/);
  assert.deepEqual(h.state, before);
});

test('silent SDK write failure aborts; no partial product or variant version can commit', async () => {
  const h = harness();
  const before = structuredClone(h.state);
  const silent: NodeSdkDatabase = {
    ...h.db,
    runTransaction: (operation) =>
      h.db.runTransaction((tx) =>
        operation({
          collection: (name) => ({
            doc: (id) => {
              const ref = tx.collection(name).doc(id);
              return {
                ...ref,
                set: async (data) => {
                  await ref.set(data);
                  return { updated: 0 };
                },
              };
            },
          }),
        }),
      ),
  };
  await assert.rejects(approveCatalogDetailInCloud(silent, 'admin', h.command), /not confirmed/);
  assert.deepEqual(h.state, before);
});

test('stale historical retries cannot restore old content or reuse public revision IDs', async () => {
  const h = harness();
  const a = await approveCatalogDetailInCloud(h.db, 'admin', h.command);
  assert.ok(a.ok);
  const bCommand = {
    ...h.command,
    expectedRevision: a.revision,
    operationId: '22345678-1234-4234-8234-123456789012',
  };
  const b = await approveCatalogDetailInCloud(h.db, 'admin', bCommand);
  assert.ok(b.ok);
  assert.deepEqual(await approveCatalogDetailInCloud(h.db, 'admin', h.command), {
    ok: false,
    code: 'CONFLICT',
  });
  const c = await approveCatalogDetailInCloud(h.db, 'admin', {
    ...h.command,
    expectedRevision: b.revision,
  });
  assert.ok(c.ok);
  assert.notEqual(c.revision, a.revision);
  assert.notEqual(c.revision, b.revision);
});

test('transaction operation bound includes image reads/writes and never truncates the last SKU', async () => {
  const fits = harness(46); // 3 + 92 + 2 = 97
  assert.equal((await approveCatalogDetailInCloud(fits.db, 'admin', fits.command)).ok, true);
  const exceeds = harness(47); // 99 > reserved budget 98
  assert.deepEqual(await approveCatalogDetailInCloud(exceeds.db, 'admin', exceeds.command), {
    ok: false,
    code: 'APPROVAL_TOO_LARGE',
  });
  assert.equal(exceeds.writeCount(), 0);
});
