import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createCatalogPage, createProduct } from '../../test/factories/catalog.ts';
import { fetchCatalog } from './api.ts';

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
