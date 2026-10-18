import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import {
  manageCatalogPreparationJob,
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
  prepareCatalogProductOperationApproval,
  setAdapter,
} from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import {
  type CatalogProductOperationBinding,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { finishOwnedMediaFixture } from '../../../packages/db/src/catalog-owned-media.fixture.ts';
import {
  createCatalogSourcePreparer,
  createOwnedCatalogSourcePreparer,
  readCompleteAlibabaDetailPlan,
} from '../../functions/admin/src/catalog-detail-source.ts';
import { runCatalogPreparationWorker } from '../../functions/admin/src/catalog-preparation-worker.ts';
import { continueAdminCatalogProductOperation } from '../../functions/admin/src/catalog-product-operation-continue.ts';
import { type AdminConfig, handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { importCandidateImage } from '../../functions/alibaba-catalog-sync/src/media-import.ts';
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
  return {
    adapter,
    file,
    productId,
    invoke,
    start,
    invokeWithConfig: (data: unknown, extra: Partial<AdminConfig>) =>
      handleAdminRequest({ action: 'catalogDetailApproval', token, data }, { ...config, ...extra }),
    bytes: () => readFileSync(file, 'utf8'),
  };
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
    assert.equal(status.approval.configurations.completed, Math.ceil(count / 20));
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
      media: bindMedia,
      configuration: stageConfiguration,
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
      media: bindMedia,
      configuration: stageConfiguration,
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
      media: bindMedia,
      configuration: stageConfiguration,
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

test('a committed approval seed whose answer is lost resumes its original configuration revision without reseeding', async (t) => {
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
  const beforeRoot = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  utimesSync(h.file, new Date(1000), new Date(1000));
  setAdapter(new JsonFileAdapter(h.file));
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.equal(CatalogProductOperationStatusSchema.parse(resumed.data).state, 'staging');
  const finalRoot = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  assert.equal(finalRoot.revision, beforeRoot.revision);
  assert.deepEqual(finalRoot.operation, beforeRoot.operation);
  assert.deepEqual(finalRoot.saved, beforeRoot.saved);
  assert.equal(finalRoot.nextPage, 2);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.deepEqual(await h.invoke({ ...scope, action: 'product-operation-continue' }), resumed);
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
      assert.equal(staged.record.nextPage, Math.ceil(count / 20));
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
  const response = await seedCurrent(scope);
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(CatalogProductOperationStatusSchema.parse(response).state, 'staging');
  const before = h.bytes();
  const staged = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(!staged.ok && staged.code === 'CONFLICT', JSON.stringify(staged));
  const continued = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.equal(continued.ok, false);
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
  assert.ok((await seedCurrent(scope)).ok);
  const before = h.bytes();
  const result = await persistCatalogDetailApproval('admin', {
    ...scope,
    action: 'operation-approval-page',
    page: 0,
  });
  assert.ok(!result.ok && result.code === 'SOURCE_NOT_READY', JSON.stringify(result));
  const continued = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.equal(continued.ok, false);
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
  const result = await seedCurrent(scope);
  assert.ok(result.ok, JSON.stringify(result));
  const status = CatalogProductOperationStatusSchema.parse(result);
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

for (const count of [0, 21, 105])
  test(`actual Admin continuation stages all configuration pages of its original operation (${count})`, async (t) => {
    const h = await workspace(t, count);
    const scope = await h.start();
    const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
    const pages: number[] = [];
    h.adapter.persistCatalogDetailApproval = async (actor, input) => {
      if (input.action === 'operation-approval-page') pages.push(input.page);
      return original(actor, input);
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.deepEqual(status.approval.configurations, {
      completed: Math.ceil(count / 20),
      total: Math.ceil(count / 20),
    });
    assert.deepEqual(
      pages,
      Array.from({ length: Math.ceil(count / 20) }, (_, page) => page),
    );
    assert.equal(status.approval.mediaReady, false);
    assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals.length, 1);
    assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  });

async function readySeed(h: Awaited<ReturnType<typeof workspace>>) {
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const scope = await h.start('publish', {});
  assert.ok(
    (await manageCatalogProductOperation('admin', { ...scope, action: 'product-operation-save' }))
      .ok,
  );
  const source = createOwnedCatalogSourcePreparer();
  const result = await prepareCatalogProductOperationApproval(
    'admin',
    scope,
    () => true,
    source.readCandidate,
  );
  assert.ok(result.ok && result.state === 'staging', JSON.stringify(result));
  return scope;
}

test('reopened configuration continuation starts at the first uncommitted page', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  assert.ok(
    (
      await persistCatalogDetailApproval('admin', {
        ...scope,
        action: 'operation-approval-page',
        page: 0,
      })
    ).ok,
  );
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const pages: number[] = [];
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    if (input.action === 'operation-approval-page') pages.push(input.page);
    return original(actor, input);
  };
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.configurations.completed, 2);
  assert.deepEqual(pages, [1]);
  const before = h.bytes();
  assert.deepEqual(await h.invoke({ ...scope, action: 'product-operation-continue' }), response);
  assert.equal(h.bytes(), before);
});

test('configuration continuation stops after its committed page exhausts the request budget', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  let now = 0;
  const pages: number[] = [];
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      now: () => now,
      media: bindMedia,
      configuration: async (actor, binding, page) => {
        pages.push(page);
        const result = await persistCatalogDetailApproval(actor, {
          ...binding,
          action: 'operation-approval-page',
          page,
        });
        now = 13000;
        return result;
      },
    },
  );
  assert.ok(response.ok && response.state === 'staging', JSON.stringify(response));
  assert.equal(response.approval.configurations.completed, 1);
  assert.deepEqual(pages, [0]);
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok);
  const status = CatalogProductOperationStatusSchema.parse(resumed.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.configurations.completed, 2);
});

for (const change of ['cancel', 'edit'])
  test(`configuration continuation starts no next page after a concurrent ${change}`, async (t) => {
    const h = await workspace(t, 21);
    const scope = await readySeed(h);
    const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
    const pages: number[] = [];
    h.adapter.persistCatalogDetailApproval = async (actor, input) => {
      const result = await original(actor, input);
      if (input.action === 'operation-approval-page') {
        pages.push(input.page);
        if (change === 'cancel')
          assert.ok((await original(actor, { ...scope, action: 'operation-cancel' })).ok);
        else {
          const product = await h.adapter.get('products', h.productId);
          assert.ok(product);
          assert.equal(
            (
              await h.adapter.saveCatalogProductWithIdentities({
                mode: 'update',
                productId: h.productId,
                expectedUpdatedAt: typeof product.updatedAt === 'string' ? product.updatedAt : null,
                data: { description: 'Concurrent editor' },
              })
            ).result,
            'saved',
          );
        }
      }
      return result;
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(!response.ok && response.error.code === 'CONFLICT', JSON.stringify(response));
    assert.deepEqual(pages, [0]);
    assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals[0].nextPage, 1);
    assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  });

test('a committed configuration page with a lost answer resumes the same revision without repeating its write', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const pages: number[] = [];
  const revision = JSON.parse(h.bytes()).catalogDetailApprovals[0].revision;
  let lost = false;
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    const result = await original(actor, input);
    if (input.action === 'operation-approval-page') {
      pages.push(input.page);
      if (!lost) {
        lost = true;
        throw Error('page committed, answer lost');
      }
    }
    return result;
  };
  assert.equal((await h.invoke({ ...scope, action: 'product-operation-continue' })).ok, false);
  assert.equal(JSON.parse(h.bytes()).catalogDetailApprovals[0].nextPage, 1);
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals[0].nextPage, 2);
  assert.equal(final.catalogDetailApprovals[0].revision, revision);
  assert.equal(final.catalogDetailApprovals.length, 1);
  assert.deepEqual(pages, [0, 1]);
  const before = h.bytes();
  assert.deepEqual(await h.invoke({ ...scope, action: 'product-operation-continue' }), response);
  assert.equal(h.bytes(), before);
});

test('an OK configuration reply without persisted cursor progress cannot loop or report success', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  const before = h.bytes();
  let calls = 0;
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      now: () => 0,
      media: bindMedia,
      configuration: async () => {
        calls++;
        return { ok: true };
      },
    },
  );
  assert.ok(!response.ok && response.code === 'CONFLICT', JSON.stringify(response));
  assert.equal(calls, 1);
  assert.equal(h.bytes(), before);
});

async function seedCurrent(scope: CatalogProductOperationBinding) {
  assert.ok(
    (await manageCatalogProductOperation('admin', { ...scope, action: 'product-operation-save' }))
      .ok,
  );
  const source = createOwnedCatalogSourcePreparer();
  return prepareCatalogProductOperationApproval('admin', scope, () => true, source.readCandidate);
}

async function stageConfiguration(
  actorId: string,
  scope: CatalogProductOperationBinding,
  page: number,
) {
  return persistCatalogDetailApproval(actorId, {
    ...scope,
    action: 'operation-approval-page',
    page,
  });
}

test('configuration continuation never starts a page when seed completion has exhausted the request budget', async (t) => {
  const h = await workspace(t, 21);
  for (let page = 0; page < 2; page++)
    assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page })).ok);
  const scope = await h.start('publish', {});
  let now = 0;
  let pages = 0;
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      prepare: createCatalogSourcePreparer(),
      now: () => now,
      seed: async (...args) => {
        const result = await prepareCatalogProductOperationApproval(...args);
        now = 13000;
        return result;
      },
      media: bindMedia,
      configuration: async (...args) => {
        pages++;
        return stageConfiguration(...args);
      },
    },
  );
  assert.ok(response.ok && response.state === 'staging', JSON.stringify(response));
  assert.equal(response.approval.configurations.completed, 0);
  assert.equal(pages, 0);
});

test('configuration continuation stops after the actor loses the stored admin role', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const pages: number[] = [];
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    const result = await original(actor, input);
    if (input.action === 'operation-approval-page') {
      pages.push(input.page);
      const rows = JSON.parse(h.bytes());
      rows.users[0].role = 'member';
      writeFileSync(h.file, JSON.stringify(rows));
    }
    return result;
  };
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(!response.ok && response.error.code === 'FORBIDDEN', JSON.stringify(response));
  assert.deepEqual(pages, [0]);
  assert.equal(JSON.parse(h.bytes()).products[0].published, false);
});

test('the controller dispatches the maximum legal 500 pages with server progress and no off-by-one call', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  const raw = await manageCatalogProductOperation('admin', {
    productId: scope.productId,
    operationId: scope.operationId,
    action: 'product-operation-get',
  });
  const current = CatalogProductOperationStatusSchema.parse(raw);
  assert.ok(current.state === 'staging');
  current.approval.configurations = { completed: 0, total: 500 };
  const before = h.bytes();
  const pages: number[] = [];
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: async () => structuredClone(current),
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      now: () => 0,
      media: bindMedia,
      configuration: async (_actor, binding, page) => {
        assert.deepEqual(binding, scope);
        assert.equal(page, pages.length);
        pages.push(page);
        current.approval.configurations.completed++;
        return { ok: true };
      },
    },
  );
  assert.ok(response.ok && response.state === 'staging', JSON.stringify(response));
  assert.equal(response.approval.configurations.completed, 500);
  assert.equal(pages.length, 500);
  assert.equal(pages.at(-1), 499);
  assert.equal(h.bytes(), before);
});

test('two actual Admin continuations of the same configuration operation converge on one complete cursor', async (t) => {
  const h = await workspace(t, 21);
  const scope = await readySeed(h);
  const results = await Promise.allSettled([
    h.invoke({ ...scope, action: 'product-operation-continue' }),
    h.invoke({ ...scope, action: 'product-operation-continue' }),
  ]);
  for (const result of results) {
    assert.equal(result.status, 'fulfilled');
    assert.ok(result.status === 'fulfilled');
    assert.ok(result.value.ok, JSON.stringify(result.value));
    const status = CatalogProductOperationStatusSchema.parse(result.value.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.configurations.completed, 2);
  }
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals.length, 1);
  assert.equal(final.catalogDetailApprovals[0].nextPage, 2);
  assert.equal(final.catalogDetailVariants.length, 21);
  assert.equal(
    new Set(final.catalogDetailVariants.map((row: { _id: string }) => row._id)).size,
    21,
  );
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
});

async function warmOwnedMedia(h: Awaited<ReturnType<typeof workspace>>, seedBeforeMedia = true) {
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.images[0], {
    name: 'original.png',
    storageProvider: 'local-disk',
    storageMode: 'local-disk',
    storageFileId: 'local-disk:source/original.png',
    storagePath: 'source/original.png',
    mimeType: 'image/png',
    byteSize: 123,
    checksumSha256: 'a'.repeat(64),
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  assert.ok(
    (await manageCatalogProductOperation('admin', { ...scope, action: 'product-operation-save' }))
      .ok,
  );
  assert.ok((await h.invoke({ action: 'prepare', productId: h.productId, page: 0 })).ok);
  if (seedBeforeMedia) {
    const seeded = await seedCurrent(scope);
    assert.ok(seeded.ok && seeded.state === 'staging', JSON.stringify(seeded));
  }
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-media-metadata-fixture',
    environmentId: 'owned-media-metadata-fixture',
  });
  // This fixture declares pixel health for protocol tests; it never reads image bytes.
  await finishOwnedMediaFixture(
    (command) =>
      manageCatalogPreparationJob(
        authority,
        command.action === 'start' ? { ...command, productId: h.productId } : command,
      ),
    h.adapter.get.bind(h.adapter),
    ['image'],
  );
  return scope;
}

test('actual Admin continuation transfers an existing ready media receipt into its original approval root', async (t) => {
  const h = await workspace(t);
  const scope = await warmOwnedMedia(h);
  const originalRoot = JSON.parse(h.bytes()).catalogDetailApprovals[0];
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  assert.equal(status.approval.references.prepared, false);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals.length, 1);
  assert.equal(final.catalogDetailApprovals[0].revision, originalRoot.revision);
  assert.deepEqual(final.catalogDetailApprovals[0].operation, originalRoot.operation);
  assert.deepEqual(final.catalogDetailApprovals[0].saved, originalRoot.saved);
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
  assert.doesNotMatch(
    JSON.stringify(response),
    /receiptId|bindingDigest|checksumSha256|storageFileId/,
  );
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  assert.deepEqual(await h.invoke({ ...scope, action: 'product-operation-continue' }), response);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

async function bindMedia(actorId: string, scope: CatalogProductOperationBinding) {
  return persistCatalogDetailApproval(actorId, { ...scope, action: 'operation-approval-media' });
}

for (const fault of ['missing-job', 'wrong-image-set', 'corrupt-completion'])
  test(`media continuation cannot authorize a ${fault} preparation receipt`, async (t) => {
    const h = await workspace(t);
    const scope = await warmOwnedMedia(h);
    const rows = JSON.parse(h.bytes());
    if (fault === 'missing-job') rows.catalogPreparationJobs = [];
    else if (fault === 'wrong-image-set')
      rows.products[0].catalogPreparationReport.seal.imageIdsDigest = 'f'.repeat(64);
    else rows.catalogPreparationJobs[0].completion.reportDigest = 'f'.repeat(64);
    writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.mediaReady, false);
    assert.equal(status.approval.references.prepared, false);
    assert.equal(h.bytes(), before);
    assert.equal(rows.products[0].published, false);
    assert.equal(rows.images[0].publishedRefCount, 0);
  });

for (const change of ['cancel', 'edit', 'revoke'])
  test(`media continuation refuses stale progress after a concurrent ${change}`, async (t) => {
    const h = await workspace(t);
    const scope = await warmOwnedMedia(h);
    const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
    let bindings = 0;
    h.adapter.persistCatalogDetailApproval = async (actor, input) => {
      const result = await original(actor, input);
      if (input.action === 'operation-approval-media') {
        assert.ok(result.ok);
        bindings++;
        if (change === 'cancel')
          assert.ok((await original(actor, { ...scope, action: 'operation-cancel' })).ok);
        else if (change === 'edit') {
          const product = await h.adapter.get('products', h.productId);
          assert.ok(product);
          assert.equal(
            (
              await h.adapter.saveCatalogProductWithIdentities({
                mode: 'update',
                productId: h.productId,
                expectedUpdatedAt: typeof product.updatedAt === 'string' ? product.updatedAt : null,
                data: { description: 'Later media editor' },
              })
            ).result,
            'saved',
          );
        } else {
          const rows = JSON.parse(h.bytes());
          rows.users[0].role = 'member';
          writeFileSync(h.file, JSON.stringify(rows));
        }
      }
      return result;
    };
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(
      !response.ok && response.error.code === (change === 'revoke' ? 'FORBIDDEN' : 'CONFLICT'),
      JSON.stringify(response),
    );
    assert.equal(bindings, 1);
    const final = JSON.parse(h.bytes());
    assert.equal(final.products[0].published, false);
    assert.equal(final.images[0].publishedRefCount, 0);
    assert.equal(final.catalogDetailApprovals[0].references, undefined);
  });

test('a committed media binding with its answer lost reopens without repeating a media write', async (t) => {
  const h = await workspace(t);
  const scope = await warmOwnedMedia(h);
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  let bindings = 0;
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    const result = await original(actor, input);
    if (input.action === 'operation-approval-media') {
      bindings++;
      throw Error('media committed, answer lost');
    }
    return result;
  };
  assert.equal((await h.invoke({ ...scope, action: 'product-operation-continue' })).ok, false);
  const before = h.bytes();
  utimesSync(h.file, new Date(1000), new Date(1000));
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  assert.equal(bindings, 1);
  assert.equal(h.bytes(), before);
  assert.equal(statSync(h.file).mtimeMs, 1000);
});

test('media binding I/O failures are never guessed as pending or ready', async (t) => {
  const h = await workspace(t);
  const scope = await warmOwnedMedia(h);
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  h.adapter.persistCatalogDetailApproval = async (actor, input) => {
    if (input.action === 'operation-approval-media') throw Error('media persistence unavailable');
    return original(actor, input);
  };
  const before = h.bytes();
  const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.equal(response.ok, false);
  assert.equal(h.bytes(), before);
  h.adapter.persistCatalogDetailApproval = original;
  const resumed = await h.invoke({ ...scope, action: 'product-operation-continue' });
  assert.ok(resumed.ok);
  const status = CatalogProductOperationStatusSchema.parse(resumed.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
});

test('an OK media reply without a persisted media binding is rejected', async (t) => {
  const h = await workspace(t);
  const scope = await warmOwnedMedia(h);
  const before = h.bytes();
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      configuration: stageConfiguration,
      media: async () => ({ ok: true }),
      now: () => 0,
    },
  );
  assert.ok(!response.ok && response.code === 'CONFLICT', JSON.stringify(response));
  assert.equal(h.bytes(), before);
});

test('budget exhausted during saved-status readback does not start a ready media transfer', async (t) => {
  const h = await workspace(t);
  const scope = await warmOwnedMedia(h);
  let bindings = 0;
  let now = 0;
  const before = h.bytes();
  const response = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: async (...args) => {
        const result = await manageCatalogProductOperation(...args);
        const command = args[1];
        if (
          command &&
          typeof command === 'object' &&
          Reflect.get(command, 'action') === 'product-operation-save'
        )
          now = 13000;
        return result;
      },
      seed: prepareCatalogProductOperationApproval,
      prepare: createCatalogSourcePreparer(),
      configuration: stageConfiguration,
      media: async (...args) => {
        bindings++;
        return bindMedia(...args);
      },
      now: () => now,
    },
  );
  assert.ok(response.ok && response.state === 'staging', JSON.stringify(response));
  assert.equal(response.approval.mediaReady, false);
  assert.equal(bindings, 0);
  assert.equal(h.bytes(), before);
});

for (const rebuildSource of [false, true])
  test(`a saved operation with ready media seeds and transfers the receipt (rebuild source=${rebuildSource})`, async (t) => {
    const h = await workspace(t);
    const scope = await warmOwnedMedia(h, false);
    const before = JSON.parse(h.bytes());
    assert.equal(before.catalogDetailApprovals[0].state, 'saved');
    if (rebuildSource) {
      before.products[0].detailSourceReady = false;
      writeFileSync(h.file, JSON.stringify(before));
    }
    const response = await h.invoke({ ...scope, action: 'product-operation-continue' });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.mediaReady, true);
    assert.equal(status.approval.references.prepared, false);
    const final = JSON.parse(h.bytes());
    assert.equal(final.catalogDetailApprovals.length, 1);
    assert.deepEqual(
      final.catalogDetailApprovals[0].operation,
      before.catalogDetailApprovals[0].operation,
    );
    assert.deepEqual(final.catalogDetailApprovals[0].saved, before.catalogDetailApprovals[0].saved);
    assert.equal(final.products[0].published, false);
    assert.equal(final.images[0].publishedRefCount, 0);
  });

for (const code of ['FORBIDDEN', 'CONFLICT', 'SOURCE_NOT_READY'])
  test(`media continuation preserves a native ${code} failure instead of reporting pending progress`, async (t) => {
    const h = await workspace(t);
    const scope = await warmOwnedMedia(h);
    const before = h.bytes();
    const response = await continueAdminCatalogProductOperation(
      'admin',
      { ...scope, action: 'product-operation-continue' },
      {
        operation: manageCatalogProductOperation,
        seed: prepareCatalogProductOperationApproval,
        prepare: createCatalogSourcePreparer(),
        configuration: stageConfiguration,
        media: async () => ({ ok: false, code }),
        now: () => 0,
      },
    );
    assert.ok(!response.ok && response.code === code, JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });

const ownedColdPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
async function coldOwnedMedia(h: Awaited<ReturnType<typeof workspace>>, importSource = false) {
  const storage = new LocalDiskMediaStorage(join(dirname(h.file), 'cold-media'));
  setMediaStorage(storage);
  const object = await storage.putObject({
    namespace: 'catalog',
    logicalId: 'image',
    fileName: 'sample.png',
    mimeType: 'image/png',
    content: ownedColdPng,
  });
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.images[0], object, {
    mimeType: 'image/png',
    byteSize: ownedColdPng.length,
    checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
  });
  if (importSource)
    rows.catalogSourceObservations[0].observation.variants[0].media = [
      { sourceUrl: 'https://sc04.alicdn.com/owned-cold-sku.png', position: 0, role: 'variant' },
    ];
  writeFileSync(h.file, JSON.stringify(rows));
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-cold-media',
    environmentId: 'owned-cold-media',
  });
  let invocations = 0;
  let fetches = 0;
  const config: Partial<AdminConfig> = {
    preparationAuthority: authority,
    preparationInvoke: async (call) => {
      invocations++;
      return {
        result: await runCatalogPreparationWorker(
          authority,
          call,
          importSource
            ? {
                importSourceImage: (url, persistImport) =>
                  importCandidateImage(url, {
                    persistImport,
                    resolveDns: async () => ['104.16.1.1'],
                    fetchImpl: async () => {
                      fetches++;
                      return new Response(new Uint8Array(ownedColdPng));
                    },
                  }),
              }
            : {},
        ),
      };
    },
  };
  return { storage, config, invocations: () => invocations, fetches: () => fetches };
}

test('actual Admin continuation runs the existing signed worker for a cold stored PNG and binds its real ready receipt', async (t) => {
  const h = await workspace(t);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  assert.equal(status.approval.references.prepared, false);
  assert.equal(media.invocations(), 1);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogPreparationJobs.length, 1);
  assert.equal(final.catalogPreparationJobs[0].state, 'completed');
  assert.ok(
    final.catalogImageObservations.some(
      (row: { kind: string }) => row.kind === 'catalog-protected-image-health-v1',
    ),
  );
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
  const object = await media.storage.getObjectAsBase64(final.images[0].storageFileId);
  assert.equal(Buffer.from(object.body, 'base64').readUInt32BE(16), 24);
});

test('unbound supplier photos prepare before seed and the next actual request rebuilds fresh source bindings', async (t) => {
  const h = await workspace(t, 1);
  const media = await coldOwnedMedia(h, true);
  const scope = await h.start('publish', {});
  const before = JSON.parse(h.bytes());
  const first = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(first.ok, JSON.stringify(first));
  const pending = CatalogProductOperationStatusSchema.parse(first.data);
  assert.equal(pending.state, 'saved');
  assert.equal(pending.preparation?.nextAction, 'continue');
  assert.equal(media.fetches(), 1);
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  assert.equal(status.approval.configurations.completed, 1);
  assert.equal(media.invocations(), 1);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals.length, 1);
  assert.equal(final.catalogPreparationJobs.length, 1);
  assert.deepEqual(
    final.catalogSourceObservations[0].observation,
    before.catalogSourceObservations[0].observation,
  );
  assert.equal(final.products[0].published, false);
  assert.equal(final.products[0].productFamily, before.products[0].productFamily);
  assert.deepEqual(final.products[0].category, before.products[0].category);
  assert.ok(
    final.images.every((image: { publishedRefCount: number }) => image.publishedRefCount === 0),
  );
  assert.ok(final.catalogDetailVariants[0].catalogDetailApproved.images.length > 0);
});

for (const extra of [
  { preparation: {} },
  { authority: {} },
  { invoke: 'client-function' },
  { budgetMs: 999999 },
])
  test(`browser continuation cannot inject preparation runtime ${JSON.stringify(extra)}`, async (t) => {
    const h = await workspace(t);
    const scope = await h.start();
    const before = h.bytes();
    const response = await h.invoke({ ...scope, action: 'product-operation-continue', ...extra });
    assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR', JSON.stringify(response));
    assert.equal(h.bytes(), before);
  });

test('forged ready worker output cannot complete an original operation or create media authority', async (t) => {
  const h = await workspace(t);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    {
      ...media.config,
      preparationInvoke: async (call) => ({
        result: {
          ok: true,
          kind: 'catalog-preparation-step',
          jobId: Reflect.get(call, 'jobId'),
          productId: h.productId,
          outcome: 'ready',
          media: { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 },
          attestation: { total: 1, checked: 1 },
          issues: [],
        },
      }),
    },
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, false);
  assert.equal(status.preparation?.nextAction, 'wait');
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogPreparationJobs[0].state, 'queued');
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
});

test('a lost signed worker answer is confirmed through real job state before original media binding', async (t) => {
  const h = await workspace(t);
  const media = await coldOwnedMedia(h);
  const execute = media.config.preparationInvoke;
  assert.ok(execute);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    {
      ...media.config,
      preparationInvoke: async (call) => {
        await execute(call);
        throw Object.assign(Error('worker committed, answer lost'), { code: 'ETIMEDOUT' });
      },
    },
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  assert.equal(media.invocations(), 1);
  const before = h.bytes();
  assert.deepEqual(
    await h.invokeWithConfig({ ...scope, action: 'product-operation-continue' }, media.config),
    response,
  );
  assert.equal(h.bytes(), before);
});

for (const imageCount of [5, 105])
  test(`${imageCount} cold real images resume the same root and job after an adapter restart with bounded progress`, async (t) => {
    const h = await workspace(t, imageCount === 105 ? 105 : undefined);
    const media = await coldOwnedMedia(h);
    const rows = JSON.parse(h.bytes());
    rows.catalogSourceLinks ??= [];
    for (let index = 1; index < imageCount; index++) {
      const id = `cold-${index}`;
      const object = await media.storage.putObject({
        namespace: 'catalog',
        logicalId: id,
        fileName: 'sample.png',
        mimeType: 'image/png',
        content: ownedColdPng,
      });
      rows.images.push({ ...rows.images[0], ...object, _id: id });
      if (imageCount === 105) {
        const sourceUrl = `https://sc04.alicdn.com/cold-${index}.png`;
        rows.catalogSourceObservations[0].observation.variants[index - 1].media = [
          { sourceUrl, position: 0, role: 'variant' },
        ];
        rows.catalogSourceLinks.push({
          _id: sourceMediaLinkId('alibaba', sourceUrl),
          provider: 'alibaba',
          sourceUrl,
          imageId: id,
        });
      } else rows.products[0].imageIds.push(id);
    }
    writeFileSync(h.file, JSON.stringify(rows));
    const scope = await h.start('publish', {});
    let response = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.ok(response.ok, JSON.stringify(response));
    let status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.ok(status.state === 'staging');
    assert.equal(status.approval.mediaReady, false);
    assert.equal(status.preparation?.nextAction, 'continue');
    assert.deepEqual(status.preparation.progress, { checked: 4, total: imageCount });
    const rootId = JSON.parse(h.bytes()).catalogDetailApprovals[0]._id;
    const jobId = status.preparation.job?.id;
    assert.ok(jobId);
    setAdapter(new JsonFileAdapter(h.file));
    const authority = createCatalogPreparationAuthority({
      secret: 'owned-cold-media',
      environmentId: 'owned-cold-media',
    });
    let calls = 0;
    for (
      let attempt = 0;
      attempt < Math.ceil(imageCount / 4) * 2 + 2 && !status.approval.mediaReady;
      attempt++
    ) {
      response = await h.invokeWithConfig(
        { ...scope, action: 'product-operation-continue' },
        {
          preparationAuthority: authority,
          preparationInvoke: async (call) => {
            calls++;
            return { result: await runCatalogPreparationWorker(authority, call) };
          },
        },
      );
      assert.ok(response.ok, JSON.stringify(response));
      status = CatalogProductOperationStatusSchema.parse(response.data);
      assert.ok(status.state === 'staging');
      if (status.preparation) {
        assert.equal(status.preparation.job?.id, jobId);
        assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 4096);
        assert.ok(status.preparation.progress);
        assert.equal(status.preparation.progress.total, imageCount);
      }
    }
    assert.equal(status.approval.mediaReady, true);
    assert.ok(calls >= Math.ceil(imageCount / 4) - 1 && calls <= Math.ceil(imageCount / 4) * 2 + 2);
    const final = JSON.parse(h.bytes());
    assert.equal(final.catalogDetailApprovals.length, 1);
    assert.equal(final.catalogDetailApprovals[0]._id, rootId);
    assert.equal(final.catalogPreparationJobs.length, 1);
    assert.equal(final.catalogPreparationJobs[0]._id, jobId);
    assert.equal(final.products[0].published, false);
    assert.ok(
      final.images.every((image: { publishedRefCount: number }) => image.publishedRefCount === 0),
    );
  });

test('a completed old media seal with a newly adopted source image yields repair instead of an endless ready loop', async (t) => {
  const h = await workspace(t, 1);
  const url = 'https://sc04.alicdn.com/changed-owned-binding.png';
  const rows = JSON.parse(h.bytes());
  rows.catalogSourceObservations[0].observation.variants[0].media = [
    { sourceUrl: url, position: 0, role: 'variant' },
  ];
  rows.catalogSourceLinks = [
    {
      _id: sourceMediaLinkId('alibaba', url),
      provider: 'alibaba',
      sourceUrl: url,
      imageId: 'image',
    },
  ];
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await warmOwnedMedia(h, false);
  const changed = JSON.parse(h.bytes());
  changed.images.push({ ...changed.images[0], _id: 'replacement-image' });
  changed.catalogSourceLinks[0].imageId = 'replacement-image';
  writeFileSync(h.file, JSON.stringify(changed));
  let invocations = 0;
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-media-metadata-fixture',
    environmentId: 'owned-media-metadata-fixture',
  });
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    {
      preparationAuthority: authority,
      preparationInvoke: async () => {
        invocations++;
        throw Error('completed job cannot be invoked');
      },
    },
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, false);
  assert.equal(status.preparation?.nextAction, 'repair');
  assert.equal(invocations, 0);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogPreparationJobs.length, 1);
  assert.equal(final.products[0].published, false);
  assert.ok(
    final.images.every((image: { publishedRefCount: number }) => image.publishedRefCount === 0),
  );
});

test('two actual cold-media continuations converge without duplicate approval or preparation jobs', async (t) => {
  const h = await workspace(t);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const results = await Promise.allSettled([
    h.invokeWithConfig({ ...scope, action: 'product-operation-continue' }, media.config),
    h.invokeWithConfig({ ...scope, action: 'product-operation-continue' }, media.config),
  ]);
  for (const result of results) {
    assert.ok(result.status === 'fulfilled');
    assert.ok(result.value.ok, JSON.stringify(result.value));
    CatalogProductOperationStatusSchema.parse(result.value.data);
  }
  const queried = await h.invoke({
    action: 'product-operation-get',
    productId: h.productId,
    operationId,
  });
  assert.ok(queried.ok);
  const status = CatalogProductOperationStatusSchema.parse(queried.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, true);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals.length, 1);
  assert.equal(final.catalogPreparationJobs.length, 1);
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
});

test('a transient source photo failure waits and resumes through the same original operation after the network recovers', async (t) => {
  const h = await workspace(t, 1);
  const media = await coldOwnedMedia(h, true);
  const authority = media.config.preparationAuthority;
  assert.ok(authority);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    {
      ...media.config,
      preparationInvoke: async (call) => ({
        result: await runCatalogPreparationWorker(authority, call, {
          importSourceImage: (url, persistImport) =>
            importCandidateImage(url, {
              persistImport,
              resolveDns: async () => ['104.16.1.1'],
              fetchImpl: async () => new Response('', { status: 503 }),
            }),
        }),
      }),
    },
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.equal(status.state, 'saved');
  assert.equal(status.preparation?.nextAction, 'wait');
  assert.ok(status.preparation.job);
  const queued = JSON.parse(h.bytes());
  assert.equal(queued.catalogPreparationJobs[0].state, 'queued');
  assert.equal(queued.catalogPreparationJobs[0].media, null);
  assert.equal(queued.catalogDetailApprovals[0].state, 'saved');
  assert.equal(queued.products[0].published, false);
  assert.equal(queued.images[0].publishedRefCount, 0);
  const recovered = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(recovered.ok, JSON.stringify(recovered));
  const imported = CatalogProductOperationStatusSchema.parse(recovered.data);
  assert.equal(imported.state, 'saved');
  assert.equal(imported.preparation?.nextAction, 'continue');
  assert.equal(imported.preparation?.job?.id, status.preparation.job.id);
  const resumed = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(resumed.ok, JSON.stringify(resumed));
  const ready = CatalogProductOperationStatusSchema.parse(resumed.data);
  assert.ok(ready.state === 'staging');
  assert.equal(ready.approval.mediaReady, true);
  assert.equal(ready.operationId, scope.operationId);
  assert.equal(media.fetches(), 1);
  const final = JSON.parse(h.bytes());
  assert.equal(final.catalogDetailApprovals[0].state, 'staging');
  assert.equal(final.catalogPreparationJobs.length, 1);
  assert.equal(final.products[0].published, false);
  assert.equal(final.images[0].publishedRefCount, 0);
});

test('an unreadable real image yields edit guidance and cannot authorize media readiness', async (t) => {
  const h = await workspace(t);
  const media = await coldOwnedMedia(h);
  const invalid = Buffer.from('not a PNG image');
  const object = await media.storage.putObject({
    namespace: 'catalog',
    logicalId: 'invalid',
    fileName: 'broken.png',
    mimeType: 'image/png',
    content: invalid,
  });
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.images[0], object, {
    byteSize: invalid.length,
    checksumSha256: createHash('sha256').update(invalid).digest('hex'),
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'staging');
  assert.equal(status.approval.mediaReady, false);
  assert.equal(status.preparation?.nextAction, 'edit');
  assert.equal(JSON.parse(h.bytes()).products[0].published, false);
  assert.equal(JSON.parse(h.bytes()).images[0].publishedRefCount, 0);
});
