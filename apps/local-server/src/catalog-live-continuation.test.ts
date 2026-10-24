import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import {
  manageCatalogProductOperation,
  prepareCatalogProductOperationApproval,
} from '@vibelingan-channel/db';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import { continueAdminCatalogProductOperation } from '../../functions/admin/src/catalog-product-operation-continue.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { coldOwnedMedia, ownedColdPng, workspace } from './testing/catalog-operation-workspace.ts';

const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function publishedWorkspace(t: TestContext, count?: number) {
  const h = await workspace(t, count, true);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  let result = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  for (let i = 0; i < 8 && result.ok; i++) {
    if (CatalogProductOperationStatusSchema.parse(result.data).state === 'complete') break;
    result = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
  }
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(CatalogProductOperationStatusSchema.parse(result.data).state, 'complete');
  const before = await h.adapter.get('products', h.productId);
  assert.ok(before);
  const start = async (values: Record<string, unknown>) => {
    const response = await h.invoke({
      action: 'product-operation-start',
      productId: h.productId,
      operationId: liveId,
      intent: 'refresh-live',
      expectedUpdatedAt: before.updatedAt,
      values,
    });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    return { productId: h.productId, operationId: liveId, inputDigest: status.inputDigest };
  };
  return { h, media, before, start };
}

for (const count of [undefined, 105])
  test(`actual Admin live save/reapproval preserves the buyer version until final and publishes protected PNG (${count ?? 'manual'})`, async (t) => {
    const { h, media, before, start } = await publishedWorkspace(t, count);
    const object = await media.storage.putObject({
      namespace: 'catalog',
      logicalId: 'replacement',
      fileName: 'replacement.png',
      mimeType: 'image/png',
      content: ownedColdPng,
    });
    // Seed a stored upload record; the real worker must still verify and protect these PNG bytes.
    const rows = JSON.parse(h.bytes());
    rows.images.push({
      _id: 'replacement',
      ...object,
      status: 'active',
      mimeType: 'image/png',
      byteSize: ownedColdPng.length,
      checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
      publishedRefCount: 0,
    });
    writeFileSync(h.file, JSON.stringify(rows));
    const scope = await start({ description: 'Live reviewed edit', imageIds: ['replacement'] });
    const paused = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      {
        ...media.config,
        productOperationPublisher: (actor, binding) =>
          manageCatalogProductOperation(actor, {
            action: 'product-operation-get',
            productId: binding.productId,
            operationId: binding.operationId,
          }),
      },
    );
    assert.ok(paused.ok, JSON.stringify(paused));
    const staging = CatalogProductOperationStatusSchema.parse(paused.data);
    assert.equal(staging.state, 'staging');
    const saved = await h.adapter.get('products', h.productId);
    assert.ok(saved);
    assert.equal(saved.published, true);
    assert.equal(saved.description, 'Live reviewed edit');
    assert.deepEqual(saved.catalogDetailPublication, before.catalogDetailPublication);
    for (const key of ['productFamily', 'category', 'subcategoryIds'])
      assert.deepEqual(saved[key], before[key]);
    const visibleBefore = resolvePublicVersion(saved, { detailEnabled: true });
    assert.equal(visibleBefore.kind, 'approved');
    if (visibleBefore.kind === 'approved')
      assert.notEqual(visibleBefore.publication.header.descriptionText, 'Live reviewed edit');
    const response = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.ok(response.ok, JSON.stringify(response));
    const complete = CatalogProductOperationStatusSchema.parse(response.data);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.operationId, liveId);
    const current = await h.adapter.get('products', h.productId);
    const visible = resolvePublicVersion(current, { detailEnabled: true });
    assert.equal(visible.kind, 'approved');
    if (visible.kind === 'approved') {
      assert.equal(visible.publication.header.descriptionText, 'Live reviewed edit');
      assert.deepEqual(visible.publication.header.images, ['/api/images/replacement']);
      assert.equal(visible.publication.variantCount, count ?? 0);
    }
    assert.equal(
      (
        await handlePublicApiEvent(
          { httpMethod: 'GET', path: `/api/products/${h.productId}` },
          {
            enableCatalogDetail: true,
          },
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/replacement' }, {}))
        .statusCode,
      200,
    );
    assert.equal(
      (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {})).statusCode,
      404,
    );
    const after = h.bytes();
    const replay = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.deepEqual(replay, response);
    assert.equal(h.bytes(), after);
    assert.equal(
      JSON.parse(after).catalogDetailApprovals.filter(
        (row: { operationId?: string }) => row.operationId === liveId,
      ).length,
      1,
    );
  });

for (const phase of ['save', 'final'])
  test(`actual Admin live continuation recovers a committed ${phase} with a lost answer without repeating it`, async (t) => {
    const { h, media, start } = await publishedWorkspace(t);
    const scope = await start({ description: `Recovered ${phase}` });
    const save = h.adapter.saveCatalogProductWithIdentities.bind(h.adapter);
    const persist = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
    let writes = 0;
    if (phase === 'save')
      h.adapter.saveCatalogProductWithIdentities = async (input) => {
        const result = await save(input);
        if (result.result === 'saved') {
          writes++;
          throw Error('live row committed, answer lost');
        }
        return result;
      };
    else
      h.adapter.persistCatalogDetailApproval = async (actor, command) => {
        const result = await persist(actor, command);
        if (command.action === 'operation-publish' && result.ok) {
          writes++;
          throw Error('live approval committed, answer lost');
        }
        return result;
      };
    const first = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    if (phase === 'save') {
      assert.equal(first.ok, false, 'an uncertain row-save response is not fabricated as success');
      const status = await manageCatalogProductOperation('admin', {
        action: 'product-operation-get',
        productId: scope.productId,
        operationId: liveId,
      });
      assert.ok(status.ok && status.state === 'saved', JSON.stringify(status));
    } else {
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal(CatalogProductOperationStatusSchema.parse(first.data).state, 'complete');
    }
    const retry = await h.invokeWithConfig(
      { ...scope, action: 'product-operation-continue' },
      media.config,
    );
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal(CatalogProductOperationStatusSchema.parse(retry.data).state, 'complete');
    assert.equal(writes, 1);
  });

test('the actual Admin parent budget stops live save after photo claim and can resume later', async (t) => {
  const { h, media, start } = await publishedWorkspace(t);
  const object = await media.storage.putObject({
    namespace: 'catalog',
    logicalId: 'budget-image',
    fileName: 'budget.png',
    mimeType: 'image/png',
    content: ownedColdPng,
  });
  const rows = JSON.parse(h.bytes());
  rows.images.push({
    _id: 'budget-image',
    ...object,
    status: 'active',
    mimeType: 'image/png',
    byteSize: ownedColdPng.length,
    checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
    publishedRefCount: 0,
  });
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await start({
    description: 'Saved after the budget resumes',
    imageIds: ['budget-image'],
  });
  const persist = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  let now = 0;
  h.adapter.persistCatalogDetailApproval = async (actor, command) => {
    const result = await persist(actor, command);
    if (command.action === 'operation-photo-claim') now = 13000;
    return result;
  };
  const unexpected = async () => {
    throw Error('deadline must stop before approval');
  };
  const partial = await continueAdminCatalogProductOperation(
    'admin',
    {
      ...scope,
      action: 'product-operation-continue',
    },
    {
      operation: manageCatalogProductOperation,
      seed: prepareCatalogProductOperationApproval,
      prepare: unexpected,
      configuration: unexpected,
      media: unexpected,
      now: () => now,
    },
  );
  assert.ok(partial.ok && partial.state === 'reserved', JSON.stringify(partial));
  assert.equal(partial.photosPending, true);
  assert.equal((await h.adapter.get('products', h.productId))?.description, 'Original draft');
  const retry = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(CatalogProductOperationStatusSchema.parse(retry.data).state, 'complete');
});

test('a live edit saved before concurrent withdrawal remains saved and cannot republish the product', async (t) => {
  const { h, media, start } = await publishedWorkspace(t);
  const scope = await start({ description: 'Kept live edit' });
  const staged = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    {
      ...media.config,
      productOperationPublisher: (actor, binding) =>
        manageCatalogProductOperation(actor, {
          action: 'product-operation-get',
          productId: binding.productId,
          operationId: binding.operationId,
        }),
    },
  );
  assert.ok(staged.ok, JSON.stringify(staged));
  assert.equal(CatalogProductOperationStatusSchema.parse(staged.data).state, 'staging');
  const current = await h.adapter.get('products', h.productId);
  assert.ok(current);
  assert.equal(
    (
      await h.adapter.saveCatalogProductWithIdentities({
        mode: 'update',
        productId: h.productId,
        data: { published: false },
        expectedUpdatedAt: typeof current.updatedAt === 'string' ? current.updatedAt : null,
      })
    ).result,
    'saved',
  );
  const before = h.bytes();
  const resumed = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(!resumed.ok && resumed.error.code === 'CONFLICT', JSON.stringify(resumed));
  assert.equal(h.bytes(), before);
  const stopped = await h.invoke({ ...scope, action: 'product-operation-cancel' });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  const after = await h.adapter.get('products', h.productId);
  assert.equal(after?.published, false);
  assert.equal(after?.description, 'Kept live edit');
  assert.equal(
    (
      await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${h.productId}` },
        {
          enableCatalogDetail: true,
        },
      )
    ).statusCode,
    404,
  );
});
