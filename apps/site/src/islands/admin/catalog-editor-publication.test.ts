import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../../../functions/public-api/src/http-adapter.ts';
import {
  coldOwnedMedia,
  workspace,
} from '../../../../local-server/src/testing/catalog-operation-workspace.ts';
import { AdminApiError } from './api.ts';
import {
  ProductPublicationError,
  publishProductFromEditor,
  recoverProductPublication,
} from './catalog-product-publication.ts';

async function fixture(t: TestContext, mode: string) {
  const h = await workspace(t, undefined, true);
  const media = await coldOwnedMedia(h);
  if (mode === 'no-category') {
    const rows = JSON.parse(h.bytes());
    Reflect.deleteProperty(rows.products[0], 'productFamily');
    writeFileSync(h.file, JSON.stringify(rows));
  }
  const token = await signSession('owned-continue-test-only', {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const entries = new Map<string, string>([
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
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  for (const [key, value] of [
    ['localStorage', storage],
    ['location', new URL('https://edited.test/admin')],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const config = {
    jwtSecret: 'owned-continue-test-only',
    enableDetailApproval: true,
    ...media.config,
  };
  const calls: { action: string; data?: Record<string, unknown> }[] = [];
  let dropped = false;
  let publicBlocked = mode === 'public';
  let publicRead = false;
  let entered = () => {};
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        'https://edited.test',
      );
      assert.equal(url.origin, 'https://edited.test');
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        if (mode === 'late-private' && publicRead && body.action === 'get' && !dropped) {
          dropped = true;
          assert.equal(
            [...entries.keys()].filter((key) => key.startsWith('channel:publication:')).length,
            0,
          );
          throw Error('Owned final private read unavailable');
        }
        if (mode === 'held-input' && body.action === 'catalogDetailCapabilities') {
          entered();
          await held;
        }
        if (mode === 'start-missing' && body.data?.action === 'product-operation-start')
          throw Error('Original edited start never arrived');
        const result = await handleAdminRequest(body, config);
        if (
          mode === 'auth-after-start' &&
          !dropped &&
          result.ok &&
          body.data?.action === 'product-operation-start'
        ) {
          dropped = true;
          entries.set('channel.token', 'changed-after-original-start');
        }
        if (
          !dropped &&
          result.ok &&
          ((mode === 'lost-start' && body.data?.action === 'product-operation-start') ||
            (mode === 'lost-completion' &&
              body.data?.action === 'product-operation-continue' &&
              result.data &&
              typeof result.data === 'object' &&
              Reflect.get(result.data, 'state') === 'complete'))
        ) {
          dropped = true;
          throw Error('Original edited operation committed but response lost');
        }
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      assert.equal(init?.method, 'GET');
      publicRead = true;
      assert.equal(init.credentials, 'omit');
      if (publicBlocked) throw Error('Owned public read unavailable');
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
  const opened = await h.adapter.get('products', h.productId);
  assert.ok(opened);
  return {
    ...h,
    calls,
    entries,
    opened,
    config,
    token,
    waiting,
    release,
    unblock: () => {
      publicBlocked = false;
    },
  };
}

for (const mode of [
  'normal',
  'valid-long-name',
  'held-input',
  'lost-start',
  'lost-completion',
  'auth-after-start',
  'public',
  'late-private',
  'no-category',
  'invalid-name',
  'invalid-photo',
  'start-missing',
])
  test(
    `full editor publication keeps one immutable native task: ${mode}`,
    { timeout: 90000 },
    async (t) => {
      const h = await fixture(t, mode);
      const before = h.bytes();
      const original = structuredClone(h.opened);
      const values = {
        name:
          mode === 'invalid-name'
            ? 'x'.repeat(1001)
            : mode === 'valid-long-name'
              ? 'x'.repeat(201)
              : 'Private edited clock',
        description: 'Private edited description',
        imageIds: mode === 'invalid-photo' ? ['missing-owned-photo'] : ['image'],
        published: true,
        archived: false,
      };
      const expectedName = values.name;
      const pending = publishProductFromEditor(h.opened, values).catch((error: unknown) => error);
      if (mode === 'held-input') {
        await h.waiting;
        assert.equal(h.bytes(), before);
        h.opened._id = 'changed-by-caller';
        values.name = 'Later form edits';
        values.imageIds.push('unselected-later-photo');
        h.release();
      }
      try {
        const result = await pending;
        if (mode === 'no-category') {
          assert.ok(result instanceof AdminApiError && result.code === 'INVALID_PRODUCT');
          assert.equal(h.calls.length, 0);
          assert.equal(h.bytes(), before);
          assert.equal((await h.adapter.get('products', h.productId))?.productFamily, undefined);
          return;
        }
        if (['invalid-name', 'invalid-photo', 'start-missing'].includes(mode)) {
          assert.ok(result instanceof ProductPublicationError);
          assert.equal(result.draftSaved, false);
          assert.doesNotMatch(result.message, /Product saved\./);
          assert.deepEqual(await h.adapter.get('products', h.productId), original);
          if (mode !== 'start-missing') assert.ok(result.issues.length > 0);
          if (mode === 'invalid-name') {
            assert.equal(result.checkpoint, undefined);
          } else {
            assert.ok(result.owner && result.checkpoint);
            const pointers = [...h.entries].filter(([key]) =>
              key.startsWith('channel:publication:'),
            );
            assert.equal(pointers.length, 1);
            assert.doesNotMatch(JSON.stringify(pointers), /Private edited/);
            assert.equal(
              result.checkpoint.originalStart,
              undefined,
              'Private edits must never replay as an empty patch',
            );
            const stopped = await recoverProductPublication(
              original,
              result.owner,
              result.checkpoint,
              'cancel',
            );
            assert.equal(stopped.item.state, 'cancelled');
            assert.equal(stopped.item.check?.status?.state, 'reserved');
            assert.deepEqual(await h.adapter.get('products', h.productId), original);
          }
          return;
        }
        if (mode === 'auth-after-start') {
          assert.ok(result instanceof ProductPublicationError);
          assert.equal(result.draftSaved, false);
          assert.ok(
            result.owner && result.checkpoint,
            'An admitted original task must remain recoverable when the session changes',
          );
          assert.doesNotMatch(result.message, /Product saved\.|did not start/);
          assert.deepEqual(await h.adapter.get('products', h.productId), original);
          h.entries.set('channel.token', h.token);
          const recovered = await recoverProductPublication(
            original,
            result.owner,
            result.checkpoint,
            'continue',
          );
          assert.equal(recovered.item.state, 'confirmed');
        } else if (mode === 'public' || mode === 'late-private') {
          assert.ok(result instanceof ProductPublicationError && result.draftSaved);
          assert.ok(result.owner && result.checkpoint);
          const pointers = [...h.entries].filter(([key]) => key.startsWith('channel:publication:'));
          assert.equal(pointers.length, 1);
          assert.doesNotMatch(JSON.stringify(pointers), /Private edited/);
          assert.equal(result.checkpoint.originalStart, undefined);
          const savedAt = (await h.adapter.get('products', h.productId))?.updatedAt;
          h.unblock();
          const recovered = await recoverProductPublication(
            original,
            result.owner,
            result.checkpoint,
            'check',
          );
          assert.equal(recovered.item.state, 'confirmed');
          assert.equal(recovered.product?.updatedAt, savedAt);
        } else {
          assert.ok(result && typeof result === 'object' && !(result instanceof Error));
          assert.equal(Reflect.get(result, '_id'), h.productId);
        }
        const saved = await h.adapter.get('products', h.productId);
        assert.ok(saved);
        assert.equal(saved.name, expectedName);
        assert.equal(saved.description, 'Private edited description');
        assert.deepEqual(saved.imageIds, ['image']);
        assert.equal(saved.published, true);
        const receipt = z
          .object({ operationId: z.string().uuid() })
          .parse(saved.catalogDetailApprovalReceipt);
        const roots = JSON.parse(h.bytes()).catalogDetailApprovals.filter(
          (root: { operationId?: string }) => root.operationId === receipt.operationId,
        );
        assert.equal(roots.length, 1);
        assert.equal(roots[0].operation.values.name, expectedName);
        assert.equal(Object.hasOwn(roots[0].operation.values, 'published'), false);
        assert.equal(Object.hasOwn(roots[0].operation.values, 'archived'), false);
        const publicResult = await handlePublicApiEvent(
          { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
          { enableCatalogDetail: true },
        );
        assert.equal(publicResult.statusCode, 200);
        const detail = decodeCatalogDetailView(JSON.parse(publicResult.body).data);
        assert.ok(detail.ok);
        assert.equal(detail.value.name, expectedName);
      } finally {
        h.unblock();
        assert.equal(h.calls.filter((call) => call.action === 'update').length, 0);
        assert.equal(
          h.calls.filter((call) => call.data?.action === 'product-operation-start').length,
          mode === 'no-category' ? 0 : 1,
        );
        assert.doesNotMatch(
          JSON.stringify([...h.entries].filter(([key]) => key.startsWith('channel:publication:'))),
          /Private edited|Private edited description/,
        );
        const product = await h.adapter.get('products', h.productId);
        if (product?.published) {
          assert.ok(
            (
              await handleAdminRequest(
                {
                  action: 'update',
                  token: h.token,
                  data: {
                    collection: 'products',
                    id: h.productId,
                    values: { published: false },
                    expectedUpdatedAt: product.updatedAt,
                  },
                },
                h.config,
              )
            ).ok,
          );
        }
        assert.equal(
          (
            await handlePublicApiEvent(
              { httpMethod: 'GET', path: `/api/products/${h.productId}/detail` },
              { enableCatalogDetail: true },
            )
          ).statusCode,
          404,
        );
        const reference = await h.adapter.readCatalogImageReference({
          action: 'read',
          imageId: 'image',
        });
        assert.ok(reference.state === 'counted' && reference.effectiveCount === 0);
      }
    },
  );
