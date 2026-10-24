import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { manageCatalogProductOperation } from '@vibelingan-channel/db';
import {
  type CatalogProductOperationStatus,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { coldOwnedMedia, workspace } from './testing/catalog-operation-workspace.ts';

function cancellationTime(status: CatalogProductOperationStatus): string | undefined {
  return status.state === 'complete' ? undefined : status.cancelledAt;
}

for (const intent of ['save-draft', 'publish', 'refresh-live'] as const)
  test(`atomic Stop fences a never-arrived ${intent} request without its private editor body`, async (t) => {
    const h = await workspace(t, undefined, true);
    const media = await coldOwnedMedia(h);
    const operationId = randomUUID();
    const before = await h.adapter.get('products', h.productId);
    assert.ok(before);
    const images = await h.adapter.get('images', 'image');
    const stop = { action: 'product-operation-stop', productId: h.productId, operationId, intent };
    const response = await h.invokeWithConfig(stop, media.config);
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    assert.equal(status.state, 'reserved');
    assert.equal(status.intent, intent);
    assert.ok(cancellationTime(status));
    assert.equal(status.current, false);
    assert.equal('values' in status, false);
    assert.deepEqual(await h.adapter.get('products', h.productId), before);
    assert.deepEqual(await h.adapter.get('images', 'image'), images);
    const bytes = h.bytes();
    assert.deepEqual(await h.invokeWithConfig(stop, media.config), response);
    assert.equal(h.bytes(), bytes);
    const late = await h.invokeWithConfig(
      {
        action: 'product-operation-start',
        productId: h.productId,
        operationId,
        intent,
        expectedUpdatedAt: before.updatedAt ?? null,
        values: { description: 'Original private editor text that never arrived' },
      },
      media.config,
    );
    assert.ok(!late.ok && late.error.code === 'CONFLICT', JSON.stringify(late));
    const continued = await h.invokeWithConfig(
      {
        action: 'product-operation-continue',
        productId: h.productId,
        operationId,
        inputDigest: status.inputDigest,
      },
      media.config,
    );
    assert.ok(!continued.ok, JSON.stringify(continued));
    assert.deepEqual(await h.adapter.get('products', h.productId), before);
    assert.equal(h.bytes(), bytes);
  });

for (const order of ['stop-first', 'start-first', 'race'] as const)
  test(`atomic Stop and original start share one root under ${order}`, async (t) => {
    const h = await workspace(t, undefined, true);
    const before = await h.adapter.get('products', h.productId);
    assert.ok(before);
    const operationId = randomUUID();
    const start = {
      action: 'product-operation-start',
      productId: h.productId,
      operationId,
      intent: 'publish',
      expectedUpdatedAt: before.updatedAt ?? null,
      values: { name: 'Original editor name' },
    };
    const stop = {
      action: 'product-operation-stop',
      productId: h.productId,
      operationId,
      intent: 'publish',
    };
    const replies =
      order === 'race'
        ? await Promise.all([h.invoke(start), h.invoke(stop)])
        : order === 'start-first'
          ? [await h.invoke(start), await h.invoke(stop)]
          : [await h.invoke(stop), await h.invoke(start)];
    assert.ok(
      replies.some(
        (result) =>
          result.ok && cancellationTime(CatalogProductOperationStatusSchema.parse(result.data)),
      ),
      JSON.stringify(replies),
    );
    const read = await h.invoke({
      action: 'product-operation-get',
      productId: h.productId,
      operationId,
    });
    assert.ok(read.ok);
    const status = CatalogProductOperationStatusSchema.parse(read.data);
    assert.ok(cancellationTime(status));
    assert.deepEqual(await h.adapter.get('products', h.productId), before);
    assert.equal(
      JSON.parse(h.bytes()).catalogDetailApprovals.filter(
        (row: { operationId?: string }) => row.operationId === operationId,
      ).length,
      1,
    );
  });

test('atomic Stop keeps saved draft edits and cannot stop a different owner or intent', async (t) => {
  const h = await workspace(t, undefined, true);
  const scope = await h.start('save-draft', { description: 'Saved editor text' });
  const saved = await h.invoke({ ...scope, action: 'product-operation-save' });
  assert.ok(saved.ok, JSON.stringify(saved));
  const before = await h.adapter.get('products', h.productId);
  const wrong = await h.invoke({
    action: 'product-operation-stop',
    productId: h.productId,
    operationId: scope.operationId,
    intent: 'publish',
  });
  assert.ok(!wrong.ok && wrong.error.code === 'CONFLICT', JSON.stringify(wrong));
  await h.adapter.create('users', { _id: 'other-admin', role: 'admin', status: 'active' });
  const otherToken = await signSession('owned-continue-test-only', {
    sub: 'other-admin',
    role: 'admin',
    name: 'Other',
    email: 'other@example.test',
  });
  const other = await handleAdminRequest(
    {
      action: 'catalogDetailApproval',
      token: otherToken,
      data: {
        action: 'product-operation-stop',
        productId: h.productId,
        operationId: scope.operationId,
        intent: 'save-draft',
      },
    },
    { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true },
  );
  assert.ok(other.ok, JSON.stringify(other));
  const original = await h.invoke({
    action: 'product-operation-get',
    productId: h.productId,
    operationId: scope.operationId,
  });
  assert.ok(original.ok);
  assert.equal(
    cancellationTime(CatalogProductOperationStatusSchema.parse(original.data)),
    undefined,
  );
  const stopped = await h.invoke({
    action: 'product-operation-stop',
    productId: h.productId,
    operationId: scope.operationId,
    intent: 'save-draft',
  });
  assert.ok(stopped.ok, JSON.stringify(stopped));
  assert.ok(cancellationTime(CatalogProductOperationStatusSchema.parse(stopped.data)));
  assert.deepEqual(await h.adapter.get('products', h.productId), before);
});

for (const complete of [false, true])
  test(`atomic Stop ${complete ? 'only reads a completed publication' : 'cancels staged media without granting public image rights'}`, async (t) => {
    const h = await workspace(t, undefined, true);
    const media = await coldOwnedMedia(h);
    const before = await h.adapter.get('products', h.productId);
    assert.ok(before);
    const scope = await h.start('publish', {});
    try {
      let latest: CatalogProductOperationStatus | undefined;
      for (let index = 0; index < 8; index++) {
        const step = await h.invokeWithConfig(
          { ...scope, action: 'product-operation-continue' },
          {
            ...media.config,
            ...(!complete
              ? {
                  productOperationPublisher: (
                    actor: string,
                    binding: { productId: string; operationId: string },
                  ) =>
                    manageCatalogProductOperation(actor, {
                      action: 'product-operation-get',
                      productId: binding.productId,
                      operationId: binding.operationId,
                    }),
                }
              : {}),
          },
        );
        assert.ok(step.ok, JSON.stringify(step));
        latest = CatalogProductOperationStatusSchema.parse(step.data);
        if (
          complete
            ? latest.state === 'complete'
            : latest.state === 'staging' &&
              latest.approval.references.prepared &&
              latest.approval.references.staged === latest.approval.references.total
        )
          break;
      }
      assert.ok(latest && (complete ? latest.state === 'complete' : latest.state === 'staging'));
      const saved = await h.adapter.get('products', h.productId);
      const bytes = h.bytes();
      const stopped = await h.invokeWithConfig(
        {
          action: 'product-operation-stop',
          productId: h.productId,
          operationId: scope.operationId,
          intent: 'publish',
        },
        media.config,
      );
      assert.ok(stopped.ok, JSON.stringify(stopped));
      const status = CatalogProductOperationStatusSchema.parse(stopped.data);
      if (complete) {
        assert.equal(status.state, 'complete');
        assert.equal(h.bytes(), bytes);
      } else assert.ok(cancellationTime(status));
      assert.deepEqual(await h.adapter.get('products', h.productId), saved);
      const references = await h.adapter.readCatalogImageReference({
        action: 'read',
        imageId: 'image',
      });
      assert.ok(references.state === 'counted');
      assert.equal(references.effectiveCount, complete ? 1 : 0);
      assert.equal(
        (
          await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
            { enableCatalogDetail: true },
          )
        ).statusCode,
        complete ? 200 : 404,
      );
    } finally {
      const current = await h.adapter.get('products', h.productId);
      if (current?.published === true) {
        assert.ok(
          current.catalogDetailApprovalReceipt &&
            typeof current.catalogDetailApprovalReceipt === 'object',
        );
        assert.equal(
          Reflect.get(current.catalogDetailApprovalReceipt, 'operationId'),
          scope.operationId,
          'restore only this fixture’s publication',
        );
        const token = await signSession('owned-continue-test-only', {
          sub: 'admin',
          role: 'admin',
          name: 'Admin',
          email: 'admin@example.test',
        });
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
          { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true, ...media.config },
        );
        assert.ok(restored.ok, JSON.stringify(restored));
      }
      assert.equal((await h.adapter.get('products', h.productId))?.published, false);
      assert.equal(
        (
          await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
            { enableCatalogDetail: true },
          )
        ).statusCode,
        404,
      );
    }
  });

test('atomic Stop rejects extra input and revoked actors without writing a root', async (t) => {
  const h = await workspace(t, undefined, true);
  const stop = {
    action: 'product-operation-stop',
    productId: h.productId,
    operationId: randomUUID(),
    intent: 'publish',
  };
  const before = h.bytes();
  const malformed = await h.invoke({ ...stop, values: { description: 'Must not be accepted' } });
  assert.ok(!malformed.ok);
  assert.equal(h.bytes(), before);
  await h.adapter.update('users', 'admin', { status: 'suspended' });
  const suspended = h.bytes();
  const denied = await h.invoke(stop);
  assert.ok(!denied.ok, JSON.stringify(denied));
  assert.equal(h.bytes(), suspended);
});

test('atomic Stop does not allocate an operation for a missing product', async (t) => {
  const h = await workspace(t, undefined, true);
  const before = h.bytes();
  const result = await h.invoke({
    action: 'product-operation-stop',
    productId: 'absent-product',
    operationId: randomUUID(),
    intent: 'publish',
  });
  assert.ok(!result.ok && result.error.code === 'NOT_FOUND', JSON.stringify(result));
  assert.equal(h.bytes(), before);
});
