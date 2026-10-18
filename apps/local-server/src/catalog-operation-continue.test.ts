import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
  prepareCatalogProductOperationApproval,
  setAdapter,
} from '@vibelingan-channel/db';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import {
  createCatalogSourcePreparer,
  createOwnedCatalogSourcePreparer,
  readCompleteAlibabaDetailPlan,
} from '../../functions/admin/src/catalog-detail-source.ts';
import { continueAdminCatalogProductOperation } from '../../functions/admin/src/catalog-product-operation-continue.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { JsonFileAdapter } from './json-adapter.ts';

const at = '2026-10-18T00:00:00.000Z';
const operationId = '12345678-1234-4234-8234-123456789012';
async function workspace(t: TestContext, count?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-owned-continue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const productId = count === undefined ? 'manual' : 'read-product';
  const rows =
    count === undefined
      ? {
          users: [{ _id: 'admin', role: 'admin', status: 'active' }],
          products: [
            {
              _id: productId,
              name: 'Clock',
              description: 'Original draft',
              productFamily: 'misc',
              published: false,
              archived: false,
              imageIds: ['image'],
              updatedAt: at,
              catalogPricingMode: 'manual',
              manualCatalogPricing: {
                schemaVersion: 'manual-catalog-pricing-v1',
                currency: 'USD',
                tiers: [{ minQuantity: 1, unitAmountMinor: 300 }],
              },
            },
          ],
          images: [
            { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
          ],
        }
      : sourceFixture(count).adapter.rows;
  const product = rows.products?.[0];
  assert.ok(product);
  Object.assign(product, { archived: false, imageIds: ['image'], updatedAt: at });
  rows.images = [
    { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
  ];
  writeFileSync(file, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const config = { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const invoke = (data: unknown) =>
    handleAdminRequest({ action: 'catalogDetailApproval', token, data }, config);
  const start = async (
    intent: 'publish' | 'save-draft' = 'publish',
    values: Record<string, unknown> = { description: 'My saved draft' },
  ) => {
    const response = await invoke({
      action: 'product-operation-start',
      productId,
      operationId,
      intent,
      expectedUpdatedAt: at,
      values,
    });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    return { productId, operationId, inputDigest: status.inputDigest };
  };
  return { adapter, file, productId, invoke, start, bytes: () => readFileSync(file, 'utf8') };
}

test('actual Admin continue saves a manual draft and attaches preparation to the same immutable operation', async (t) => {
  const h = await workspace(t);
  const scope = await h.start();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.equal(status.state, 'staging');
  assert.equal(status.current, true);
  assert.equal(status.operationId, operationId);
  assert.equal(status.inputDigest, scope.inputDigest);
  assert.ok(status.state === 'staging');
  assert.deepEqual(status.approval.configurations, { completed: 0, total: 0 });
  assert.equal(status.approval.mediaReady, false);
  const product = await h.adapter.get('products', h.productId);
  assert.equal(product?.description, 'My saved draft');
  assert.equal(product?.published, false);
  const roots = JSON.parse(h.bytes()).catalogDetailApprovals.filter(
    (row: { operationId?: string }) => row.operationId === operationId,
  );
  assert.equal(roots.length, 1);
  assert.equal(roots[0].state, 'staging');
  assert.equal(roots[0].operation.values.description, 'My saved draft');
  assert.equal('record' in status, false);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4096);
});

for (const count of [0, 21, 105])
  test(`actual Admin continue prepares every Alibaba configuration before seeding the same root (${count})`, async (t) => {
    const h = await workspace(t, count);
    const scope = await h.start();
    const original = h.adapter.get.bind(h.adapter);
    let variants = 0;
    h.adapter.get = async (collection, id) => {
      if (collection === 'productVariants') variants++;
      return original(collection, id);
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.configurations.total, Math.ceil(count / 20));
    assert.equal(status.approval.configurations.completed, 0);
    assert.equal(variants, 0);
    const root = JSON.parse(h.bytes()).catalogDetailApprovals.find(
      (row: { operationId?: string }) => row.operationId === operationId,
    );
    assert.equal(root.variantIds.length, count);
    assert.equal(new Set(root.variantIds).size, count);
    const product = await h.adapter.get('products', h.productId);
    assert.equal(product?.published, false);
    assert.equal(product?.description, 'My saved draft');
  });

test('reopened prepared operation returns the same bounded status without redoing source work', async (t) => {
  const h = await workspace(t, 21);
  const scope = await h.start();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  assert.deepEqual(await h.invoke({ ...scope, action: 'product-operation-continue' }), response);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

test('source preparation after an existing bound save preserves website fields and its frozen saved snapshot', async (t) => {
  const h = await workspace(t, 21);
  const scope = await h.start();
  const saved = await h.invoke({ ...scope, action: 'product-operation-save' });
  assert.ok(saved.ok);
  const before = await h.adapter.get('products', h.productId);
  assert.ok(before);
  const root = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const after = await h.adapter.get('products', h.productId);
  assert.ok(after);
  for (const key of [
    'description',
    'name',
    'published',
    'archived',
    'updatedAt',
    'catalogContentGeneration',
    'catalogLifecycleVersion',
    'catalogClassificationRevision',
    'productFamily',
    'category',
    'subcategoryIds',
  ]) {
    assert.equal(Object.hasOwn(after, key), Object.hasOwn(before, key));
    assert.deepEqual(after[key], before[key]);
  }
  const next = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  assert.deepEqual(next.operation, root.operation);
  assert.deepEqual(next.saved, root.saved);
});

test('save-draft continue stops at saved without preparing or approving', async (t) => {
  const h = await workspace(t);
  const scope = await h.start('save-draft');
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(CatalogProductOperationStatusSchema.parse(response.data).state, 'saved');
  assert.equal((await h.adapter.get('products', h.productId))?.detailSourceReady, false);
  assert.equal((await h.adapter.get('products', h.productId))?.detailSourceManifest, undefined);
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
});

for (const extra of [
  { prepared: {} },
  { values: { published: true } },
  { actorId: 'other' },
  { expectedDigest: 'a'.repeat(64) },
  { page: 20 },
])
  test(`continue cannot accept browser-owned ${Object.keys(extra).join(',')}`, async (t) => {
    const h = await workspace(t);
    const scope = await h.start();
    const before = h.bytes();
    const response = await h.invoke({ ...scope, action: 'product-operation-continue', ...extra });
    assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });

test('cancelled operation cannot continue or create a separate approval', async (t) => {
  const h = await workspace(t);
  const scope = await h.start();
  assert.ok((await h.invoke({ ...scope, action: 'product-operation-cancel' })).ok);
  const before = h.bytes();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
  assert.equal(h.bytes(), before);
});

test('source preparation stops after a completed page at its time budget and resumes the same operation', async (t) => {
  const h = await workspace(t, 105);
  const scope = await h.start();
  const prepare = createCatalogSourcePreparer();
  let now = 0;
  const result = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      now: () => now,
      prepare: async (actor, input) => {
        const response = await prepare(actor, input);
        now = 13000;
        return response;
      },
    },
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.state, 'saved');
  const partial = await h.adapter.get('products', h.productId);
  assert.equal(partial?.detailSourceReady, false);
  assert.equal(partial?.detailSourceNextPage, 1);
  assert.equal(partial?.published, false);
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  const status = CatalogProductOperationStatusSchema.parse(resumed.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.configurations.total, 6);
  assert.equal(status.operationId, operationId);
});

test('zero time budget performs no save or preparation and returns the original reserved status', async (t) => {
  const h = await workspace(t);
  const scope = await h.start();
  const before = h.bytes();
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      now: () => 0,
    },
    0,
  );
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(response.state, 'reserved');
  assert.equal(h.bytes(), before);
});

test('candidate reading drains its current batch but starts no new batch or approval after budget expiry', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const scope = await h.start('publish', {});
  let now = 0;
  let variants = 0;
  const original = h.adapter.get.bind(h.adapter);
  h.adapter.get = async (collection, id) => {
    const row = await original(collection, id);
    if (collection === 'productVariants') {
      variants++;
      now = 13000;
    }
    return row;
  };
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      now: () => now,
    },
  );
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(response.state, 'saved');
  assert.equal(variants, 8);
  assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals[0].state, 'saved');
  h.adapter.get = original;
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(CatalogProductOperationStatusSchema.parse(resumed.data).state, 'staging');
});

test('a ready source candidate skips source preparation and seeds the same saved operation', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const scope = await h.start('publish', {});
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  let preparations = 0;
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    if (input.action === 'source-page' || input.action === 'manual-source') preparations++;
    return original(actor, input);
  };
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(CatalogProductOperationStatusSchema.parse(response.data).state, 'staging');
  assert.equal(preparations, 0);
});

test('cancellation after shared source projection prevents owned approval without discarding the saved draft', async (t) => {
  const h = await workspace(t);
  const scope = await h.start();
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    const response = await original(actor, input);
    if (input.action === 'manual-source')
      assert.ok((await original(actor, { ...scope, action: 'operation-cancel' })).ok);
    return response;
  };
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
  const roots = JSON.parse(h.bytes()).catalogDetailApprovals.filter(
    (row: { operationId?: string }) => row.operationId === operationId,
  );
  assert.equal(roots.length, 1);
  assert.equal(roots[0].state, 'saved');
  assert.equal(typeof roots[0].operation.cancelledAt, 'string');
  const product = await h.adapter.get('products', h.productId);
  assert.equal(product?.description, 'My saved draft');
  assert.equal(product?.published, false);
});

for (const change of ['edit', 'revoke', 'expire'])
  test(`continue refuses ${change} before preparation without writes`, async (t) => {
    const h = await workspace(t);
    const scope = await h.start();
    const rows = JSON.parse(h.bytes());
    if (change === 'edit') {
      rows.products[0].name = 'Another edit';
      rows.products[0].updatedAt = '2030-01-01T00:00:00.000Z';
    }
    if (change === 'revoke') rows.users[0].role = 'member';
    if (change === 'expire') rows.catalogDetailApprovals[0].createdAt = '2000-01-01T00:00:00.000Z';
    writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(!response.ok, JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });

test('manual configurations are refused explicitly and never disappear from an owned approval', async (t) => {
  const h = await workspace(t);
  const rows = JSON.parse(h.bytes());
  rows.productVariants = [
    {
      _id: 'manual-variant',
      productId: h.productId,
      archived: false,
      name: 'Manual configuration',
    },
  ];
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
  assert.match(response.error.message, /configurations/);
  const final = JSON.parse(h.bytes());
  assert.equal(final.productVariants[0]._id, 'manual-variant');
  assert.equal(final.catalogDetailApprovals[0].state, 'saved');
  assert.equal(final.products[0].published, false);
});

test('bad source remains a readable saved draft with a repair issue rather than creating an approval', async (t) => {
  const h = await workspace(t, 0);
  const rows = JSON.parse(h.bytes());
  rows.catalogSourceObservations[0].observation = { broken: true };
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!response.ok, JSON.stringify(response));
  assert.ok('issues' in response.error && response.error.issues?.length);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals[0].state, 'saved');
  assert.equal(final.products[0].description, 'My saved draft');
  assert.equal(final.products[0].published, false);
  assert.deepEqual(final.catalogSourceObservations[0].observation, { broken: true });
  const query = await h.invoke({
    action: 'product-operation-get',
    productId: h.productId,
    operationId,
  });
  assert.ok(query.ok);
  assert.equal(CatalogProductOperationStatusSchema.parse(query.data).state, 'saved');
});

test('a committed approval seed whose answer is lost reopens as the same staging operation without writes', async (t) => {
  const h = await workspace(t, 21);
  const scope = await h.start();
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    const response = await original(actor, input);
    if (input.action === 'operation-approval-begin' && response.ok)
      throw Error('controlled owned seed committed answer lost');
    return response;
  };
  const first = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!first.ok);
  assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals[0].state, 'staging');
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(CatalogProductOperationStatusSchema.parse(resumed.data).state, 'staging');
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

for (const change of ['cancel', 'edit'])
  test(`seed response cannot report active progress after a concurrent ${change}`, async (t) => {
    const h = await workspace(t);
    const scope = await h.start();
    const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
    h.adapter.persistCatalogDetailApproval = async (actor, input) => {
      const response = await original(actor, input);
      if (input.action === 'operation-approval-begin' && response.ok) {
        if (change === 'cancel')
          assert.ok((await original(actor, { ...scope, action: 'operation-cancel' })).ok);
        else {
          const product = await h.adapter.get('products', h.productId);
          assert.ok(product);
          const saved = await h.adapter.saveCatalogProductWithIdentities({
            mode: 'update',
            productId: h.productId,
            data: { description: 'Later editor' },
            expectedUpdatedAt: typeof product.updatedAt === 'string' ? product.updatedAt : null,
          });
          assert.equal(saved.result, 'saved');
        }
      }
      return response;
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
    const queried = await h.invoke({
      action: 'product-operation-get',
      productId: h.productId,
      operationId,
    });
    assert.ok(queried.ok);
    assert.equal(CatalogProductOperationStatusSchema.parse(queried.data).current, false);
    const product = await h.adapter.get('products', h.productId);
    assert.equal(product?.published, false);
    assert.equal(product?.description, change === 'edit' ? 'Later editor' : 'My saved draft');
  });

for (const reason of ['changed', 'removed'])
  test(`preparing an owned approval retains ${reason} supplier review and its exact keep choice`, async (t) => {
    const h = await workspace(t, 0);
    const rows = JSON.parse(h.bytes());
    const observation = rows.catalogSourceObservations[0].observation;
    Object.assign(rows.products[0], {
      description: observation.content.description.text,
      alibabaReviewPending: true,
      alibabaReviewReason: reason,
    });
    writeFileSync(h.file, JSON.stringify(rows));
    const scope = await h.start();
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.equal(status.state, 'staging');
    const final = JSON.parse(h.bytes());
    assert.equal(final.products[0].alibabaReviewPending, true);
    assert.equal(final.products[0].alibabaReviewReason, reason);
    assert.equal(final.products[0].published, false);
    assert.equal(final.images[0].publishedRefCount, 0);
    assert.deepEqual(final.catalogSourceObservations[0].observation, observation);
    const root = final.catalogDetailApprovals.find(
      (row: { operationId?: string }) => row.operationId === operationId,
    );
    assert.equal(root.operation.values.supplierDecisions.description.choice, 'keep');
    assert.deepEqual(final.products[0].supplierDecisions, root.operation.values.supplierDecisions);
    assert.equal(Object.hasOwn(final.products[0], 'alibabaReviewedAt'), false);
    assert.equal(Object.hasOwn(final.products[0], 'alibabaReviewedByUserId'), false);
  });

for (const warm of [false, true])
  test(`owned initialization uses the canonical full source plan without cached SKU point reads (warm=${warm})`, async (t) => {
    const count = warm ? 21 : 105;
    const h = await workspace(t, count);
    if (warm)
      for (let page = 0; page < Math.ceil(count / 20); page++)
        assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
    const scope = await h.start('publish', warm ? {} : { description: 'My saved draft' });
    const original = h.adapter.get.bind(h.adapter);
    let skuReads = 0;
    let observationReads = 0;
    h.adapter.get = async (collection, id) => {
      if (collection === 'productVariants') {
        skuReads++;
        throw Error('initialization must not read each cached SKU');
      }
      if (collection === 'catalogSourceObservations') observationReads++;
      return original(collection, id);
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.configurations.total, Math.ceil(count / 20));
    assert.equal(skuReads, 0);
    assert.equal(observationReads, 1);
    for (let page = 0; page < Math.ceil(count / 20); page++) {
      const staged = await persistCatalogDetailApproval('admin', {
        ...scope,
        action: 'operation-approval-page',
        page,
      });
      assert.ok(
        staged.ok && 'record' in staged && staged.record.state === 'staging',
        JSON.stringify(staged),
      );
      assert.equal(staged.record.nextPage, page + 1);
    }
    assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  });

test('a tampered cached configuration cannot become the authoritative frozen approval plan', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const rows = JSON.parse(h.bytes());
  const id = rows.products[0].detailSourceManifest.variantIds[0];
  const variant = rows.productVariants.find((row: { _id: string }) => row._id === id);
  assert.ok(variant);
  variant.detailSourceCandidate.options[0].value = 'Tampered cached option';
  variant.optionValues[variant.detailSourceCandidate.options[0].name] = 'Tampered cached option';
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(CatalogProductOperationStatusSchema.parse(response.data).state, 'staging');
  const before = h.bytes();
  const staged = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(!staged.ok && staged.code === 'CONFLICT', JSON.stringify(staged));
  assert.equal(h.bytes(), before);
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
});

test('new source data with a stale ready cache is projected before seeding the original operation', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const rows = JSON.parse(h.bytes());
  rows.catalogSourceObservations[0].observation.variants[0].options[0].value = 'New source color';
  rows.alibabaSourceProducts[0].contentHash = 'b'.repeat(64);
  rows.catalogSourceObservations[0].sourceContentHash = 'b'.repeat(64);
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const final = JSON.parse(h.bytes());
  const id = final.products[0].detailSourceManifest.variantIds[0];
  const variant = final.productVariants.find((row: { _id: string }) => row._id === id);
  assert.ok(variant);
  assert.equal(variant.detailSourceCandidate.options[0].value, 'New source color');
  const staged = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(staged.ok && 'record' in staged, JSON.stringify(staged));
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
});

test('a warm manual source cache cannot hide subsequently added manual configurations', async (t) => {
  const h = await workspace(t);
  assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page: 0 })).ok);
  const rows = JSON.parse(h.bytes());
  rows.productVariants = [{ _id: 'manual-sku', productId: h.productId, archived: false }];
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(
    !response.ok && /manual|configuration/i.test(response.error.message),
    JSON.stringify(response),
  );
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals[0].state, 'saved');
  assert.equal(final.products[0].published, false);
  assert.equal(final.productVariants[0]._id, 'manual-sku');
});

for (const field of [
  'key',
  'linkRevision',
  'sourceHash',
  'observationHash',
  'linkHash',
  'productId',
])
  test(`a trusted candidate with a mismatched ${field} cannot seed the original operation`, async (t) => {
    const h = await workspace(t, 0);
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page: 0 })).ok);
    const scope = await h.start('publish', {});
    assert.ok(
      (await manageCatalogProductOperation('admin', { ...scope, action: 'product-operation-save' }))
        .ok,
    );
    const source = createOwnedCatalogSourcePreparer();
    const before = h.bytes();
    const result = await prepareCatalogProductOperationApproval(
      'admin',
      scope,
      () => true,
      async (...args) => {
        const candidate = await source.readCandidate(...args);
        assert.ok(candidate.ok);
        assert.ok(candidate.source);
        if (field === 'productId') candidate.product._id = 'another-product';
        else
          Reflect.set(
            candidate.source,
            field,
            field === 'linkRevision' ? candidate.source.linkRevision + 1 : 'f'.repeat(64),
          );
        return candidate;
      },
    );
    assert.ok(!result.ok && result.code === 'CONFLICT', JSON.stringify(result));
    assert.equal(h.bytes(), before);
  });

test('candidate provenance excludes capture evidence and timestamps exactly as the original operation does', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const scope = await h.start('publish', {});
  const rows = JSON.parse(h.bytes());
  rows.catalogSourceObservations[0].observation.source.observedAt = '2026-10-19T00:00:00.000Z';
  rows.catalogSourceObservations[0].observation.evidence = [
    { kind: 'raw-payload', evidenceId: 'b'.repeat(64) },
  ];
  writeFileSync(h.file, JSON.stringify(rows));
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(CatalogProductOperationStatusSchema.parse(response.data).state, 'staging');
  assert.doesNotMatch(JSON.stringify(response), /raw-only|rows|sourceHash|linkHash|candidate/);
});

test('legacy source plan results expose no owned approval candidate or provenance', async (t) => {
  const h = await workspace(t, 21);
  const product = await h.adapter.get('products', h.productId);
  assert.ok(product);
  const result = await readCompleteAlibabaDetailPlan(h.productId, product);
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result).sort(), [
    'approvalPlan',
    'detail',
    'ok',
    'packet',
    'sourceMedia',
  ]);
  assert.equal(Object.hasOwn(result, 'candidate'), false);
  assert.equal(Object.hasOwn(result, 'rows'), false);
});

test('a missing cached configuration is rejected by its native page after canonical initialization', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const rows = JSON.parse(h.bytes());
  rows.productVariants.shift();
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  assert.ok((await h.invoke({ ...scope, action: 'product-operation-continue' })).ok);
  const before = h.bytes();
  const result = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(!result.ok && result.code === 'SOURCE_NOT_READY', JSON.stringify(result));
  assert.equal(h.bytes(), before);
});

test('a valid 4096-SKU source initializes without reading missing cache rows, which its native page still rejects', async (t) => {
  const count = 4096;
  const h = await workspace(t, count);
  const product = await h.adapter.get('products', h.productId);
  assert.ok(product);
  let preparedProduct: typeof product | undefined;
  const planned = await readCompleteAlibabaDetailPlan(h.productId, product, (candidate) => {
    preparedProduct = candidate.product;
  });
  assert.ok(planned.ok);
  assert.ok(preparedProduct);
  const rows = JSON.parse(h.bytes());
  rows.products[0] = preparedProduct;
  rows.productVariants = [];
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const original = h.adapter.get.bind(h.adapter);
  let cacheReads = 0;
  h.adapter.get = async (collection, id) => {
    if (collection === 'productVariants') {
      cacheReads++;
      throw Error('not an initialization read');
    }
    return original(collection, id);
  };
  const result = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(result.ok, JSON.stringify(result));
  const status = CatalogProductOperationStatusSchema.parse(result.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.configurations.total, 205);
  assert.equal(cacheReads, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  const before = h.bytes();
  const staged = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(!staged.ok && staged.code === 'SOURCE_NOT_READY', JSON.stringify(staged));
  assert.equal(h.bytes(), before);
  assert.equal((await original('products', h.productId))?.published, false);
});

test('owned source reading starts no next provider read after the observation exhausts its budget', async (t) => {
  const h = await workspace(t, 21);
  let allowed = true;
  const original = h.adapter.get.bind(h.adapter);
  const calls: string[] = [];
  h.adapter.get = async (collection, id) => {
    calls.push(collection);
    const row = await original(collection, id);
    if (collection === 'catalogSourceObservations') allowed = false;
    return row;
  };
  const source = createOwnedCatalogSourcePreparer();
  const before = h.bytes();
  const result = await source.readCandidate('admin', h.productId, () => allowed);
  assert.ok(!result.ok && result.code === 'SOURCE_NOT_READY');
  assert.deepEqual(calls, ['products', 'catalogSourceObservations']);
  assert.equal(h.bytes(), before);
});
