import { strict as assert } from 'node:assert';
import test, { afterEach } from 'node:test';
import { createCatalogPage, createProduct } from '../../test/factories/catalog.ts';
import {
  fetchCatalog,
  fetchProductBySlug,
  fetchProductFamily,
  fetchRelatedProducts,
} from './api.ts';
import type { Product } from './catalog-types.ts';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installBrowserMocks(t: test.TestContext, responses: Response[]): FetchCall[] {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const calls: FetchCall[] = [];
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      },
    },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    const response = responses.shift();
    if (!response) throw new Error('unexpected fetch');
    return response;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalLocalStorage)
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return calls;
}

test('family helper encodes exact family, category, search, and pagination query', async (t) => {
  const calls = installBrowserMocks(t, [
    jsonResponse({ items: [], total: 0, page: 2, pageSize: 12 }),
  ]);
  const controller = new AbortController();
  await fetchProductFamily(
    'ai-gadgets',
    { categories: ['smart home'], search: 'camera kit', page: 2, pageSize: 12 },
    controller.signal,
  );
  assert.equal(
    calls[0]?.url,
    '/api/products?productFamily=ai-gadgets&category=smart+home&search=camera+kit&page=2&pageSize=12',
  );
  assert.equal(calls[0]?.init?.signal, controller.signal);
});

test('slug helper encodes the slug as one path segment and resolves only nine images', async (t) => {
  const images = Array.from({ length: 11 }, (_, index) => `/api/images/image-${index + 1}`);
  const calls = installBrowserMocks(t, [
    jsonResponse({
      _id: 'product-1',
      name: 'Desk Lamp',
      productFamily: 'ai-gadgets',
      slug: 'desk-lamp',
      skuCode: 'sku-100',
      images,
    }),
  ]);
  const product = await fetchProductBySlug('Desk Lamp/Pro');
  assert.equal(calls[0]?.url, '/api/products/slug/Desk%20Lamp%2FPro');
  assert.deepEqual(product.images, images.slice(0, 9));
});

test('product decoder accepts canonical manual quantity tiers', async (t) => {
  installBrowserMocks(t, [
    jsonResponse({
      _id: 'product-1',
      name: 'Tiered Toy',
      productFamily: 'toys',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [
          { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
          { minQuantity: 13, unitAmountMinor: 11_831 },
        ],
      },
    }),
  ]);

  const product = await fetchProductBySlug('tiered-toy');
  assert.equal(product.manualCatalogPricing?.tiers[1]?.unitAmountMinor, 11_831);
});

test('catalog token is read for every request', async (t) => {
  const calls = installBrowserMocks(t, [
    jsonResponse({ items: [], total: 0, page: 1, pageSize: 24 }),
    jsonResponse({ items: [], total: 0, page: 1, pageSize: 24 }),
  ]);
  localStorage.setItem('channel.token', 'token-a');
  await fetchProductFamily('toys');
  localStorage.setItem('channel.token', 'token-b');
  await fetchProductFamily('toys');
  assert.deepEqual(
    calls.map((call) => call.init?.headers),
    [{ Authorization: 'Bearer token-a' }, { Authorization: 'Bearer token-b' }],
  );
});

test('related helper fetches the same family and excludes the current product', async (t) => {
  const current: Product = {
    _id: 'current',
    name: 'Current',
    productFamily: 'toys',
    slug: 'current',
    skuCode: 'current',
  };
  const calls = installBrowserMocks(t, [
    jsonResponse({
      items: [
        current,
        { _id: 'other-1', name: 'Other 1', productFamily: 'toys' },
        { _id: 'other-2', name: 'Other 2', productFamily: 'toys' },
      ],
      total: 3,
      page: 1,
      pageSize: 4,
    }),
  ]);
  const related = await fetchRelatedProducts(current, 2);
  assert.deepEqual(
    related.map((product) => product._id),
    ['other-1', 'other-2'],
  );
  assert.equal(calls[0]?.url, '/api/products?productFamily=toys&page=1&pageSize=3');
});

test('related helper skips network work for invalid or non-positive limits', async (t) => {
  const calls = installBrowserMocks(t, []);
  const product: Product = { _id: 'current', name: 'Current', productFamily: 'toys' };
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    assert.deepEqual(await fetchRelatedProducts(product, limit), []);
  }
  assert.deepEqual(await fetchRelatedProducts({ _id: 'no-family', name: 'No family' }, 4), []);
  assert.equal(calls.length, 0);
});

test('related helper truncates fractional limits and caps requests at 48 candidates', async (t) => {
  const calls = installBrowserMocks(t, [
    jsonResponse({ items: [], total: 0, page: 1, pageSize: 3 }),
    jsonResponse({ items: [], total: 0, page: 1, pageSize: 48 }),
  ]);
  const product: Product = { _id: 'current', name: 'Current', productFamily: 'misc' };
  await fetchRelatedProducts(product, 2.9);
  await fetchRelatedProducts(product, 100);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/api/products?productFamily=misc&page=1&pageSize=3',
      '/api/products?productFamily=misc&page=1&pageSize=48',
    ],
  );
});

test('AbortError from fetch propagates unchanged', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException('aborted', 'AbortError');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const controller = new AbortController();
  await assert.rejects(
    fetchProductFamily('misc', {}, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('malformed catalog and product payloads fail at the response boundary', async (t) => {
  installBrowserMocks(t, [
    jsonResponse({ items: [{ _id: 'bad', name: 42 }], total: 1, page: 1, pageSize: 24 }),
    jsonResponse({ _id: 'bad', name: 'Bad', images: [42] }),
    jsonResponse({
      _id: 'bad-pricing',
      name: 'Bad pricing',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'tiered',
        currency: 'USD',
        syncedAt: '2026-01-01T00:00:00.000Z',
        tiers: {},
      },
    }),
    jsonResponse({
      _id: 'bad-source-updated',
      name: 'Bad source updated',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        sourceUpdatedAt: 42,
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'bad-synced-format',
      name: 'Bad synced format',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        syncedAt: 'not-a-date',
      },
    }),
    jsonResponse({
      _id: 'bad-synced-calendar',
      name: 'Bad synced calendar',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        syncedAt: '2026-02-30T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'bad-version',
      name: 'Bad version',
      alibabaCatalogPricing: {
        schemaVersion: '1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'array-status',
      name: 'Array status',
      alibabaSourceStatus: ['available'],
    }),
    jsonResponse({
      _id: 'array-mode',
      name: 'Array mode',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: ['fixed'],
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'negative-price',
      name: 'Negative price',
      wholesalePrice: -1,
    }),
    jsonResponse({
      _id: 'bad-range',
      name: 'Bad range',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'range',
        currency: 'USD',
        minAmountMinor: 300,
        maxAmountMinor: 200,
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'bad-tier-window',
      name: 'Bad tier window',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'tiered',
        currency: 'USD',
        tiers: [{ minQuantity: 100, maxQuantity: 50, unitAmountMinor: 250 }],
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'overlapping-tiers',
      name: 'Overlapping tiers',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'tiered',
        currency: 'USD',
        tiers: [
          { minQuantity: 1, maxQuantity: 100, unitAmountMinor: 250 },
          { minQuantity: 100, unitAmountMinor: 200 },
        ],
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'unknown-pricing-key',
      name: 'Unknown pricing key',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'fixed',
        currency: 'USD',
        amountMinor: 250,
        syncedAt: '2026-01-01T00:00:00.000Z',
        discount: true,
      },
    }),
    jsonResponse({
      _id: 'unknown-tier-key',
      name: 'Unknown tier key',
      alibabaCatalogPricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'tiered',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: 250, discount: true }],
        syncedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
    jsonResponse({
      _id: 'unknown-manual-key',
      name: 'Unknown manual key',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 1, unitAmountMinor: 250, discount: true }],
      },
    }),
    jsonResponse({
      _id: 'bad-manual-bounds',
      name: 'Bad manual bounds',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [{ minQuantity: 10, maxQuantity: 5, unitAmountMinor: 250 }],
      },
    }),
    jsonResponse({
      _id: 'too-many-manual-tiers',
      name: 'Too many manual tiers',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: Array.from({ length: 5 }, (_, index) => ({
          minQuantity: index + 1,
          maxQuantity: index + 1,
          unitAmountMinor: 250,
        })),
      },
    }),
  ]);
  await assert.rejects(fetchProductFamily('toys'), /Failed to load catalog/);
  await assert.rejects(fetchProductBySlug('bad'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-pricing'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-source-updated'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-synced-format'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-synced-calendar'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-version'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('array-status'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('array-mode'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('negative-price'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-range'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-tier-window'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('overlapping-tiers'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('unknown-pricing-key'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('unknown-tier-key'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('unknown-manual-key'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('bad-manual-bounds'), /Failed to load item/);
  await assert.rejects(fetchProductBySlug('too-many-manual-tiers'), /Failed to load item/);
});

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage');
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  }
});

function setLocalStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

test('fetchCatalog forwards pagination, current token, AbortSignal, and normalizes media URLs', async () => {
  const storage = new MemoryStorage();
  storage.setItem('channel.token', 'token-page-2');
  setLocalStorage(storage);
  const controller = new AbortController();
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const page = createCatalogPage({
    items: [
      createProduct({
        _id: 'product-2',
        images: ['api/images/image-2', 'https://cdn.example.test/image-3.webp'],
      }),
    ],
    total: 75,
    page: 2,
    pageSize: 48,
  });
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ ok: true, data: page });
  };

  const result = await fetchCatalog(
    '/api/products',
    { categories: ['bluetooth', 'wired'], search: 'studio', page: 2, pageSize: 48 },
    controller.signal,
  );

  assert.equal(
    requestUrl,
    '/api/products?category=bluetooth%2Cwired&search=studio&page=2&pageSize=48',
  );
  assert.equal(requestInit?.signal, controller.signal);
  assert.deepEqual(requestInit?.headers, { Authorization: 'Bearer token-page-2' });
  assert.deepEqual(result.items[0]?.images, [
    '/api/images/image-2',
    'https://cdn.example.test/image-3.webp',
  ]);
});

test('fetchCatalog reads the current session token for every request', async () => {
  const storage = new MemoryStorage();
  setLocalStorage(storage);
  const authorization: Array<string | undefined> = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    authorization.push(headers.get('Authorization') ?? undefined);
    return Response.json({ ok: true, data: createCatalogPage() });
  };

  storage.setItem('channel.token', 'first-token');
  await fetchCatalog('/api/products', { page: 1, pageSize: 12 });
  storage.setItem('channel.token', 'second-token');
  await fetchCatalog('/api/products', { page: 1, pageSize: 12 });
  storage.removeItem('channel.token');
  await fetchCatalog('/api/products', { page: 1, pageSize: 12 });

  assert.deepEqual(authorization, ['Bearer first-token', 'Bearer second-token', undefined]);
});

test('fetchCatalog propagates AbortError and never returns a successful page after abort', async () => {
  const controller = new AbortController();
  let settledAsSuccess = false;
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('AbortSignal was not forwarded')), 250);
      const abort = () => {
        clearTimeout(timeout);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort, { once: true });
    });

  const request = fetchCatalog('/api/products', { page: 2, pageSize: 48 }, controller.signal).then(
    (page) => {
      settledAsSuccess = true;
      return page;
    },
  );
  controller.abort();

  await assert.rejects(request, (error: unknown) => {
    return error instanceof DOMException && error.name === 'AbortError';
  });
  assert.equal(settledAsSuccess, false);
});
