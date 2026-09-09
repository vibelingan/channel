import assert from 'node:assert/strict';
import test from 'node:test';
import { detailFixture } from '../testing/detail-fixture.ts';
import { fetchCatalogDetailPage } from './catalog-detail-api.ts';

const request = { productId: 'canonical-product' };
const responseFor = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));

test('structured v2 is supported but invalid or private nested fields never downgrade to v1', async () => {
  const content = {
    schemaVersion: 'catalog-content-v1',
    specifications: [{ name: 'Material', value: 'ABS' }],
    packaging: [],
    notes: [],
  };
  const data = { ...detailFixture(), schemaVersion: 'catalog-product-detail-v2', content };
  assert.equal(
    (await fetchCatalogDetailPage(request, { fetch: async () => responseFor(data) })).status,
    'ready',
  );
  for (const invalid of [
    null,
    { ...content, rawHtml: 'private' },
    { ...content, notes: [null] },
    { ...content, specifications: [{ name: '', value: 'ABS' }] },
  ]) {
    assert.equal(
      (
        await fetchCatalogDetailPage(request, {
          fetch: async () => responseFor({ ...data, content: invalid }),
        })
      ).status,
      'invalid-response',
    );
  }
});

test('reads a validated detail through the explicit route without entitlement tokens', async () => {
  const abort = new AbortController();
  const result = await fetchCatalogDetailPage(request, {
    signal: abort.signal,
    fetch: async (url, init) => {
      assert.equal(url, '/api/products/canonical-product/detail?page=1&pageSize=50&view=sections');
      assert.equal(init?.signal, abort.signal);
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.cache, 'no-store');
      return responseFor(detailFixture());
    },
  });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.detail.variants.items[2]?.id, 'variant-3');
  assert.equal(result.detail.revision, 'approved-r1');
  assert.ok(result.bytes > 0);
});

test('encodes the product identity and carries revision on later pages', async () => {
  const data = { ...detailFixture(51, 2), _id: 'id/with ?#', revision: 'r&2' };
  const result = await fetchCatalogDetailPage(
    { productId: data._id, page: 2, revision: 'r&2' },
    {
      fetch: async (url) => {
        assert.equal(
          url,
          '/api/products/id%2Fwith%20%3F%23/detail?page=2&pageSize=50&view=sections&revision=r%262',
        );
        return responseFor(data);
      },
    },
  );
  assert.equal(result.status, 'ready');
});

test('rejects empty null malformed envelopes and private or malformed detail fields', async () => {
  for (const body of [
    '',
    'null',
    'undefined',
    '<html>error</html>',
    '[]',
    '{}',
    '{"ok":true}',
    '{"ok":false,"error":null}',
    JSON.stringify({ ok: true, data: null }),
    JSON.stringify({ ok: true, data: { ...detailFixture(), accountKey: 'private' } }),
    JSON.stringify({ ok: true, data: { ...detailFixture(), images: ['https://supplier.test/x'] } }),
  ]) {
    const result = await fetchCatalogDetailPage(request, { fetch: async () => new Response(body) });
    assert.deepEqual(result, { status: 'invalid-response' });
  }
});

test('rejects mismatched identity page size page number and missing revision', async () => {
  for (const data of [
    { ...detailFixture(), _id: 'foreign' },
    { ...detailFixture(), revision: undefined },
    detailFixture(3, 2),
    detailFixture(3, 1, 3),
  ]) {
    assert.deepEqual(
      await fetchCatalogDetailPage(request, { fetch: async () => responseFor(data) }),
      { status: 'invalid-response' },
    );
  }
  assert.deepEqual(
    await fetchCatalogDetailPage(
      { ...request, revision: 'r2' },
      {
        fetch: async () => responseFor(detailFixture()),
      },
    ),
    { status: 'refresh-required' },
  );
});

test('keeps HTTP failure outcomes distinct without reading private error bodies', async () => {
  for (const [status, expected] of [
    [404, 'not-found'],
    [409, 'refresh-required'],
    [401, 'forbidden'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [400, 'invalid-request'],
  ] as const) {
    assert.deepEqual(
      await fetchCatalogDetailPage(request, {
        fetch: async () => new Response('private server error', { status }),
      }),
      { status: expected },
    );
  }
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      fetch: async () =>
        new Response(
          JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: 'private' } }),
        ),
    }),
    { status: 'refresh-required' },
  );
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      fetch: async () => {
        throw new TypeError('private network details');
      },
    }),
    { status: 'network-error' },
  );
});

test('rejects invalid requests before fetching, including unpinned later pages', async () => {
  for (const input of [
    { productId: '' },
    { productId: '..' },
    { productId: 'bad\ud800' },
    { ...request, page: 0 },
    { ...request, page: 2 },
    { ...request, pageSize: 51 },
    { ...request, page: Number.MAX_SAFE_INTEGER, revision: 'r1' },
  ]) {
    let calls = 0;
    const result = await fetchCatalogDetailPage(input, {
      fetch: async () => {
        calls++;
        return responseFor(detailFixture());
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { status: 'invalid-request' });
  }
});

test('abort before fetch or during streamed body returns cancelled without retaining data', async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      signal: before.signal,
      fetch: async () => {
        calls++;
        return responseFor(detailFixture());
      },
    }),
    { status: 'cancelled' },
  );
  assert.equal(calls, 0);
  const during = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = fetchCatalogDetailPage(request, {
    signal: during.signal,
    fetch: async () => new Response(stream),
  });
  setTimeout(() => during.abort(), 5);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(cancelled, true);
});

test('counts streamed bytes rather than trusting absent or understated content-length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      fetch: async () => new Response(stream, { headers: { 'content-length': '1' } }),
    }),
    { status: 'limit-exceeded' },
  );
  assert.equal(cancelled, true);
});

test('rejects invalid UTF-8 and classifies interrupted body reads as network errors', async () => {
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      fetch: async () => new Response(new Uint8Array([0xff])),
    }),
    { status: 'invalid-response' },
  );
  assert.deepEqual(
    await fetchCatalogDetailPage(request, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('disconnected'));
            },
          }),
        ),
    }),
    { status: 'network-error' },
  );
});

test('accepts chunk-split UTF-8 and an exact-limit valid body while rejecting one extra byte', async () => {
  const payload = JSON.stringify({ ok: true, data: { ...detailFixture(), name: '耳机' } });
  const bytes = new TextEncoder().encode(payload);
  const split = bytes.findIndex((byte) => byte > 127) + 1;
  const result = await fetchCatalogDetailPage(request, {
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
          },
        }),
      ),
  });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.detail.name, '耳机');
  assert.equal(result.bytes, bytes.length);
  const limitBody = payload + ' '.repeat(2 * 1024 * 1024 - bytes.length);
  assert.equal(
    (await fetchCatalogDetailPage(request, { fetch: async () => new Response(limitBody) })).status,
    'ready',
  );
  assert.deepEqual(
    await fetchCatalogDetailPage(request, { fetch: async () => new Response(`${limitBody} `) }),
    { status: 'limit-exceeded' },
  );
});
