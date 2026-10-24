import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { type CatalogProductSaveInput, persistCatalogDetailApproval } from '@vibelingan-channel/db';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { coldOwnedMedia, ownedColdPng, workspace } from './testing/catalog-operation-workspace.ts';

async function fixture(t: TestContext, count = 1) {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const id = `new-photo-${n}`;
    const stored = await media.storage.putObject({
      namespace: 'catalog',
      logicalId: id,
      fileName: 'draft.png',
      mimeType: 'image/png',
      content: ownedColdPng,
    });
    await h.adapter.create('images', {
      _id: id,
      ...stored,
      uploadedByUserId: 'admin',
      status: 'active',
      mimeType: 'image/png',
      byteSize: ownedColdPng.length,
      checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
      publishedRefCount: 0,
    });
    ids.push(id);
  }
  const before = await h.adapter.get('products', h.productId);
  assert.ok(before);
  const begin = async (values: Record<string, unknown>) => {
    const scope = await h.start('save-draft', values);
    return { action: 'product-operation-save', ...scope };
  };
  return { ...h, ...media, ids, before, begin };
}

for (const mode of ['gallery', 'description', 'configuration', 'all-27'] as const)
  test(`actual Admin saves prepared draft photos under existing image mutexes: ${mode}`, async (t) => {
    const h = await fixture(t, mode === 'all-27' ? 27 : 1);
    const first = h.ids[0];
    assert.ok(first);
    const values =
      mode === 'description'
        ? { descriptionImageIds: [first] }
        : mode === 'all-27'
          ? {
              imageIds: h.ids.slice(0, 9),
              descriptionImageIds: h.ids.slice(9),
              configurationPhotos: Object.fromEntries(
                Array.from({ length: 500 }, (_, n) => [`variant-${n}`, h.ids.slice(0, 9)]),
              ),
            }
          : {
              imageIds: ['image', first],
              ...(mode === 'configuration' ? { configurationPhotos: { variant: [first] } } : {}),
            };
    const persist = t.mock.method(
      h.adapter,
      'persistCatalogDetailApproval',
      h.adapter.persistCatalogDetailApproval.bind(h.adapter),
    );
    const command = await h.begin(values);
    const response = await h.invoke(command);
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.equal(status.state, 'saved');
    const product = await h.adapter.get('products', h.productId);
    assert.ok(product);
    assert.equal(product.published, false);
    assert.equal(product.productFamily, h.before.productFamily);
    assert.deepEqual(product.manualCatalogPricing, h.before.manualCatalogPricing);
    for (const [key, value] of Object.entries(values)) assert.deepEqual(product[key], value);
    assert.equal(
      persist.mock.calls.filter((call) => call.arguments[1].action === 'operation-photo-claim')
        .length,
      1,
    );
    assert.equal(
      persist.mock.calls.filter((call) => call.arguments[1].action === 'operation-photo-release')
        .length,
      1,
    );
    for (const id of h.ids) {
      const image = await h.adapter.get('images', id);
      assert.equal(image?.imageMutationOwner, '');
      assert.equal(image?.publishedRefCount, 0);
      assert.equal(image?.status, 'active');
    }
    const before = h.bytes();
    assert.deepEqual(await h.invoke(command), response);
    assert.equal(h.bytes(), before);
    assert.equal(
      persist.mock.calls.filter((call) => call.arguments[1].action === 'operation-photo-claim')
        .length,
      1,
    );
  });

test('a configuration cannot introduce a new image outside the actual gallery', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ configurationPhotos: { variant: h.ids } });
  const response = await h.invoke(command);
  assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR');
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  const image = await h.adapter.get('images', h.ids[0] ?? '');
  assert.equal(image?.imageMutationOwner, undefined);
});

test('moving a stale configuration-only photo back into the gallery requires the deletion mutex', async (t) => {
  const h = await fixture(t);
  const id = h.ids[0];
  assert.ok(id);
  await h.adapter.update('products', h.productId, { configurationPhotos: { oldVariant: [id] } });
  const product = await h.adapter.get('products', h.productId);
  assert.ok(product);
  const opened = await h.invoke({
    action: 'product-operation-start',
    intent: 'save-draft',
    productId: h.productId,
    operationId: crypto.randomUUID(),
    expectedUpdatedAt: product.updatedAt,
    values: { imageIds: [id] },
  });
  assert.ok(opened.ok, JSON.stringify(opened));
  const status = CatalogProductOperationStatusSchema.parse(opened.data);
  const command = {
    action: 'product-operation-save',
    productId: h.productId,
    operationId: status.operationId,
    inputDigest: status.inputDigest,
  };
  assert.equal(
    await h.adapter.acquireImageMutation(id, 'deletion-owner', new Date().toISOString()),
    'acquired',
  );
  const busy = await h.invoke(command);
  assert.ok(!busy.ok && busy.error.code === 'BUSY', JSON.stringify(busy));
  assert.deepEqual(await h.adapter.get('products', h.productId), product);
  await h.adapter.releaseImageMutation(id, 'deletion-owner');
  const saved = await h.invoke(command);
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.deepEqual((await h.adapter.get('products', h.productId))?.imageIds, [id]);
  assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, '');
});

test('a held image refuses save without a product write; the same original save works after release', async (t) => {
  const h = await fixture(t);
  const id = h.ids[0];
  assert.ok(id);
  const command = await h.begin({ imageIds: [id] });
  assert.equal(
    await h.adapter.acquireImageMutation(id, 'other-owner', new Date().toISOString()),
    'acquired',
  );
  const rejected = await h.invoke(command);
  assert.ok(!rejected.ok && rejected.error.code === 'BUSY', JSON.stringify(rejected));
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, 'other-owner');
  await h.adapter.releaseImageMutation(id, 'other-owner');
  const saved = await h.invoke(command);
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(CatalogProductOperationStatusSchema.parse(saved.data).state, 'saved');
});

test('native photo save can take over an expired legacy mutex without clearing another current owner', async (t) => {
  const h = await fixture(t);
  const id = h.ids[0];
  assert.ok(id);
  const command = await h.begin({ imageIds: [id] });
  await h.adapter.acquireImageMutation(
    id,
    'legacy-crashed-owner',
    new Date(Date.now() - 16 * 60 * 1000).toISOString(),
  );
  const saved = await h.invoke(command);
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(CatalogProductOperationStatusSchema.parse(saved.data).photosPending, undefined);
  assert.deepEqual((await h.adapter.get('products', h.productId))?.imageIds, [id]);
  assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, '');
});

test('image deletion cannot claim the existing mutex while the owned save is in flight', async (t) => {
  const h = await fixture(t);
  const id = h.ids[0];
  assert.ok(id);
  const command = await h.begin({ imageIds: [id] });
  const save = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
  let entered = () => {};
  let release = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    h.adapter,
    'saveCatalogProductWithIdentities',
    async (input: CatalogProductSaveInput) => {
      entered();
      assert.equal(typeof input.expectedImageMutationOwner, 'string');
      await held;
      return save(input);
    },
  );
  const pending = h.invoke(command);
  try {
    await inside;
    assert.equal(
      await h.adapter.acquireImageMutation(id, 'deletion-owner', new Date().toISOString()),
      'busy',
    );
    assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  } finally {
    release();
  }
  const response = await pending;
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, '');
});

test('a committed save with a lost reply keeps photo recovery until the same receipt is settled', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ imageIds: h.ids });
  const save = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
  const mocked = t.mock.method(
    h.adapter,
    'saveCatalogProductWithIdentities',
    async (input: CatalogProductSaveInput) => {
      await save(input);
      throw Error('commit succeeded but response was lost');
    },
  );
  t.mock.method(console, 'error', () => {});
  assert.equal((await h.invoke(command)).ok, false);
  const savedProduct = await h.adapter.get('products', h.productId);
  const recovered = await h.invoke({
    action: 'product-operation-get',
    productId: command.productId,
    operationId: command.operationId,
  });
  assert.ok(recovered.ok);
  const status = CatalogProductOperationStatusSchema.parse(recovered.data);
  assert.equal(status.state, 'saved');
  assert.equal(status.photosPending, true);
  assert.notEqual((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
  const settled = await h.invoke(command);
  assert.ok(settled.ok, JSON.stringify(settled));
  assert.equal(CatalogProductOperationStatusSchema.parse(settled.data).photosPending, undefined);
  assert.equal((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
  assert.deepEqual(await h.adapter.get('products', h.productId), savedProduct);
  const before = h.bytes();
  assert.deepEqual(await h.invoke(command), settled);
  assert.equal(h.bytes(), before);
  assert.equal(mocked.mock.callCount(), 1);
});

test('an unarrived photo claim leaves no partial image mutations and the original task can retry', async (t) => {
  const h = await fixture(t, 2);
  const command = await h.begin({ imageIds: h.ids });
  const persist = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const mocked = t.mock.method(
    h.adapter,
    'persistCatalogDetailApproval',
    async (...args: Parameters<typeof persist>) => {
      if (args[1].action === 'operation-photo-claim') throw Error('claim never reached storage');
      return persist(...args);
    },
  );
  t.mock.method(console, 'error', () => {});
  assert.equal((await h.invoke(command)).ok, false);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  for (const id of h.ids)
    assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, undefined);
  mocked.mock.restore();
  assert.equal((await h.invoke(command)).ok, true);
  for (const id of h.ids) assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, '');
});

test('a committed photo claim with a lost reply stays bound to its Root and resumes without another product write', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ imageIds: h.ids });
  const persist = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const mocked = t.mock.method(
    h.adapter,
    'persistCatalogDetailApproval',
    async (...args: Parameters<typeof persist>) => {
      const result = await persist(...args);
      if (args[1].action === 'operation-photo-claim')
        throw Error('photo claim committed, reply lost');
      return result;
    },
  );
  t.mock.method(console, 'error', () => {});
  assert.equal((await h.invoke(command)).ok, false);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  const checked = await h.invoke({
    action: 'product-operation-get',
    productId: command.productId,
    operationId: command.operationId,
  });
  assert.ok(checked.ok);
  const status = CatalogProductOperationStatusSchema.parse(checked.data);
  assert.equal(status.state, 'reserved');
  assert.equal(status.photosPending, true);
  mocked.mock.restore();
  const saved = await h.invoke(command);
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(CatalogProductOperationStatusSchema.parse(saved.data).photosPending, undefined);
  assert.equal((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
});

test('persistent photo-release failure keeps an explicit recovery state and never repeats the product save', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ imageIds: h.ids });
  const persist = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  const mocked = t.mock.method(
    h.adapter,
    'persistCatalogDetailApproval',
    async (...args: Parameters<typeof persist>) => {
      if (args[1].action === 'operation-photo-release') throw Error('release storage unavailable');
      return persist(...args);
    },
  );
  t.mock.method(console, 'error', () => {});
  assert.equal((await h.invoke(command)).ok, false);
  const saved = await h.adapter.get('products', h.productId);
  assert.equal((await h.invoke(command)).ok, false);
  assert.deepEqual(await h.adapter.get('products', h.productId), saved);
  const readBefore = h.bytes();
  const checked = await h.invoke({
    action: 'product-operation-get',
    productId: command.productId,
    operationId: command.operationId,
  });
  assert.ok(checked.ok);
  assert.equal(CatalogProductOperationStatusSchema.parse(checked.data).photosPending, true);
  assert.equal(h.bytes(), readBefore);
  mocked.mock.restore();
  const settled = await h.invoke(command);
  assert.ok(settled.ok, JSON.stringify(settled));
  assert.equal(CatalogProductOperationStatusSchema.parse(settled.data).photosPending, undefined);
  assert.deepEqual(await h.adapter.get('products', h.productId), saved);
  assert.equal((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
});

test('legacy active images can be selected without a metadata backfill', async (t) => {
  const h = await fixture(t, 0);
  await h.adapter.create('images', {
    _id: 'legacy-photo',
    data: ownedColdPng.toString('base64'),
    mimeType: 'image/png',
  });
  const command = await h.begin({ imageIds: ['legacy-photo'] });
  const response = await h.invoke(command);
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  assert.equal((await h.adapter.get('images', 'legacy-photo'))?.imageMutationOwner, '');
});

test('text-only save does not acquire or release a photo mutex', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ description: 'Only text changes' });
  const get = t.mock.method(h.adapter, 'get', h.adapter.get.bind(h.adapter));
  const acquire = t.mock.method(
    h.adapter,
    'acquireImageMutation',
    h.adapter.acquireImageMutation.bind(h.adapter),
  );
  const release = t.mock.method(
    h.adapter,
    'releaseImageMutation',
    h.adapter.releaseImageMutation.bind(h.adapter),
  );
  const response = await h.invoke(command);
  assert.ok(response.ok, JSON.stringify(response));
  assert.equal(acquire.mock.callCount(), 0);
  assert.equal(release.mock.callCount(), 0);
  assert.equal(get.mock.calls.filter((call) => call.arguments[0] === 'products').length, 0);
});

test('the public save command rejects an injected internal image owner before changing anything', async (t) => {
  const h = await fixture(t);
  const command = await h.begin({ imageIds: h.ids });
  const before = h.bytes();
  const response = await h.invoke({ ...command, expectedImageMutationOwner: crypto.randomUUID() });
  assert.ok(!response.ok && response.error.code === 'VALIDATION_ERROR');
  assert.equal(h.bytes(), before);
});

test('actual publication continuation saves its new gallery under the same mutex and withdraws its own public version', async (t) => {
  const h = await fixture(t);
  const scope = await h.start('publish', { imageIds: h.ids, description: 'Reviewed new gallery' });
  const publicRead = () =>
    handlePublicApiEvent(
      { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
      { enableCatalogDetail: true },
    );
  const token = await signSession('owned-continue-test-only', {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  try {
    let complete = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await h.invokeWithConfig(
        { action: 'product-operation-continue', ...scope },
        h.config,
      );
      assert.ok(response.ok, JSON.stringify(response));
      if (CatalogProductOperationStatusSchema.parse(response.data).state === 'complete') {
        complete = true;
        break;
      }
    }
    assert.equal(complete, true);
    assert.equal((await publicRead()).statusCode, 200);
    const product = await h.adapter.get('products', h.productId);
    assert.equal(product?.productFamily, h.before.productFamily);
    assert.deepEqual(product?.manualCatalogPricing, h.before.manualCatalogPricing);
    assert.equal((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
  } finally {
    const current = await h.adapter.get('products', h.productId);
    if (current?.published === true) {
      const restored = await handleAdminRequest(
        {
          action: 'update',
          token,
          data: {
            collection: 'products',
            id: h.productId,
            expectedUpdatedAt: current.updatedAt,
            values: { published: false },
          },
        },
        { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true },
      );
      assert.ok(restored.ok, JSON.stringify(restored));
    }
    assert.equal((await publicRead()).statusCode, 404);
  }
});

test('photo claims share the original Root transaction, and stopping atomically removes them before a late claim', async (t) => {
  const h = await fixture(t, 2);
  const { action: _action, ...scope } = await h.begin({ imageIds: h.ids });
  const claim = await persistCatalogDetailApproval('admin', {
    action: 'operation-photo-claim',
    ...scope,
  });
  assert.ok(claim.ok && 'record' in claim, JSON.stringify(claim));
  assert.equal(claim.record.operation.photoClaimVersion, 1);
  for (const id of h.ids)
    assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, claim.record._id);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  const beforeRead = h.bytes();
  const checked = await h.invoke({
    action: 'product-operation-get',
    productId: scope.productId,
    operationId: scope.operationId,
  });
  assert.ok(checked.ok);
  assert.equal(CatalogProductOperationStatusSchema.parse(checked.data).photosPending, true);
  assert.equal(h.bytes(), beforeRead);
  const refused = await persistCatalogDetailApproval('admin', {
    action: 'operation-photo-release',
    ...scope,
  });
  assert.ok(!refused.ok && refused.code === 'CONFLICT');
  assert.equal(h.bytes(), beforeRead);
  const stopped = await h.invoke({
    action: 'product-operation-stop',
    intent: 'save-draft',
    productId: scope.productId,
    operationId: scope.operationId,
  });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.equal(CatalogProductOperationStatusSchema.parse(stopped.data).photosPending, undefined);
  for (const id of h.ids) assert.equal((await h.adapter.get('images', id))?.imageMutationOwner, '');
  const afterStop = h.bytes();
  const late = await persistCatalogDetailApproval('admin', {
    action: 'operation-photo-claim',
    ...scope,
  });
  assert.ok(!late.ok && late.code === 'CONFLICT');
  assert.equal(h.bytes(), afterStop);
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
});

for (const order of ['claim-first', 'stop-first', 'race'] as const)
  test(`original photo claim versus Stop leaves no late lock: ${order}`, async (t) => {
    const h = await fixture(t, 2);
    const { action: _action, ...scope } = await h.begin({ imageIds: h.ids });
    const claim = () =>
      persistCatalogDetailApproval('admin', { action: 'operation-photo-claim', ...scope });
    const stop = () =>
      h.invoke({
        action: 'product-operation-stop',
        intent: 'save-draft',
        productId: scope.productId,
        operationId: scope.operationId,
      });
    if (order === 'claim-first') {
      assert.ok((await claim()).ok);
      assert.ok((await stop()).ok);
    } else if (order === 'stop-first') {
      assert.ok((await stop()).ok);
      assert.equal((await claim()).ok, false);
    } else {
      const results = await Promise.allSettled([claim(), stop()]);
      assert.ok(results.every((result) => result.status === 'fulfilled'));
    }
    const checked = await h.invoke({
      action: 'product-operation-get',
      productId: scope.productId,
      operationId: scope.operationId,
    });
    assert.ok(checked.ok);
    const status = CatalogProductOperationStatusSchema.parse(checked.data);
    assert.ok('cancelledAt' in status && status.cancelledAt);
    assert.equal(status.photosPending, undefined);
    for (const id of h.ids) assert.ok(!(await h.adapter.get('images', id))?.imageMutationOwner);
    assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
  });

test('existing owner-unavailable recovery also releases photo claims without changing the draft', async (t) => {
  const h = await fixture(t);
  const { action: _action, ...scope } = await h.begin({ imageIds: h.ids });
  const claimed = await persistCatalogDetailApproval('admin', {
    action: 'operation-photo-claim',
    ...scope,
  });
  assert.ok(claimed.ok && 'record' in claimed);
  await h.adapter.create('users', { _id: 'rescuer', role: 'admin', status: 'active' });
  await h.adapter.update('users', 'admin', { role: 'member' });
  const recovered = await persistCatalogDetailApproval('rescuer', {
    action: 'operation-recover',
    operationRootId: claimed.record._id,
    ...scope,
  });
  assert.ok(recovered.ok && 'record' in recovered, JSON.stringify(recovered));
  assert.ok(recovered.record.operation.cancelledAt);
  assert.equal(
    recovered.record.operation.photoReleaseVersion,
    recovered.record.operation.photoClaimVersion,
  );
  assert.equal((await h.adapter.get('images', h.ids[0] ?? ''))?.imageMutationOwner, '');
  assert.deepEqual(await h.adapter.get('products', h.productId), h.before);
});
