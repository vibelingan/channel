import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { batchUpdateRecords, retryBatchUpdate } from './api.ts';

for (const fault of [
  'normal',
  'completion',
  'public-read',
  'wrong-status',
  'before-start',
  'revoked',
  'mutated-input',
  'mutated-before-import',
  'already-live',
  'mutated-retry',
] as const)
  test(
    `table owned publication ${fault} preserves 20 original products and restores them`,
    { timeout: 90000 },
    async (t) => {
      const h = await workspace(t, 0, true);
      const media = await coldOwnedMedia(h);
      const token = await signSession('owned-continue-test-only', {
        sub: 'admin',
        role: 'admin',
        name: 'Admin',
        email: 'admin@example.test',
      });
      const store = new Map<string, string>([
        ['channel.token', token],
        ['channel.user', JSON.stringify({ id: 'admin', role: 'admin', name: 'Admin' })],
      ]);
      const storage = {
        get length() {
          return store.size;
        },
        key: (n: number) => [...store.keys()][n] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      };
      for (const [name, value] of [
        ['localStorage', storage],
        ['location', new URL('https://table.test/admin')],
      ] as const) {
        const before = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => {
          if (before) Object.defineProperty(globalThis, name, before);
          else Reflect.deleteProperty(globalThis, name);
        });
      }
      const config = {
        jwtSecret: 'owned-continue-test-only',
        enableDetailApproval: true,
        ...media.config,
      };
      const selected = Array.from({ length: 20 }, (_, index) => `table-product-${index}`);
      for (const id of selected)
        await h.adapter.create('products', {
          _id: id,
          name: `Owned table product ${id}`,
          description: 'Reviewed manual table product',
          productFamily: 'misc',
          imageIds: ['image'],
          published: false,
          archived: false,
          unitPrice: 5.7,
          moq: 1,
        });
      const opened: CollectionDoc[] = await Promise.all(
        selected.map(async (id) => {
          const row = await h.adapter.get('products', id);
          assert.ok(row);
          return row;
        }),
      );
      const revisions = new Map(opened.map((row) => [row._id, row.updatedAt ?? null]));
      const ids = [...selected];
      const values: Record<string, unknown> = { published: true };
      const starts: {
        productId: string;
        operationId: string;
        expectedUpdatedAt: string | null;
        values: Record<string, unknown>;
        intent: string;
      }[] = [];
      const legacy: string[] = [];
      const dropped = new Set<string>();
      let block = fault === 'public-read' || fault === 'wrong-status' || fault === 'mutated-retry';
      let mutated = false;
      let measureNoop = false;
      let readActive = 0;
      let readPeak = 0;
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            'https://table.test',
          );
          assert.equal(url.origin, 'https://table.test');
          if (url.pathname === '/api/admin') {
            const body = JSON.parse(String(init?.body));
            if (measureNoop && body.action === 'get' && body.data?.collection === 'products') {
              readActive++;
              readPeak = Math.max(readPeak, readActive);
              await new Promise((resolve) => setTimeout(resolve, 10));
              readActive--;
            }
            if (
              body.action === 'update' ||
              (body.action === 'catalogDetailApproval' &&
                !String(body.data?.action).startsWith('product-operation-'))
            )
              legacy.push(body.action);
            if (body.data?.action === 'product-operation-start') {
              starts.push(structuredClone(body.data));
              if (fault === 'mutated-input' && !mutated) {
                mutated = true;
                ids.push('foreign-product');
                values.archived = true;
                revisions.set(selected[1] ?? '', '2030-01-01T00:00:00.000Z');
                if (opened[1]) opened[1].updatedAt = '2030-01-01T00:00:00.000Z';
              }
              if (fault === 'before-start' && !dropped.has(body.data.productId)) {
                dropped.add(body.data.productId);
                throw Error('original start did not reach server');
              }
            }
            const result = await handleAdminRequest(body, config);
            if (
              result.ok &&
              body.data?.action === 'product-operation-continue' &&
              Reflect.get(result.data as object, 'state') === 'complete' &&
              fault === 'completion' &&
              !dropped.has(body.data.productId)
            ) {
              dropped.add(body.data.productId);
              throw Error('original completion reply lost');
            }
            if (
              block &&
              fault === 'wrong-status' &&
              result.ok &&
              body.data?.action === 'product-operation-get' &&
              Reflect.get(result.data as object, 'state') === 'complete'
            )
              return Response.json({
                ...result,
                data: { ...(result.data as object), productId: 'unrelated-product' },
              });
            return Response.json(result);
          }
          assert.equal(init?.method, 'GET');
          assert.equal(init.credentials, 'omit');
          if (block && ['public-read', 'mutated-retry'].includes(fault))
            throw Error('public read unavailable');
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
      );
      if (fault === 'revoked') await h.adapter.update('users', 'admin', { status: 'suspended' });
      try {
        const pending = batchUpdateRecords('products', ids, values, revisions, opened);
        if (fault === 'mutated-before-import')
          queueMicrotask(() => {
            ids.push('foreign-product');
            values.archived = true;
            revisions.set(selected[1] ?? '', '2030-01-01T00:00:00.000Z');
            if (opened[1]) opened[1].updatedAt = '2030-01-01T00:00:00.000Z';
          });
        let result = await pending;
        if (
          ['public-read', 'wrong-status', 'before-start', 'revoked', 'mutated-retry'].includes(
            fault,
          )
        ) {
          assert.equal(result.updated, 0);
          assert.equal(result.failures.length, 20);
          assert.ok(result.publication);
          assert.equal(result.publication.checkpoints.length, 20);
          const originalIds = new Map(
            result.publication.checkpoints.map((entry) => [
              entry.scope.productId,
              entry.scope.operationId,
            ]),
          );
          if (fault === 'revoked') {
            assert.equal(starts.length, 0);
            await h.adapter.update('users', 'admin', { status: 'active' });
          }
          block = false;
          const retry = retryBatchUpdate(result, selected, { published: true }, revisions);
          if (fault === 'mutated-retry')
            queueMicrotask(() => {
              result.publication?.checkpoints.splice(0);
              selected.push('foreign-product');
            });
          result = await retry;
          if (fault === 'mutated-retry') selected.pop();
          assert.equal(
            starts.every((command) => originalIds.get(command.productId) === command.operationId),
            true,
          );
        }
        assert.equal(result.updated, 20, JSON.stringify(result.failures));
        assert.deepEqual(result.failures, []);
        assert.equal(new Set(starts.map((command) => command.productId)).size, 20);
        assert.equal(new Set(starts.map((command) => command.operationId)).size, 20);
        assert.equal(starts.length, fault === 'before-start' ? 40 : 20);
        assert.equal(
          starts.some((command) => command.productId === 'foreign-product'),
          false,
        );
        assert.deepEqual(legacy, []);
        for (const command of starts) {
          assert.deepEqual(command.values, {});
          assert.equal(command.intent, 'publish');
        }
        if (fault === 'already-live') {
          const current = await Promise.all(
            selected.map(async (id) => {
              const row = await h.adapter.get('products', id);
              assert.ok(row);
              return row;
            }),
          );
          measureNoop = true;
          const noChange = await batchUpdateRecords(
            'products',
            selected,
            { published: true },
            new Map(current.map((row) => [row._id, row.updatedAt ?? null])),
            current,
          );
          assert.equal(
            noChange.updated,
            0,
            'already live rows do not become receipts for this new selection',
          );
          assert.equal(noChange.unchanged?.length, 20);
          assert.equal(
            readPeak,
            4,
            'no-op checks share four reads instead of serial gateway waits',
          );
          measureNoop = false;
          assert.deepEqual(noChange.failures, []);
          assert.equal(starts.length, 20);
        }
        for (const id of selected) {
          const row = await h.adapter.get('products', id);
          assert.equal(row?.published, true);
          assert.equal(row?.productFamily, 'misc');
          assert.deepEqual(row?.imageIds, ['image']);
          assert.equal(row?.unitPrice, 5.7);
          assert.equal(row?.name, `Owned table product ${id}`);
          assert.ok(
            row?.catalogDetailApprovalReceipt &&
              typeof row.catalogDetailApprovalReceipt === 'object',
          );
          assert.equal(
            starts.some(
              (command) =>
                command.productId === id &&
                command.operationId ===
                  Reflect.get(row.catalogDetailApprovalReceipt as object, 'operationId'),
            ),
            true,
          );
        }
      } finally {
        await h.adapter.update('users', 'admin', { status: 'active' });
        for (const id of selected) {
          const row = await h.adapter.get('products', id);
          assert.ok(row);
          if (row.published === true) {
            const response = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id,
                  values: { published: false },
                  expectedUpdatedAt: row.updatedAt,
                },
              },
              config,
            );
            assert.ok(response.ok, JSON.stringify(response));
          }
          assert.equal(
            (
              await handlePublicApiEvent(
                { httpMethod: 'GET', path: `/api/products/${id}/detail` },
                { enableCatalogDetail: true },
              )
            ).statusCode,
            404,
          );
        }
      }
    },
  );
