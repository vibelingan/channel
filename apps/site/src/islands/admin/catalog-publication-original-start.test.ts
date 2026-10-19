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
  PublicationScopeSchema,
  createPublicationAttempt,
} from './catalog-product-operation-api.ts';
import {
  type PublicationBatchOptions,
  createPublicationBatch,
} from './catalog-publication-batch.ts';
import { checkPublication } from './catalog-publication-check.ts';

for (const mode of ['continue', 'cancel', 'changedcancel', 'boundcancel', 'nonempty'] as const)
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
      let failBoundRead = false;
      let rowReads = 0;
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
        readProduct: async (productId) => {
          rowReads++;
          const product = await h.adapter.get('products', productId);
          assert.ok(product);
          return product;
        },
        check: async (scope, options) => {
          // Inject a check-layer failure only after the real reservation returned its binding.
          if (
            mode === 'boundcancel' &&
            failBoundRead &&
            PublicationScopeSchema.parse(scope).inputDigest
          ) {
            failBoundRead = false;
            throw new AdminApiError('CONFLICT', 'Bound check failed after reservation');
          }
          return checkPublication(scope, options);
        },
        request: async (command) => {
          calls.push(structuredClone(command));
          if (drop && command.action === 'product-operation-start') {
            drop = false;
            throw Error('request disconnected before server admission');
          }
          if (
            mode === 'boundcancel' &&
            failBoundRead &&
            command.action === 'product-operation-get'
          ) {
            failBoundRead = false;
            throw new AdminApiError('CONFLICT', 'The bound task read was unavailable');
          }
          const result = unwrap(await h.invokeWithConfig(command, media.config));
          if (mode === 'boundcancel' && command.action === 'product-operation-start') {
            await h.adapter.update('products', h.productId, { name: 'Bound original later edit' });
            failBoundRead = true;
          }
          return result;
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
      if (mode === 'changedcancel')
        await h.adapter.update('products', h.productId, { name: 'Later edit must survive' });
      const expected = await h.adapter.get('products', h.productId);
      const reopened = createPublicationBatch(options);
      try {
        const result = await reopened.run(
          [pointer],
          undefined,
          mode === 'cancel' || mode === 'changedcancel' || mode === 'boundcancel'
            ? 'cancel'
            : 'continue',
        );
        if (mode === 'continue') {
          assert.equal(result.confirmed, 1, JSON.stringify(result.items));
          assert.equal((await h.adapter.get('products', h.productId))?.published, true);
        } else if (mode === 'boundcancel') {
          assert.equal(result.items[0]?.state, 'unknown');
          assert.equal(rowReads, 0, 'a bound root must not enter absent-start abandonment');
          assert.equal(typeof result.items[0]?.scope.inputDigest, 'string');
          assert.equal(typeof reopened.journal.read().entries[0]?.scope.inputDigest, 'string');
          assert.equal(
            (await h.adapter.get('products', h.productId))?.name,
            'Bound original later edit',
          );
        } else if (mode === 'cancel' || mode === 'changedcancel') {
          assert.equal(
            result.items[0]?.state,
            mode === 'cancel' ? 'cancelled' : 'not-started',
            JSON.stringify(result.items),
          );
          if (mode === 'changedcancel') {
            assert.equal(Reflect.get(result.items[0] ?? {}, 'stoppedBeforeStart'), true);
            assert.equal(reopened.journal.read().entries.length, 0);
          }
          assert.equal(
            calls.some((call) => call.action === 'product-operation-continue'),
            false,
          );
          assert.deepEqual(await h.adapter.get('products', h.productId), expected);
        } else {
          assert.equal(result.confirmed, 0);
          assert.equal(calls.filter((call) => call.action === 'product-operation-start').length, 1);
          assert.deepEqual(await h.adapter.get('products', h.productId), expected);
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
