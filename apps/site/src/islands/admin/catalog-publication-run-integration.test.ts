import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  at,
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { AdminApiError } from './api.ts';
import type { PreparationCommand } from './catalog-preparation-api.ts';
import {
  type PublicationCommand,
  createPublicationAttempt,
  managePublication,
} from './catalog-product-operation-api.ts';
import { createPublicationJournal } from './catalog-publication-journal.ts';
import { runPublication } from './catalog-publication-run.ts';

async function fixture(t: TestContext, count = 0) {
  const h = await workspace(t, count, true);
  const media = await coldOwnedMedia(h, count > 0);
  const original = structuredClone(await h.adapter.get('products', h.productId));
  assert.ok(original);
  const attempt = createPublicationAttempt({
    productId: h.productId,
    expectedUpdatedAt: at,
    values: {},
  });
  const calls: PublicationCommand[] = [];
  const humanCalls: PreparationCommand[] = [];
  const token = await signSession('owned-continue-test-only', {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const unwrap = (answer: Awaited<ReturnType<typeof handleAdminRequest>>) => {
    if (!answer.ok)
      throw new AdminApiError(
        answer.error.code,
        answer.error.message,
        'issues' in answer.error ? answer.error.issues : undefined,
      );
    return answer.data;
  };
  const request = async (command: PublicationCommand) => {
    calls.push(structuredClone(command));
    return unwrap(await h.invokeWithConfig(command, media.config));
  };
  const preparationRequest = async (command: PreparationCommand) => {
    humanCalls.push(structuredClone(command));
    return unwrap(
      await handleAdminRequest(
        { action: 'catalogPreparation', token, data: command },
        { jwtSecret: 'owned-continue-test-only', enableDetailApproval: true, ...media.config },
      ),
    );
  };
  const restore = async () => {
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
      unwrap(
        await handleAdminRequest(
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
        ),
      );
    } else {
      const current = await managePublication(
        {
          action: 'product-operation-get',
          productId: h.productId,
          operationId: attempt.operationId,
        },
        { request },
      );
      if (current.status.state !== 'complete' && !current.status.cancelledAt)
        await managePublication(
          {
            action: 'product-operation-cancel',
            productId: h.productId,
            operationId: attempt.operationId,
            inputDigest: current.status.inputDigest,
          },
          { request },
        );
    }
    const restored = await h.adapter.get('products', h.productId);
    assert.ok(restored);
    assert.equal(restored.published, false);
    for (const key of ['productFamily', 'category', 'subcategoryIds']) {
      assert.equal(Object.hasOwn(restored, key), Object.hasOwn(original, key));
      assert.deepEqual(restored[key], original[key]);
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
  };
  const publicReadback = async (revision: string) => {
    const response = await handlePublicApiEvent(
      { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
      { enableCatalogDetail: true },
    );
    assert.equal(response.statusCode, 200, response.body);
    const detail = decodeCatalogDetailView(JSON.parse(response.body).data);
    assert.ok(detail.ok, JSON.stringify(detail));
    assert.equal(detail.value.revision, revision);
    assert.equal(detail.value.name, original.name);
    assert.equal(detail.value.variants.total, count);
    const image = await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {});
    assert.equal(image.statusCode, 200);
  };
  return {
    h,
    media,
    attempt,
    calls,
    humanCalls,
    request,
    preparationRequest,
    restore,
    publicReadback,
  };
}

for (const count of [0, 105])
  test(`the coordinator publishes ${count} actual source SKUs and protected PNG, then restores its original classification`, async (t) => {
    const f = await fixture(t, count);
    try {
      const result = await runPublication(f.attempt, {
        request: f.request,
        preparationRequest: f.preparationRequest,
      });
      assert.equal(result.reason, 'committed', JSON.stringify(result));
      assert.ok(result.status?.state === 'complete');
      await f.publicReadback(result.status.completion.revision);
      assert.equal(f.calls.filter((x) => x.action === 'product-operation-start').length, 1);
      assert.ok(f.calls.every((x) => x.operationId === f.attempt.operationId));
    } finally {
      await f.restore();
    }
  });

for (const lost of ['start', 'final'])
  test(`the coordinator recovers a lost actual ${lost} response without replacing its operation`, async (t) => {
    const f = await fixture(t);
    let injected = false;
    try {
      const result = await runPublication(f.attempt, {
        preparationRequest: f.preparationRequest,
        request: async (command) => {
          const answer = await f.request(command);
          if (
            !injected &&
            ((lost === 'start' && command.action === 'product-operation-start') ||
              (lost === 'final' &&
                typeof answer === 'object' &&
                answer !== null &&
                Reflect.get(answer, 'state') === 'complete'))
          ) {
            injected = true;
            throw Error('response lost');
          }
          return answer;
        },
      });
      assert.equal(injected, true);
      assert.equal(result.reason, 'committed', JSON.stringify(result));
      assert.ok(result.status?.state === 'complete');
      await f.publicReadback(result.status.completion.revision);
      assert.equal(f.calls.filter((x) => x.action === 'product-operation-start').length, 1);
      assert.ok(f.calls.every((x) => x.operationId === f.attempt.operationId));
      assert.ok(f.calls.some((x) => x.action === 'product-operation-get'));
    } finally {
      await f.restore();
    }
  });

test('standalone actual Human preparation escapes an exhausted inline budget and recovers its lost worker response', async (t) => {
  const f = await fixture(t);
  let delayed = false;
  let lost = false;
  const original = f.h.adapter.saveCatalogProductWithIdentities.bind(f.h.adapter);
  f.h.adapter.saveCatalogProductWithIdentities = async (...args) => {
    const answer = await original(...args);
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
    return answer;
  };
  try {
    const result = await runPublication(f.attempt, {
      request: f.request,
      preparationRequest: async (command) => {
        const answer = await f.preparationRequest(command);
        if (!lost && command.action === 'continue') {
          lost = true;
          throw Error('actual worker answer lost');
        }
        return answer;
      },
    });
    assert.equal(result.reason, 'committed', JSON.stringify(result));
    assert.equal(delayed, true);
    assert.equal(lost, true);
    assert.equal(f.humanCalls.filter((x) => x.action === 'start').length, 1);
    assert.equal(f.humanCalls.filter((x) => x.action === 'continue').length, 1);
    assert.ok(f.humanCalls.some((x) => x.action === 'status'));
    assert.ok(result.status?.state === 'complete');
    await f.publicReadback(result.status.completion.revision);
    assert.equal(JSON.parse(f.h.bytes()).catalogPreparationJobs.length, 1);
  } finally {
    await f.restore();
  }
});

test('a real review error retains private staging, is resumed with the original scope, and can be cancelled', async (t) => {
  const f = await fixture(t);
  const rows = JSON.parse(f.h.bytes());
  Object.assign(rows.products[0], { alibabaReviewPending: true, alibabaReviewReason: 'changed' });
  writeFileSync(f.h.file, JSON.stringify(rows));
  try {
    const result = await runPublication(f.attempt, {
      request: f.request,
      preparationRequest: f.preparationRequest,
    });
    assert.equal(result.reason, 'needs-action', JSON.stringify(result));
    assert.ok(result.error?.issues.some((x) => x.remedy === 'review-change'));
    assert.equal(result.status?.state, 'staging');
    assert.equal((await f.h.adapter.get('products', f.h.productId))?.published, false);
    const resumed = await runPublication(result.scope, {
      request: f.request,
      preparationRequest: f.preparationRequest,
    });
    assert.equal(resumed.reason, 'needs-action');
    assert.equal(resumed.scope.operationId, f.attempt.operationId);
    assert.equal(f.calls.filter((x) => x.action === 'product-operation-start').length, 1);
  } finally {
    await f.restore();
  }
});

test('a stopped browser can resume its real reserved operation and never replays a later historic receipt', async (t) => {
  const f = await fixture(t);
  try {
    const paused = await runPublication(f.attempt, {
      request: f.request,
      onStatus: () => {
        throw Error('browser storage failed');
      },
    });
    assert.equal(paused.reason, 'paused');
    assert.equal(paused.status?.state, 'reserved');
    assert.equal((await f.h.adapter.get('products', f.h.productId))?.published, false);
    const result = await runPublication(paused.scope, {
      request: f.request,
      preparationRequest: f.preparationRequest,
    });
    assert.equal(result.reason, 'committed', JSON.stringify(result));
    assert.ok(result.status?.state === 'complete');
    await f.publicReadback(result.status.completion.revision);
    await f.restore();
    const before = f.h.bytes();
    const historic = await runPublication(result.scope, {
      request: f.request,
      preparationRequest: f.preparationRequest,
    });
    assert.equal(historic.reason, 'historical');
    assert.equal(f.h.bytes(), before);
    assert.equal(f.calls.filter((x) => x.action === 'product-operation-start').length, 1);
  } finally {
    await f.restore();
  }
});

test('pre-dispatch journal survives a lost real start and failed confirmation, then resumes without a replacement', async (t) => {
  const f = await fixture(t);
  const bytes = new Map<string, string>();
  const storage = {
    get length() {
      return bytes.size;
    },
    key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => {
      bytes.set(key, value);
    },
    removeItem: (key: string) => {
      bytes.delete(key);
    },
  };
  const owner = { actorId: 'admin', endpoint: 'https://owned.test/api/admin' };
  const journal = createPublicationJournal(owner, () => storage);
  const initialScope = { productId: f.h.productId, operationId: f.attempt.operationId };
  assert.equal(journal.retain({ scope: initialScope }).durability, 'persistent');
  try {
    const unknown = await runPublication(f.attempt, {
      request: async (command) => {
        if (command.action === 'product-operation-start') await f.request(command);
        throw Error('browser lost start and confirmation responses');
      },
    });
    assert.equal(unknown.reason, 'unknown');
    assert.equal((await f.h.adapter.get('products', f.h.productId))?.published, false);
    const reopened = createPublicationJournal(owner, () => storage);
    const saved = reopened.read().entries[0];
    assert.ok(saved);
    assert.deepEqual(saved, { scope: initialScope });
    const completed = await runPublication(saved.scope, {
      request: f.request,
      preparationRequest: f.preparationRequest,
      onStatus: (_status, checkpoint) => {
        reopened.retain(checkpoint);
      },
    });
    assert.equal(completed.reason, 'committed', JSON.stringify(completed));
    assert.ok(completed.status?.state === 'complete');
    await f.publicReadback(completed.status.completion.revision);
    assert.equal(reopened.read().entries[0]?.scope.inputDigest, completed.scope.inputDigest);
    assert.equal(
      f.calls.filter((command) => command.action === 'product-operation-start').length,
      1,
    );
    assert.ok(f.calls.every((command) => command.operationId === f.attempt.operationId));
    await f.restore();
    reopened.forget(completed.scope);
    assert.equal(reopened.read().entries.length, 0);
  } finally {
    await f.restore();
  }
});
