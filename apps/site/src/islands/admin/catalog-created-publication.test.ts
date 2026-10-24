import assert from 'node:assert/strict';
import test from 'node:test';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { createRecord } from './api.ts';
import { createProductCreationController } from './catalog-product-creation.ts';
import {
  ProductPublicationError,
  recoverProductPublication,
} from './catalog-product-publication.ts';

for (const fault of [
  'none',
  'completion',
  'public',
  'stale-private-read',
  'before-start',
  'before-start-changed',
  'disabled',
  'no-uuid',
  'rejected-start',
  'before-start-changed-check-fails',
  'photos-only',
  'quote',
] as const)
  test(
    `new product publication uses one owned native task and anonymous readback, fault=${fault}`,
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
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      };
      for (const [name, value] of [
        ['localStorage', storage],
        ['location', new URL('https://created.test/admin')],
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
        enableDetailApproval: fault !== 'disabled',
        ...media.config,
      };
      const starts: { productId: string; operationId: string }[] = [];
      const legacy: string[] = [];
      let rejectedRead = false;
      let changedPrivateReply = false;
      const created: string[] = [];
      let publicReads = 0;
      let dropped = false;
      let publicBlocked = fault === 'public';
      const control = createProductCreationController();
      t.mock.method(
        globalThis,
        'fetch',
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            'https://created.test',
          );
          assert.equal(url.origin, 'https://created.test');
          if (url.pathname === '/api/admin') {
            const body = JSON.parse(String(init?.body));
            if (
              body.action === 'update' ||
              (body.action === 'catalogDetailApproval' &&
                !String(body.data.action).startsWith('product-operation-'))
            )
              legacy.push(body.action);
            if (body.data?.action === 'product-operation-start') {
              starts.push(body.data);
              if (fault.startsWith('before-start') && !dropped) {
                dropped = true;
                throw Error('start never reached handler');
              }
            }
            if (
              fault === 'before-start-changed-check-fails' &&
              !rejectedRead &&
              starts.length === 2 &&
              body.data?.action === 'product-operation-get'
            ) {
              rejectedRead = true;
              throw Error('final absence check unavailable');
            }
            const result = await handleAdminRequest(body, config);
            if (
              fault === 'rejected-start' &&
              result.ok &&
              body.action === 'catalogProductCreate' &&
              body.data.action === 'start'
            )
              await h.adapter.update(
                'products',
                String(Reflect.get(result.data as object, 'productId')),
                { name: 'Changed before admission' },
              );
            if (
              result.ok &&
              body.action === 'catalogProductCreate' &&
              body.data.action === 'start' &&
              fault === 'no-uuid'
            )
              t.mock.method(globalThis.crypto, 'randomUUID', () => {
                throw Error('browser nonce unavailable');
              });
            if (result.ok && body.action === 'catalogProductCreate' && body.data.action === 'start')
              created.push(String(Reflect.get(result.data as object, 'productId')));
            if (
              fault === 'completion' &&
              !dropped &&
              result.ok &&
              body.data?.action === 'product-operation-continue' &&
              Reflect.get(result.data as object, 'state') === 'complete'
            ) {
              dropped = true;
              throw Error('committed native completion reply lost');
            }
            if (
              fault === 'stale-private-read' &&
              !changedPrivateReply &&
              result.ok &&
              body.action === 'get' &&
              body.data?.collection === 'products'
            ) {
              changedPrivateReply = true;
              assert.ok(result.data && typeof result.data === 'object');
              const receipt = Reflect.get(result.data, 'catalogDetailApprovalReceipt');
              assert.ok(receipt && typeof receipt === 'object');
              return Response.json({
                ...result,
                data: {
                  ...result.data,
                  catalogDetailApprovalReceipt: {
                    ...receipt,
                    operationId: '00000000-0000-4000-8000-000000000099',
                  },
                },
              });
            }
            return Response.json(result);
          }
          assert.equal(init?.method, 'GET');
          assert.equal(init.credentials, 'omit');
          publicReads++;
          if (publicBlocked) throw Error('anonymous public network unavailable');
          const result = await handlePublicApiEvent(
            {
              httpMethod: 'GET',
              path: url.pathname,
              queryStringParameters: Object.fromEntries(url.searchParams),
            },
            { enableCatalogDetail: true },
          );
          return new Response(result.body, { status: result.statusCode, headers: result.headers });
        },
      );
      try {
        const values = {
          name: 'Created native publication',
          productFamily: 'misc',
          imageIds: ['image'],
          ...(fault === 'photos-only'
            ? { descriptionImageIds: ['image'] }
            : { description: 'New manual product' }),
          ...(fault === 'quote' ? {} : { unitPrice: 5.7 }),
          moq: 1,
          published: true,
        };
        const outcome = await control.save(values).catch((error: unknown) => error);
        if (fault.startsWith('before-start-changed')) {
          assert.ok(outcome instanceof ProductPublicationError);
          await h.adapter.update('products', outcome.product._id, {
            name: 'Concurrent preserved edit',
          });
        }
        if (
          fault === 'public' ||
          fault === 'stale-private-read' ||
          fault.startsWith('before-start') ||
          fault === 'disabled' ||
          fault === 'no-uuid' ||
          fault === 'rejected-start'
        ) {
          assert.ok(outcome instanceof ProductPublicationError);
          if (
            fault === 'public' ||
            fault === 'stale-private-read' ||
            fault.startsWith('before-start')
          )
            assert.ok(outcome.owner && outcome.checkpoint);
          else {
            assert.equal(outcome.owner, undefined, JSON.stringify(outcome.item));
            assert.equal(outcome.checkpoint, undefined);
          }
          assert.doesNotMatch(outcome.message, /not published|saved as a draft/i);
          assert.equal(
            control.pending().entries.length,
            1,
            'refresh must retain a route to this saved product',
          );
          const before = await h.adapter.get('products', outcome.product._id);
          assert.equal(before?.published, fault === 'public' || fault === 'stale-private-read');
          if (fault === 'public' || fault.startsWith('before-start'))
            await assert.rejects(
              control.save({ ...values, published: false }),
              ProductPublicationError,
            );
          assert.equal(control.pending().entries.length, 1);
          assert.deepEqual(await h.adapter.get('products', outcome.product._id), before);
          const commandsBefore = starts.length;
          const creationsBefore = created.length;
          const reloaded = createProductCreationController();
          const pointer = reloaded.pending().entries[0];
          assert.ok(pointer);
          const found = await reloaded.check(pointer, { retain: true });
          assert.equal(found._id, outcome.product._id);
          assert.equal(reloaded.pending().entries.length, 1);
          assert.equal(created.length, creationsBefore);
          publicBlocked = false;
          if (
            fault === 'public' ||
            fault === 'stale-private-read' ||
            fault.startsWith('before-start')
          ) {
            assert.ok(outcome.owner && outcome.checkpoint);
            let recovered = await recoverProductPublication(
              found,
              outcome.owner,
              outcome.checkpoint,
              fault === 'public' || fault === 'stale-private-read'
                ? 'check'
                : fault.startsWith('before-start-changed')
                  ? 'cancel'
                  : 'continue',
            );
            if (fault === 'before-start-changed-check-fails') {
              assert.equal(
                recovered.product,
                undefined,
                'an unavailable root read is not proof of absence',
              );
              assert.equal(recovered.stoppedBeforeStart, false);
              recovered = await recoverProductPublication(
                found,
                outcome.owner,
                outcome.checkpoint,
                'cancel',
              );
            }
            if (fault.startsWith('before-start-changed')) {
              assert.equal(recovered.product?.name, 'Concurrent preserved edit');
              assert.equal(recovered.product?.published, false);
              assert.equal(recovered.stoppedBeforeStart, true);
              assert.equal(recovered.item.state, 'not-started');
            } else {
              assert.equal(recovered.item.state, 'confirmed');
              assert.equal(recovered.product?.published, true);
            }
            assert.equal(
              starts.length,
              fault === 'public' || fault === 'stale-private-read'
                ? commandsBefore
                : commandsBefore + (fault === 'before-start-changed-check-fails' ? 2 : 1),
            );
            assert.equal(new Set(starts.map((item) => item.operationId)).size, 1);
            assert.equal(
              starts.every((item) => item.productId === found._id),
              true,
            );
            reloaded.acknowledge(pointer);
            assert.equal(reloaded.pending().entries.length, 0);
          } else {
            assert.equal(before?.published, false);
            assert.equal(starts.length, fault === 'rejected-start' ? 1 : 0);
            reloaded.acknowledge(pointer);
            assert.equal(reloaded.pending().entries.length, 0);
          }
        } else {
          assert.ok(
            outcome &&
              typeof outcome === 'object' &&
              !(outcome instanceof Error) &&
              'published' in outcome &&
              'catalogDetailApprovalReceipt' in outcome,
          );
          assert.equal(outcome.published, true);
          assert.equal(starts.length, 1);
          assert.ok(publicReads > 0);
          assert.equal(dropped, fault === 'completion');
          assert.ok(
            outcome.catalogDetailApprovalReceipt &&
              typeof outcome.catalogDetailApprovalReceipt === 'object',
          );
          assert.equal(
            Reflect.get(outcome.catalogDetailApprovalReceipt, 'operationId'),
            starts[0]?.operationId,
          );
          assert.equal(control.pending().entries.length, 0);
        }
        assert.deepEqual(legacy, []);
        assert.equal(new Set(created).size, 1);
      } finally {
        for (const id of new Set(created)) {
          const product = await h.adapter.get('products', id);
          assert.ok(product);
          if (product.published === true) {
            const withdrawn = await handleAdminRequest(
              {
                action: 'update',
                token,
                data: {
                  collection: 'products',
                  id,
                  values: { published: false },
                  expectedUpdatedAt: product.updatedAt,
                },
              },
              config,
            );
            assert.ok(withdrawn.ok, JSON.stringify(withdrawn));
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

test('new Published input without description text or description photos is rejected before creating a draft', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Error('unexpected request');
  });
  await assert.rejects(
    createRecord('products', {
      name: 'Missing description',
      productFamily: 'misc',
      imageIds: ['image'],
      published: true,
    }),
    /Description text or imported description images are required to publish/,
  );
  assert.equal(calls, 0);
});
