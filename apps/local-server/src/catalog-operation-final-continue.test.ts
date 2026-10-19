import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import {
  manageCatalogProductOperation,
  persistCatalogDetailApproval,
  prepareCatalogProductOperationApproval,
} from '@vibelingan-channel/db';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { continueOwnedCatalogPublication } from '../../functions/admin/src/catalog-operation-final-continue.ts';
import { continueAdminCatalogProductOperation } from '../../functions/admin/src/catalog-product-operation-continue.ts';
import { type AdminConfig, handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { coldOwnedMedia, workspace } from './testing/catalog-operation-workspace.ts';

test('the default actual Admin workflow publishes its original operation and delivers the real protected PNG', async (t) => {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'complete', JSON.stringify(status));
  assert.equal(status.operationId, scope.operationId);
  assert.equal(status.inputDigest, scope.inputDigest);
  assert.equal(status.current, true);
  assert.equal(status.completion.revision, status.approval.revision);
  assert.equal(JSON.parse(h.bytes()).products[0].published, true);
  assert.equal(
    (
      await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${h.productId}` },
        { enableCatalogDetail: true },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {})).statusCode,
    200,
  );
});

test('the default actual Admin workflow confirms a committed final transaction after its answer is lost', async (t) => {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const original = h.adapter.persistCatalogDetailApproval.bind(h.adapter);
  let commits = 0;
  h.adapter.persistCatalogDetailApproval = async (...args) => {
    const result = await original(...args);
    if (args[1].action === 'operation-publish') {
      commits++;
      throw Error('final committed, answer lost');
    }
    return result;
  };
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(response.ok, JSON.stringify(response));
  const status = CatalogProductOperationStatusSchema.parse(response.data);
  assert.ok(status.state === 'complete', JSON.stringify(status));
  assert.equal(commits, 1);
  const before = h.bytes();
  assert.deepEqual(
    await h.invokeWithConfig({ ...scope, action: 'product-operation-continue' }, media.config),
    response,
  );
  assert.equal(h.bytes(), before);
  assert.equal(commits, 1);
});

async function readyFinal(t: TestContext) {
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
  assert.deepEqual(status.approval.references, { prepared: true, staged: 1, total: 1 });
  return { h, media, scope };
}
for (const budget of [0, 1999])
  test(`a final call with ${budget}ms remaining keeps the original private operation`, async (t) => {
    const { h, scope } = await readyFinal(t);
    const before = h.bytes();
    let writes = 0;
    const result = await continueOwnedCatalogPublication('admin', scope, budget, {
      operation: manageCatalogProductOperation,
      persist: async (...args) => {
        writes++;
        return persistCatalogDetailApproval(...args);
      },
      now: () => 0,
    });
    assert.ok(result.ok && result.state === 'staging');
    assert.equal(writes, 0);
    assert.equal(h.bytes(), before);
  });

test('time consumed by the final root lookup is deducted before publication admission', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = h.bytes();
  let now = 0;
  let writes = 0;
  const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
    operation: async (...args) => {
      const result = await manageCatalogProductOperation(...args);
      now = 10001;
      return result;
    },
    persist: async (...args) => {
      writes++;
      return persistCatalogDetailApproval(...args);
    },
    now: () => now,
  });
  assert.ok(result.ok && result.state === 'staging');
  assert.equal(writes, 0);
  assert.equal(h.bytes(), before);
});

test('an OK final answer without a durable completion cannot report publication success', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = h.bytes();
  const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
    operation: manageCatalogProductOperation,
    persist: () =>
      persistCatalogDetailApproval('admin', {
        action: 'operation-get',
        productId: scope.productId,
        operationId: scope.operationId,
      }),
    now: () => 0,
  });
  assert.ok(!result.ok && result.code === 'CONFLICT');
  assert.equal(h.bytes(), before);
});

test('an unknown final persistence error cannot be guessed successful while the root is still private', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = h.bytes();
  await assert.rejects(
    continueOwnedCatalogPublication('admin', scope, 12000, {
      operation: manageCatalogProductOperation,
      persist: async () => {
        throw Error('final unavailable');
      },
      now: () => 0,
    }),
    /final unavailable/,
  );
  assert.equal(h.bytes(), before);
});

test('a lost final answer and failed confirmation retain both unknown errors', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = h.bytes();
  let reads = 0;
  await assert.rejects(
    continueOwnedCatalogPublication('admin', scope, 12000, {
      operation: async (...args) => {
        if (++reads > 1) throw Error('confirmation unavailable');
        return manageCatalogProductOperation(...args);
      },
      persist: async () => {
        throw Error('final unavailable');
      },
      now: () => 0,
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(h.bytes(), before);
});

for (const fault of ['actor', 'product', 'operation', 'digest', 'extra'])
  test(`a final ${fault} scope mismatch cannot dispatch publication`, async (t) => {
    const { h, scope } = await readyFinal(t);
    const before = h.bytes();
    let writes = 0;
    const input = {
      ...scope,
      ...(fault === 'product' ? { productId: 'other' } : {}),
      ...(fault === 'operation' ? { operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : {}),
      ...(fault === 'digest' ? { inputDigest: 'f'.repeat(64) } : {}),
      ...(fault === 'extra' ? { published: true } : {}),
    };
    const result = await continueOwnedCatalogPublication(
      fault === 'actor' ? 'other' : 'admin',
      input,
      12000,
      {
        operation: manageCatalogProductOperation,
        persist: async (...args) => {
          writes++;
          return persistCatalogDetailApproval(...args);
        },
        now: () => 0,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    assert.equal(h.bytes(), before);
  });

for (const change of ['cancel', 'edit', 'revoke'])
  test(`a final lookup followed by ${change} is still rejected by the native write transaction`, async (t) => {
    const { h, scope } = await readyFinal(t);
    let changed = false;
    const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
      operation: async (...args) => {
        const result = await manageCatalogProductOperation(...args);
        if (!changed) {
          changed = true;
          if (change === 'cancel')
            assert.ok(
              (
                await manageCatalogProductOperation('admin', {
                  ...scope,
                  action: 'product-operation-cancel',
                })
              ).ok,
            );
          else if (change === 'edit') {
            const row = await h.adapter.get('products', h.productId);
            assert.ok(row);
            assert.equal(
              (
                await h.adapter.saveCatalogProductWithIdentities({
                  mode: 'update',
                  productId: h.productId,
                  expectedUpdatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
                  data: { description: 'A later saved edit' },
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
      },
      persist: persistCatalogDetailApproval,
      now: () => 0,
    });
    assert.ok(
      !result.ok && result.code === (change === 'revoke' ? 'FORBIDDEN' : 'CONFLICT'),
      JSON.stringify(result),
    );
    assert.equal(JSON.parse(h.bytes()).products[0].published, false);
  });

test('the final scope is captured before the first status lookup yields', async (t) => {
  const { h, scope } = await readyFinal(t);
  const input = { ...scope };
  let mutated = false;
  const result = await continueOwnedCatalogPublication('admin', input, 12000, {
    operation: async (...args) => {
      const result = await manageCatalogProductOperation(...args);
      if (!mutated) {
        mutated = true;
        input.productId = 'other';
        input.operationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        input.inputDigest = 'f'.repeat(64);
      }
      return result;
    },
    persist: persistCatalogDetailApproval,
    now: () => 0,
  });
  assert.ok(result.ok && result.state === 'complete', JSON.stringify(result));
  assert.equal(result.productId, scope.productId);
  assert.equal(result.operationId, scope.operationId);
  assert.equal(result.inputDigest, scope.inputDigest);
});

for (const fault of [
  'cancelled',
  'expired',
  'revoked',
  'corrupt-config-cursor',
  'corrupt-media-binding',
  'unfinished-references',
])
  test(`a final ${fault} operation cannot grant publication rights`, async (t) => {
    const { h, scope } = await readyFinal(t);
    const rows = JSON.parse(h.bytes());
    if (fault === 'revoked') rows.users[0].role = 'member';
    else if (fault === 'cancelled') {
      assert.ok(
        (
          await manageCatalogProductOperation('admin', {
            ...scope,
            action: 'product-operation-cancel',
          })
        ).ok,
      );
    } else {
      const root = rows.catalogDetailApprovals.find(
        (row: { operationId?: string }) => row.operationId === scope.operationId,
      );
      assert.ok(root);
      if (fault === 'expired') root.createdAt = new Date(Date.now() - 3600001).toISOString();
      if (fault === 'corrupt-config-cursor') root.nextPage = -1;
      if (fault === 'corrupt-media-binding') Reflect.deleteProperty(root, 'media');
      if (fault === 'unfinished-references') Reflect.deleteProperty(root, 'referenceStage');
    }
    if (fault !== 'cancelled') writeFileSync(h.file, JSON.stringify(rows));
    const before = h.bytes();
    let writes = 0;
    const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
      operation: manageCatalogProductOperation,
      persist: async (...args) => {
        writes++;
        return persistCatalogDetailApproval(...args);
      },
      now: () => 0,
    });
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    assert.equal(h.bytes(), before);
  });

test('default full publication preserves classification field reasons for invalid existing assignments', async (t) => {
  const h = await workspace(t, undefined, true);
  const rows = JSON.parse(h.bytes());
  rows.products[0].subcategoryIds = ['not-a-current-category'];
  writeFileSync(h.file, JSON.stringify(rows));
  const media = await coldOwnedMedia(h);
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(!response.ok, JSON.stringify(response));
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.ok(
    'issues' in response.error &&
      response.error.issues?.some(
        (issue) => issue.path === 'subcategoryIds' && issue.remedy === 'classify',
      ),
  );
  assert.equal(JSON.parse(h.bytes()).products[0].published, false);
});

test('twenty actual default API publications share real prepared pixels and restore only their owned products', async (t) => {
  const h = await workspace(t);
  const original = JSON.parse(h.bytes()).products[0];
  const media = await coldOwnedMedia(h);
  const warm = await h.start('publish', {});
  const warmed = await h.invokeWithConfig(
    { ...warm, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(warmed.ok, JSON.stringify(warmed));
  assert.ok((await h.invoke({ ...warm, action: 'product-operation-cancel' })).ok);
  const rows = JSON.parse(h.bytes());
  const manifest = Array.from({ length: 20 }, (_, index) => ({
    productId: `owned-batch-${index}`,
    operationId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    original: { ...original, _id: `owned-batch-${index}`, name: `Owned batch product ${index}` },
  }));
  rows.products.push(...manifest.map((item) => item.original));
  writeFileSync(h.file, JSON.stringify(rows));
  const config: AdminConfig = {
    jwtSecret: 'owned-continue-test-only',
    enableDetailApproval: true,
    ...media.config,
  };
  assert.equal(config.productOperationPublisher, undefined);
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const invoke = (data: unknown) =>
    handleAdminRequest({ action: 'catalogDetailApproval', token, data }, config);
  const completed = new Map<string, string>();
  let next = 0;
  try {
    const workers = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        while (next < manifest.length) {
          const item = manifest[next++];
          assert.ok(item);
          const started = await invoke({
            action: 'product-operation-start',
            productId: item.productId,
            operationId: item.operationId,
            intent: 'publish',
            expectedUpdatedAt: item.original.updatedAt,
            values: {},
          });
          assert.ok(started.ok, JSON.stringify(started));
          const opened = CatalogProductOperationStatusSchema.parse(started.data);
          const scope = {
            productId: item.productId,
            operationId: item.operationId,
            inputDigest: opened.inputDigest,
          };
          for (let attempt = 0; attempt < 40 && !completed.has(item.productId); attempt++) {
            const response = await invoke({ ...scope, action: 'product-operation-continue' });
            assert.ok(response.ok, JSON.stringify(response));
            const status = CatalogProductOperationStatusSchema.parse(response.data);
            assert.equal(status.productId, item.productId);
            assert.equal(status.operationId, item.operationId);
            if (status.state === 'complete') {
              assert.equal(status.current, true);
              assert.equal(status.completion.revision, status.approval.revision);
              completed.set(item.productId, status.approval.revision);
            }
          }
          assert.ok(completed.has(item.productId));
        }
      }),
    );
    const rejected = workers.filter((worker) => worker.status === 'rejected');
    assert.equal(rejected.length, 0, JSON.stringify(rejected));
    assert.equal(completed.size, 20);
    for (const item of manifest) {
      const response = await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${item.productId}/detail` },
        { enableCatalogDetail: true },
      );
      assert.equal(response.statusCode, 200, response.body);
      const body = JSON.parse(response.body);
      const detail = decodeCatalogDetailView(body.data);
      assert.ok(detail.ok, JSON.stringify(body));
      assert.equal(detail.value.revision, completed.get(item.productId));
      assert.equal(detail.value.name, item.original.name);
      assert.equal(detail.value.variants.total, 0);
    }
    const effective = await h.adapter.readCatalogImageReference({
      action: 'read',
      imageId: 'image',
    });
    assert.ok(effective.state === 'counted');
    assert.equal(effective.effectiveCount, 20);
    assert.equal(
      (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {})).statusCode,
      200,
    );
  } finally {
    for (const item of manifest) {
      const row = await h.adapter.get('products', item.productId);
      assert.ok(row);
      if (row.published === true) {
        assert.ok(
          row.catalogDetailApprovalReceipt && typeof row.catalogDetailApprovalReceipt === 'object',
        );
        assert.equal(
          Reflect.get(row.catalogDetailApprovalReceipt, 'operationId'),
          item.operationId,
        );
        const response = await handleAdminRequest(
          {
            action: 'update',
            token,
            data: {
              collection: 'products',
              id: item.productId,
              values: { published: false },
              expectedUpdatedAt: row.updatedAt,
            },
          },
          config,
        );
        assert.ok(response.ok, JSON.stringify(response));
      }
      const restored = await h.adapter.get('products', item.productId);
      assert.ok(restored);
      assert.equal(restored.published, false);
      for (const field of ['productFamily', 'category', 'subcategoryIds']) {
        assert.equal(Object.hasOwn(restored, field), Object.hasOwn(item.original, field));
        assert.deepEqual(restored[field], item.original[field]);
      }
      assert.equal(
        (
          await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${item.productId}/detail` },
            { enableCatalogDetail: true },
          )
        ).statusCode,
        404,
      );
    }
    for (const item of manifest) {
      const response = await invoke({
        action: 'product-operation-get',
        productId: item.productId,
        operationId: item.operationId,
      });
      assert.ok(response.ok, JSON.stringify(response));
      const status = CatalogProductOperationStatusSchema.parse(response.data);
      assert.ok(status.state === 'complete');
      assert.equal(status.current, false);
      const before = h.bytes();
      const replay = await invoke({
        action: 'product-operation-continue',
        productId: item.productId,
        operationId: item.operationId,
        inputDigest: status.inputDigest,
      });
      assert.ok(replay.ok, JSON.stringify(replay));
      const historical = CatalogProductOperationStatusSchema.parse(replay.data);
      assert.ok(historical.state === 'complete');
      assert.equal(historical.current, false);
      assert.equal(h.bytes(), before);
    }
    const image = await h.adapter.get('images', 'image');
    assert.ok(image && typeof image.storageFileId === 'string');
    const privateCopy = await media.storage.getObjectAsBase64(image.storageFileId);
    const bytes = Buffer.from(privateCopy.body, 'base64');
    assert.equal(bytes.readUInt32BE(16), 24);
    assert.equal(bytes.readUInt32BE(20), 16);
    const effective = await h.adapter.readCatalogImageReference({
      action: 'read',
      imageId: 'image',
    });
    assert.ok(effective.state === 'counted');
    assert.equal(effective.effectiveCount, 0);
    assert.equal(
      (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {})).statusCode,
      404,
    );
    assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  }
});

for (const phase of ['saved', 'unprepared-media'])
  test(`a genuine ${phase} operation cannot dispatch the final native transaction`, async (t) => {
    const h = await workspace(t);
    const scope = await h.start('publish', {});
    if (phase === 'saved') {
      const result = await manageCatalogProductOperation('admin', {
        ...scope,
        action: 'product-operation-save',
      });
      assert.ok(result.ok && result.state === 'saved');
    } else {
      const result = await h.invoke({ ...scope, action: 'product-operation-continue' });
      assert.ok(result.ok, JSON.stringify(result));
      const status = CatalogProductOperationStatusSchema.parse(result.data);
      assert.ok(status.state === 'staging');
      assert.equal(status.approval.mediaReady, false);
    }
    const before = h.bytes();
    let writes = 0;
    const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
      operation: manageCatalogProductOperation,
      persist: async (...args) => {
        writes++;
        return persistCatalogDetailApproval(...args);
      },
      now: () => 0,
    });
    assert.equal(result.ok, false);
    assert.equal(writes, 0);
    assert.equal(h.bytes(), before);
  });

test('the final readback rejects another revision even when the native transaction really committed', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = await manageCatalogProductOperation('admin', {
    action: 'product-operation-get',
    productId: scope.productId,
    operationId: scope.operationId,
  });
  assert.ok(before.ok && before.state === 'staging');
  const result = await continueOwnedCatalogPublication('admin', scope, 12000, {
    operation: async (...args) => {
      const raw = await manageCatalogProductOperation(...args);
      return raw.ok && raw.state === 'complete'
        ? {
            ...raw,
            approval: { ...raw.approval, revision: 'other-approved-revision' },
            completion: { ...raw.completion, revision: 'other-approved-revision' },
          }
        : raw;
    },
    persist: persistCatalogDetailApproval,
    now: () => 0,
  });
  assert.ok(!result.ok && result.code === 'CONFLICT');
  assert.equal(JSON.parse(h.bytes()).products[0].published, true);
  const bytes = h.bytes();
  const confirmed = await continueOwnedCatalogPublication('admin', scope, 12000);
  assert.ok(confirmed.ok && confirmed.state === 'complete');
  assert.equal(confirmed.approval.revision, before.approval.revision);
  assert.equal(h.bytes(), bytes);
});

test('the parent continuation passes only its remaining budget to the actual final service', async (t) => {
  const { h, scope } = await readyFinal(t);
  const before = h.bytes();
  let now = 0;
  let received: number | undefined;
  const result = await continueAdminCatalogProductOperation(
    'admin',
    { ...scope, action: 'product-operation-continue' },
    {
      operation: async (...args) => {
        const raw = await manageCatalogProductOperation(...args);
        now = 11000;
        return raw;
      },
      seed: prepareCatalogProductOperationApproval,
      prepare: async () => {
        throw Error('no preparation');
      },
      configuration: async () => {
        throw Error('no configuration');
      },
      media: async () => {
        throw Error('no media');
      },
      now: () => now,
    },
    12000,
    undefined,
    undefined,
    async (actor, input, budget) => {
      received = budget;
      return continueOwnedCatalogPublication(actor, input, budget);
    },
  );
  assert.ok(result.ok && result.state === 'staging', JSON.stringify(result));
  assert.equal(received, 1000);
  assert.equal(h.bytes(), before);
});

test('default publication of an empty-photo draft returns an actionable photo issue and stays private', async (t) => {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  const rows = JSON.parse(h.bytes());
  rows.products[0].imageIds = [];
  rows.images = [];
  writeFileSync(h.file, JSON.stringify(rows));
  const scope = await h.start('publish', {});
  const response = await h.invokeWithConfig(
    { ...scope, action: 'product-operation-continue' },
    media.config,
  );
  assert.ok(!response.ok, JSON.stringify(response));
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.ok(
    'issues' in response.error &&
      response.error.issues?.some((issue) => issue.path === 'imageIds' && issue.remedy === 'edit'),
  );
  assert.equal(JSON.parse(h.bytes()).products[0].published, false);
});

for (const count of [0, 105])
  test(`the actual ${count}-SKU Admin workflow completes across a 2000ms clock difference and restores its product`, async (t) => {
    const h = await workspace(t, count, true);
    const media = await coldOwnedMedia(h, count > 0);
    const original = await h.adapter.get('products', h.productId);
    assert.ok(original);
    const realNow = Date.now;
    t.mock.method(Date, 'now', () => realNow() - 2000);
    const token = await signSession('owned-continue-test-only', {
      sub: 'admin',
      role: 'admin',
      name: 'Admin',
      email: 'admin@example.test',
    });
    let scope: Awaited<ReturnType<typeof h.start>> | undefined;
    try {
      scope = await h.start('publish', {});
      let completed: ReturnType<typeof CatalogProductOperationStatusSchema.parse> | undefined;
      for (let page = 0; page < 40; page++) {
        const response = await h.invokeWithConfig(
          { ...scope, action: 'product-operation-continue' },
          media.config,
        );
        assert.ok(response.ok, JSON.stringify(response));
        const current = CatalogProductOperationStatusSchema.parse(response.data);
        assert.equal(current.expired, false);
        assert.equal(current.operationId, scope.operationId);
        if (current.state === 'complete') {
          completed = current;
          break;
        }
      }
      assert.ok(completed?.state === 'complete', JSON.stringify(completed));
      assert.equal(completed.current, true);
      const response = await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
        { enableCatalogDetail: true },
      );
      assert.equal(response.statusCode, 200, response.body);
      const detail = decodeCatalogDetailView(JSON.parse(response.body).data);
      assert.ok(detail.ok);
      assert.equal(detail.value.revision, completed.completion.revision);
      assert.equal(detail.value.variants.total, count);
      assert.equal(detail.value.name, original.name);
      assert.equal(
        (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {}))
          .statusCode,
        200,
      );
    } finally {
      const product = await h.adapter.get('products', h.productId);
      assert.ok(product);
      if (product.published === true) {
        assert.ok(scope);
        assert.ok(
          product.catalogDetailApprovalReceipt &&
            typeof product.catalogDetailApprovalReceipt === 'object',
        );
        assert.equal(
          Reflect.get(product.catalogDetailApprovalReceipt, 'operationId'),
          scope.operationId,
        );
        const response = await handleAdminRequest(
          {
            action: 'update',
            token,
            data: {
              collection: 'products',
              id: h.productId,
              values: { published: false },
              expectedUpdatedAt: product.updatedAt,
            },
          },
          { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true },
        );
        assert.ok(response.ok, JSON.stringify(response));
      } else if (scope) {
        const cancelled = await h.invokeWithConfig(
          { ...scope, action: 'product-operation-cancel' },
          media.config,
        );
        assert.ok(cancelled.ok, JSON.stringify(cancelled));
      }
      const restored = await h.adapter.get('products', h.productId);
      assert.ok(restored);
      assert.equal(restored.published, false);
      for (const field of ['productFamily', 'category', 'subcategoryIds']) {
        assert.equal(Object.hasOwn(restored, field), Object.hasOwn(original, field));
        assert.deepEqual(restored[field], original[field]);
      }
      for (const path of [`/api/products/${h.productId}/detail`, '/api/images/image'])
        assert.equal(
          (await handlePublicApiEvent({ httpMethod: 'GET', path }, { enableCatalogDetail: true }))
            .statusCode,
          404,
        );
      const effective = await h.adapter.readCatalogImageReference({
        action: 'read',
        imageId: 'image',
      });
      assert.ok(effective.state === 'counted');
      assert.equal(effective.effectiveCount, 0);
    }
  });
