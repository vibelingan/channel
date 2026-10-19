import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { AdminApiError } from './api.ts';
import {
  type PublicationCommand,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import {
  type PublicationBatchOptions,
  createPublicationBatch,
} from './catalog-publication-batch.ts';

for (const mode of ['continue', 'cancel', 'nonempty'] as const)
  test(
    `a reopened original publication ${mode} handles a start that never reached the real server`,
    { timeout: 90000 },
    async (t) => {
      const h = await workspace(t, 0, true);
      const media = await coldOwnedMedia(h);
      const before = await h.adapter.get('products', h.productId);
      assert.ok(before);
      const token = await signSession('owned-continue-test-only', {
        sub: 'admin',
        role: 'admin',
        name: 'Admin',
        email: 'admin@example.test',
      });
      const config = {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
        ...media.config,
      };
      const values = mode === 'nonempty' ? { description: 'Private unsaved draft text' } : {};
      const attempt = createPublicationAttempt({
        productId: h.productId,
        expectedUpdatedAt: String(before.updatedAt),
        values,
      });
      const entries = new Map<string, string>();
      const storage = {
        get length() {
          return entries.size;
        },
        key: (n: number) => [...entries.keys()][n] ?? null,
        getItem: (k: string) => entries.get(k) ?? null,
        setItem: (k: string, v: string) => {
          entries.set(k, v);
        },
        removeItem: (k: string) => {
          entries.delete(k);
        },
      };
      let drop = true;
      const calls: PublicationCommand[] = [];
      const unwrap = (reply: Awaited<ReturnType<typeof handleAdminRequest>>) => {
        if (!reply.ok)
          throw new AdminApiError(
            reply.error.code,
            reply.error.message,
            'issues' in reply.error ? reply.error.issues : undefined,
          );
        return reply.data;
      };
      const options: PublicationBatchOptions = {
        session: () => ({ actorId: 'admin', token, endpoint: 'https://original.local/api/admin' }),
        authorize: async () => ({ id: 'admin', role: 'admin' }),
        storage: () => storage,
        request: async (command) => {
          calls.push(structuredClone(command));
          if (drop && command.action === 'product-operation-start') {
            drop = false;
            throw Error('request disconnected before server admission');
          }
          return unwrap(await h.invokeWithConfig(command, media.config));
        },
        preparationRequest: async (command) =>
          unwrap(
            await handleAdminRequest(
              { action: 'catalogPreparation', token, data: command },
              config,
            ),
          ),
        fetch: async (input) => {
          const url = new URL(String(input), 'https://original.local');
          const response = await handlePublicApiEvent(
            {
              httpMethod: 'GET',
              path: url.pathname,
              queryStringParameters: Object.fromEntries(url.searchParams),
            },
            { enableCatalogDetail: true },
          );
          return new Response(response.body, {
            status: response.statusCode,
            headers: response.headers,
          });
        },
      };
      const first = createPublicationBatch(options);
      const unknown = await first.run([attempt]);
      assert.equal(unknown.items[0]?.state, 'unknown');
      const pointer = first.journal.read().entries[0];
      assert.ok(pointer);
      assert.equal(pointer.scope.inputDigest, undefined);
      assert.equal(JSON.stringify([...entries]).includes('Private unsaved draft text'), false);
      const reopened = createPublicationBatch(options);
      try {
        const result = await reopened.run(
          [pointer],
          undefined,
          mode === 'cancel' ? 'cancel' : 'continue',
        );
        if (mode === 'continue') {
          assert.equal(result.confirmed, 1, JSON.stringify(result.items));
          assert.equal((await h.adapter.get('products', h.productId))?.published, true);
        } else if (mode === 'cancel') {
          assert.equal(result.items[0]?.state, 'cancelled', JSON.stringify(result.items));
          assert.equal(
            calls.some((call) => call.action === 'product-operation-continue'),
            false,
          );
          assert.deepEqual(await h.adapter.get('products', h.productId), before);
        } else {
          assert.equal(result.confirmed, 0);
          assert.equal(calls.filter((call) => call.action === 'product-operation-start').length, 1);
          assert.deepEqual(await h.adapter.get('products', h.productId), before);
        }
        assert.ok(
          calls.every(
            (call) =>
              call.productId === attempt.productId && call.operationId === attempt.operationId,
          ),
        );
        for (const call of calls.filter((call) => call.action === 'product-operation-start'))
          assert.deepEqual(call, attempt);
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
          const withdrawn = await handleAdminRequest(
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
            config,
          );
          assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
        } else {
          const status = await h.invoke({
            action: 'product-operation-get',
            productId: h.productId,
            operationId: attempt.operationId,
          });
          if (status.ok && typeof status.data === 'object' && status.data) {
            const inputDigest = Reflect.get(status.data, 'inputDigest');
            if (typeof inputDigest === 'string')
              await h.invoke({
                action: 'product-operation-cancel',
                productId: h.productId,
                operationId: attempt.operationId,
                inputDigest,
              });
          }
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
    },
  );
