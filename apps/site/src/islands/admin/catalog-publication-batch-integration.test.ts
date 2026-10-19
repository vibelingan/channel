import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { CatalogProductOperationStatusSchema } from '@vibelingan-channel/shared/catalog-product-operation';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { createPublicationAttempt } from './catalog-product-operation-api.ts';
import { createPublicationBatch } from './catalog-publication-batch.ts';

for (const [count, unclassified] of [
  [20, false],
  [100, false],
  [3, true],
] as const)
  test(
    `default batch transport publishes and reads ${count} actual mixed-category drafts sharing PNG, missing-classification=${unclassified}, then restores them`,
    { timeout: 180000 },
    async (t) => {
      const h = await workspace(t);
      const original = await h.adapter.get('products', h.productId);
      assert.ok(original);
      const media = await coldOwnedMedia(h);
      const warm = await h.start('publish', {});
      const warmed = await h.invokeWithConfig(
        { ...warm, action: 'product-operation-continue' },
        media.config,
      );
      assert.ok(warmed.ok, JSON.stringify(warmed));
      assert.ok((await h.invoke({ ...warm, action: 'product-operation-cancel' })).ok);
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
      const manifest = Array.from({ length: count }, (_, index) => {
        const product = {
          ...original,
          _id: `default-batch-${count}-${index}`,
          name: `Actual batch clock ${index}`,
          ...(index % 2
            ? {
                productFamily: 'headphones',
                category: 'wired',
                subcategoryIds: ['headphones-wired'],
              }
            : {}),
        };
        if (unclassified && index === count - 1)
          for (const field of ['productFamily', 'category', 'subcategoryIds'])
            Reflect.deleteProperty(product, field);
        const attempt = createPublicationAttempt({
          productId: product._id,
          expectedUpdatedAt: typeof product.updatedAt === 'string' ? product.updatedAt : null,
          values: {},
        });
        return { product, attempt };
      });
      const rows = JSON.parse(h.bytes());
      rows.products.push(...manifest.map((item) => item.product));
      writeFileSync(h.file, JSON.stringify(rows));
      const store = new Map<string, string>([
        ['channel.token', token],
        [
          'channel.user',
          JSON.stringify({
            id: 'admin',
            role: 'admin',
            username: 'Admin',
            email: 'admin@example.test',
          }),
        ],
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
        ['location', new URL('https://batch.test/admin')],
      ] as const) {
        const before = Object.getOwnPropertyDescriptor(globalThis, name);
        Object.defineProperty(globalThis, name, { configurable: true, value });
        t.after(() => {
          if (before) Object.defineProperty(globalThis, name, before);
          else Reflect.deleteProperty(globalThis, name);
        });
      }
      const starts = new Map<string, number>();
      let active = 0;
      let maximum = 0;
      let privateRequests = 0;
      let publicRequests = 0;
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            'https://batch.test',
          );
          assert.equal(url.origin, 'https://batch.test');
          active++;
          maximum = Math.max(maximum, active);
          try {
            if (init?.method === 'POST') {
              assert.equal(url.pathname, '/api/admin');
              privateRequests++;
              const request = JSON.parse(String(init.body));
              if (
                request.action === 'catalogDetailApproval' &&
                request.data?.action === 'product-operation-start'
              )
                starts.set(
                  request.data.operationId,
                  (starts.get(request.data.operationId) ?? 0) + 1,
                );
              const response = await handleAdminRequest(request, config);
              return Response.json(response, {
                status: response.ok
                  ? 200
                  : response.error.code === 'UNAUTHORIZED'
                    ? 401
                    : response.error.code === 'FORBIDDEN'
                      ? 403
                      : 400,
              });
            }
            assert.equal(init?.method, 'GET');
            assert.equal(init.credentials, 'omit');
            assert.equal(init.redirect, 'error');
            publicRequests++;
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
          } finally {
            active--;
          }
        },
      );
      const controller = createPublicationBatch();
      try {
        const result = await controller.run(
          manifest.map((item) => item.attempt),
          t.signal,
        );
        assert.equal(
          result.confirmed,
          count - Number(unclassified),
          JSON.stringify(result.items.filter((item) => item.state !== 'confirmed')),
        );
        assert.equal(result.items.length, count);
        assert.equal(starts.size, count);
        for (const item of manifest) assert.equal(starts.get(item.attempt.operationId), 1);
        assert.equal(result.paused, false);
        assert.ok(maximum <= 4);
        assert.equal(active, 0);
        assert.equal(publicRequests, count - Number(unclassified));
        assert.ok(privateRequests > count * 3);
        assert.equal(controller.journal.read().entries.length, Number(unclassified));
        for (const item of manifest) {
          const published = await h.adapter.get('products', item.product._id);
          assert.ok(published);
          if (unclassified && item === manifest.at(-1)) {
            assert.equal(published.published, false);
            assert.equal(Object.hasOwn(published, 'productFamily'), false);
            const outcome = result.items.find(
              (value) => value.scope.productId === item.product._id,
            );
            assert.equal(outcome?.state, 'needs-action', JSON.stringify(outcome));
            continue;
          }
          assert.equal(published.published, true);
          const response = await handlePublicApiEvent(
            { httpMethod: 'GET', path: `/api/products/${item.product._id}/detail` },
            { enableCatalogDetail: true },
          );
          assert.equal(response.statusCode, 200, response.body);
          const detail = decodeCatalogDetailView(JSON.parse(response.body).data);
          assert.ok(detail.ok);
          assert.equal(detail.value.name, item.product.name);
        }
        const effective = await h.adapter.readCatalogImageReference({
          action: 'read',
          imageId: 'image',
        });
        assert.ok(effective.state === 'counted');
        assert.equal(effective.effectiveCount, count - Number(unclassified));
        assert.equal(
          (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {}))
            .statusCode,
          200,
        );
      } finally {
        assert.equal(active, 0, 'All active publication RPCs must settle before restoration');
        for (const item of manifest) {
          const product = await h.adapter.get('products', item.product._id);
          assert.ok(product);
          if (product.published === true) {
            assert.ok(
              product.catalogDetailApprovalReceipt &&
                typeof product.catalogDetailApprovalReceipt === 'object',
            );
            assert.equal(
              Reflect.get(product.catalogDetailApprovalReceipt, 'operationId'),
              item.attempt.operationId,
            );
            const response = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id: product._id,
                  values: { published: false },
                  expectedUpdatedAt: product.updatedAt,
                },
              },
              config,
            );
            assert.ok(response.ok, JSON.stringify(response));
          } else {
            const read = await handleAdminRequest(
              {
                action: 'catalogDetailApproval',
                token,
                data: {
                  action: 'product-operation-get',
                  productId: item.product._id,
                  operationId: item.attempt.operationId,
                },
              },
              config,
            );
            if (read.ok) {
              const state = CatalogProductOperationStatusSchema.parse(read.data);
              if (state.state !== 'complete' && !state.cancelledAt) {
                const cancelled = await handleAdminRequest(
                  {
                    action: 'catalogDetailApproval',
                    token,
                    data: {
                      action: 'product-operation-cancel',
                      productId: state.productId,
                      operationId: state.operationId,
                      inputDigest: state.inputDigest,
                    },
                  },
                  config,
                );
                assert.ok(cancelled.ok, JSON.stringify(cancelled));
              }
            } else assert.equal(read.error.code, 'NOT_FOUND', JSON.stringify(read));
          }
          const restored = await h.adapter.get('products', item.product._id);
          assert.ok(restored);
          assert.equal(restored.published, false);
          for (const field of ['productFamily', 'category', 'subcategoryIds'] as const) {
            assert.equal(Object.hasOwn(restored, field), Object.hasOwn(item.product, field));
            assert.deepEqual(restored[field], item.product[field]);
          }
          assert.equal(
            (
              await handlePublicApiEvent(
                { httpMethod: 'GET', path: `/api/products/${item.product._id}/detail` },
                { enableCatalogDetail: true },
              )
            ).statusCode,
            404,
          );
        }
        const effective = await h.adapter.readCatalogImageReference({
          action: 'read',
          imageId: 'image',
        });
        assert.ok(effective.state === 'counted');
        assert.equal(effective.effectiveCount, 0);
        assert.equal(
          (await handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, {}))
            .statusCode,
          404,
        );
      }
      if (!unclassified) {
        const before = h.bytes();
        const publicBefore = publicRequests;
        const historical = await controller.run(
          manifest.map((item) => ({
            scope: { productId: item.product._id, operationId: item.attempt.operationId },
          })),
          t.signal,
        );
        assert.equal(historical.confirmed, 0);
        assert.ok(
          historical.items.every((item) => item.state === 'historical'),
          JSON.stringify(historical.items.filter((item) => item.state !== 'historical')),
        );
        assert.equal(publicRequests, publicBefore);
        assert.equal(starts.size, count);
        for (const item of manifest) assert.equal(starts.get(item.attempt.operationId), 1);
        assert.equal(h.bytes(), before, 'Historical batch recovery must not write or republish');
      }
    },
  );
