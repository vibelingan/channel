import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  at,
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { AdminApiError } from './api.ts';
import {
  type PublicationCommand,
  createPublicationAttempt,
  managePublication,
} from './catalog-product-operation-api.ts';

for (const lostAction of ['product-operation-start', 'product-operation-continue'])
  test(`the actual browser client recovers a lost ${lostAction} answer through the real default Admin and restores its product`, async (t) => {
    const h = await workspace(t, 0, true);
    const media = await coldOwnedMedia(h);
    const rows = JSON.parse(h.bytes());
    Object.assign(rows.products[0], { alibabaReviewPending: true, alibabaReviewReason: 'new' });
    const original = structuredClone(rows.products[0]);
    writeFileSync(h.file, JSON.stringify(rows));
    const attempt = createPublicationAttempt({
      productId: h.productId,
      expectedUpdatedAt: at,
      values: {},
    });
    const calls: PublicationCommand[] = [];
    let lost = false;
    const request = async (command: PublicationCommand) => {
      calls.push(structuredClone(command));
      const response = await h.invokeWithConfig(command, media.config);
      if (!response.ok)
        throw new AdminApiError(
          response.error.code,
          response.error.message,
          'issues' in response.error ? response.error.issues : undefined,
        );
      if (!lost && command.action === lostAction) {
        lost = true;
        throw Error('actual committed response lost');
      }
      return response.data;
    };
    const token = await signSession('owned-continue-test-only', {
      sub: 'admin',
      role: 'admin',
      name: 'Admin',
      email: 'admin@example.test',
    });
    let digest: string | undefined;
    try {
      let result = await managePublication(attempt, { request });
      if (lostAction === 'product-operation-start') assert.equal(result.recovery, 'status');
      digest = result.status.inputDigest;
      for (let page = 0; page < 40 && result.status.state !== 'complete'; page++)
        result = await managePublication(
          {
            action: 'product-operation-continue',
            productId: h.productId,
            operationId: attempt.operationId,
            inputDigest: digest,
          },
          { request },
        );
      assert.ok(result.status.state === 'complete');
      assert.equal(result.status.current, true);
      assert.equal(lost, true);
      assert.equal(calls.filter((call) => call.action === 'product-operation-start').length, 1);
      assert.ok(calls.every((call) => call.operationId === attempt.operationId));
      const product = await h.adapter.get('products', h.productId);
      assert.ok(product);
      assert.ok(
        product.catalogDetailApprovalReceipt &&
          typeof product.catalogDetailApprovalReceipt === 'object',
      );
      assert.equal(product.published, true);
      assert.equal(product.alibabaReviewPending, false);
      assert.equal(
        Reflect.get(product.catalogDetailApprovalReceipt, 'operationId'),
        attempt.operationId,
      );
      const detail = await handlePublicApiEvent(
        { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
        { enableCatalogDetail: true },
      );
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(JSON.parse(detail.body).data.revision, result.status.completion.revision);
    } finally {
      const product = await h.adapter.get('products', h.productId);
      assert.ok(product);
      if (product.published === true) {
        assert.ok(
          product.catalogDetailApprovalReceipt &&
            typeof product.catalogDetailApprovalReceipt === 'object',
        );
        assert.equal(
          Reflect.get(product.catalogDetailApprovalReceipt, 'operationId'),
          attempt.operationId,
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
      if (digest && restored.catalogDetailApprovalReceipt) {
        const before = h.bytes();
        const historic = await managePublication(
          {
            action: 'product-operation-continue',
            productId: h.productId,
            operationId: attempt.operationId,
            inputDigest: digest,
          },
          { request },
        );
        assert.ok(historic.status.state === 'complete');
        assert.equal(historic.status.current, false);
        assert.equal(h.bytes(), before);
      }
    }
  });

test('a definite review issue can follow private progress and the same client can query and cancel that original scope', async (t) => {
  const h = await workspace(t, 0, true);
  const media = await coldOwnedMedia(h);
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.products[0], { alibabaReviewPending: true, alibabaReviewReason: 'changed' });
  writeFileSync(h.file, JSON.stringify(rows));
  const attempt = createPublicationAttempt({
    productId: h.productId,
    expectedUpdatedAt: at,
    values: {},
  });
  const request = async (command: PublicationCommand) => {
    const response = await h.invokeWithConfig(command, media.config);
    if (!response.ok)
      throw new AdminApiError(
        response.error.code,
        response.error.message,
        'issues' in response.error ? response.error.issues : undefined,
      );
    return response.data;
  };
  const started = await managePublication(attempt, { request });
  const scope = {
    productId: h.productId,
    operationId: attempt.operationId,
    inputDigest: started.status.inputDigest,
  };
  try {
    let error: unknown;
    for (let step = 0; step < 40 && !error; step++) {
      try {
        await managePublication({ ...scope, action: 'product-operation-continue' }, { request });
      } catch (caught) {
        error = caught;
      }
    }
    assert.ok(error instanceof AdminApiError);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.ok(error.issues.some((issue) => issue.remedy === 'review-change'));
    const current = await managePublication(
      {
        action: 'product-operation-get',
        productId: scope.productId,
        operationId: scope.operationId,
      },
      { request, expectedInputDigest: scope.inputDigest },
    );
    assert.equal(current.status.state, 'staging');
    assert.equal(current.status.current, true);
    assert.ok(current.status.state === 'staging');
    assert.equal(current.status.approval.references.staged, 1);
    assert.equal((await h.adapter.get('products', h.productId))?.published, false);
  } finally {
    const cancelled = await managePublication(
      { ...scope, action: 'product-operation-cancel' },
      { request },
    );
    assert.ok('cancelledAt' in cancelled.status && cancelled.status.cancelledAt);
    const effective = await h.adapter.readCatalogImageReference({
      action: 'read',
      imageId: 'image',
    });
    assert.ok(effective.state === 'counted');
    assert.equal(effective.effectiveCount, 0);
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
