import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PublicProductSchema } from '@vibelingan-channel/shared/catalog';
import { decodeCatalogDetailView } from '@vibelingan-channel/shared/catalog-detail';
import { z } from 'zod';
import { startDetailPages } from '../../catalog/application/catalog-detail-pages.ts';
import {
  type DetailPage,
  fetchCatalogDetailPage,
} from '../../catalog/infrastructure/catalog-detail-api.ts';
import { siteOrigin } from './page.ts';
import { productKey, productPath } from './product-identity.ts';

// Strip unknown top-level fields. Nested pricing still uses the strict shared contracts.
// Missing family/slug are historical public data, never a reason to remove a product.
const publicRow = PublicProductSchema.partial({ productFamily: true }).strip();
export type SeoPublicProduct = z.infer<typeof publicRow>;
const publicVersionSchema = z
  .object({
    sequence: z.number().int().positive().safe(),
    semanticHash: z.string().regex(/^[a-f0-9]{64}$/),
    changedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ProductPublicVersion = z.infer<typeof publicVersionSchema>;
export interface ProductSnapshotEntry {
  product: SeoPublicProduct;
  detail?: DetailPage;
  revision: string;
  publicVersion?: ProductPublicVersion;
}
export interface ProductSnapshot {
  schemaVersion: 1;
  purpose: 'public' | 'fixture';
  total: number;
  siteOrigin: string;
  apiOrigin: string;
  products: ProductSnapshotEntry[];
}
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function projectRow(value: unknown): SeoPublicProduct {
  const record = z.record(z.unknown()).parse(value);
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(PublicProductSchema.shape)) {
    const item = record[key];
    // Old rows can contain empty optional labels instead of absent labels.
    if (key !== '_id' && key !== 'name' && typeof item === 'string' && !item.trim()) continue;
    if (item !== undefined && key !== 'publicPageReady') fields[key] = item;
  }
  const row = publicRow.parse(fields);
  productKey(row._id);
  if (row.published === false) throw new Error(`Non-public product in snapshot: ${row._id}`);
  // Only public same-origin media routes or HTTPS assets; no data/javascript URLs.
  if (
    row.images?.some(
      (url) => !/^\/api\/images\/[A-Za-z0-9_-]+$/.test(url) && !/^https:\/\//.test(url),
    )
  )
    throw new Error(`Invalid public image: ${row._id}`);
  return row;
}
function projectDetail(value: unknown, id: string): DetailPage {
  const decoded = decodeCatalogDetailView(value);
  if (!decoded.ok || !decoded.value.revision || decoded.value._id !== id)
    throw new Error(`Invalid public detail: ${id}`);
  const detail = { ...decoded.value, revision: decoded.value.revision };
  const pages = startDetailPages(detail, new TextEncoder().encode(JSON.stringify(detail)).length);
  if (pages.status !== 'ready') throw new Error(`Invalid initial detail page: ${id}`);
  return detail;
}

export function decodeProductSnapshot(value: unknown, expectedSite: string): ProductSnapshot {
  const root = z
    .object({
      schemaVersion: z.literal(1),
      purpose: z.enum(['public', 'fixture']),
      total: z.number().int().nonnegative().safe(),
      siteOrigin: z.string(),
      apiOrigin: z.string(),
      products: z.array(
        z
          .object({
            product: z.unknown(),
            detail: z.unknown().optional(),
            revision: z.string().min(1),
            publicVersion: publicVersionSchema.optional(),
          })
          .strict(),
      ),
    })
    .strict()
    .parse(value);
  if (siteOrigin(root.siteOrigin) !== siteOrigin(expectedSite))
    throw new Error('Snapshot SITE_URL mismatch');
  if (root.products.length !== root.total) throw new Error('Incomplete public snapshot');
  if (
    root.purpose === 'fixture' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(expectedSite).hostname)
  )
    throw new Error('Synthetic SEO fixtures are restricted to local builds');
  const ids = new Set<string>();
  const products = root.products.map((entry) => {
    const product = projectRow(entry.product);
    if (ids.has(product._id)) throw new Error(`Duplicate public ID: ${product._id}`);
    ids.add(product._id);
    const detail =
      entry.detail === undefined ? undefined : projectDetail(entry.detail, product._id);
    const revision = detail?.revision ?? `legacy-${hash(product)}`;
    if (entry.revision !== revision) throw new Error(`Snapshot revision mismatch: ${product._id}`);
    return {
      product,
      detail,
      revision,
      ...(entry.publicVersion ? { publicVersion: entry.publicVersion } : {}),
    };
  });
  return {
    schemaVersion: 1,
    purpose: root.purpose,
    total: root.total,
    siteOrigin: siteOrigin(expectedSite),
    apiOrigin: siteOrigin(root.apiOrigin),
    products,
  };
}

async function publicJson(path: string, api: typeof fetch): Promise<unknown> {
  const response = await api(path, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Public catalog HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty public catalog response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Public catalog response exceeds byte budget');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const envelope = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  return envelope.data;
}

async function inventory(api: typeof fetch): Promise<SeoPublicProduct[]> {
  const rows: SeoPublicProduct[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  let pageSize: number | undefined;
  for (let page = 1; ; page++) {
    const value = await publicJson(`/api/products?page=${page}&pageSize=48`, api);
    const result = z
      .object({
        items: z.array(z.unknown()),
        total: z.number().int().nonnegative().safe().max(50000),
        page: z.number().int().positive(),
        pageSize: z.number().int().min(1).max(100),
      })
      .parse(value);
    total ??= result.total;
    pageSize ??= result.pageSize;
    if (
      result.page !== page ||
      result.total !== total ||
      result.pageSize !== pageSize ||
      result.items.length !== Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize))
    )
      throw new Error('Public inventory pagination changed or is incomplete');
    for (const value of result.items) {
      const product = projectRow(value);
      if (ids.has(product._id)) throw new Error(`Duplicate public inventory ID: ${product._id}`);
      ids.add(product._id);
      rows.push(product);
    }
    if (rows.length === total) return rows.sort((a, b) => a._id.localeCompare(b._id));
  }
}

async function mapPublic<T, U>(items: readonly T[], work: (item: T) => Promise<U>): Promise<U[]> {
  const output: U[] = new Array(items.length);
  let cursor = 0;
  // Keep read pressure bounded. A failed item aborts the complete snapshot.
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) output[index] = await work(item);
      }
    }),
  );
  return output;
}

function publicCatalogFetch(origin: string, fetcher: typeof fetch): typeof fetch {
  const apiOrigin = siteOrigin(origin);
  return (input, init) => {
    const url = new URL(String(input), apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith('/api/products'))
      throw new Error('Unexpected public snapshot endpoint');
    return fetcher(url.href, {
      ...init,
      headers: undefined,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  };
}

/** Cheap public URL allowlist for withdrawal checks; this never fetches product details. */
export async function collectPublicProductPaths(
  origin: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  return (await inventory(publicCatalogFetch(origin, fetcher))).map((product) =>
    productPath(product._id),
  );
}

export async function collectProductSnapshot(
  site: string,
  origin: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProductSnapshot> {
  const apiOrigin = siteOrigin(origin);
  const api = publicCatalogFetch(origin, fetcher);
  const products = await inventory(api);
  const entries = await mapPublic(products, (listed) => captureEntry(listed, api));
  const after = await inventory(api);
  if (hash(products) !== hash(after))
    throw new Error('Public inventory changed during snapshot; retry the complete acquisition');
  await mapPublic(entries, (entry) => verifyEntry(entry, api));
  return decodeProductSnapshot(
    {
      schemaVersion: 1,
      purpose: 'public',
      total: entries.length,
      siteOrigin: siteOrigin(site),
      apiOrigin,
      products: entries,
    },
    site,
  );
}

let loaded: Promise<ProductSnapshot> | undefined;
export function readProductSnapshot(site: string): Promise<ProductSnapshot> {
  loaded ??= (async () => {
    const file = process.env.SEO_CATALOG_SNAPSHOT;
    if (file) return decodeProductSnapshot(JSON.parse(await readFile(file, 'utf8')), site);
    if (process.env.SEO_CATALOG_API_ORIGIN)
      return collectProductSnapshot(site, process.env.SEO_CATALOG_API_ORIGIN);
    throw new Error(
      'Set SEO_CATALOG_SNAPSHOT or SEO_CATALOG_API_ORIGIN explicitly; refusing to build without the public product inventory.',
    );
  })();
  return loaded;
}

/** Explicit emergency reuse keeps detail UI; new product IDs require a complete fresh snapshot. */
export function reuseAcceptedProductSnapshot(
  input: unknown,
  publicPaths: string[],
  site: string,
): ProductSnapshot {
  const snapshot = decodeProductSnapshot(input, site);
  if (
    snapshot.purpose !== 'public' ||
    !Array.isArray(publicPaths) ||
    publicPaths.length > 50000 ||
    new Set(publicPaths).size !== publicPaths.length ||
    publicPaths.some((path) => !/^\/products\/p-[A-Za-z0-9_-]{1,200}\/$/.test(path))
  )
    throw Error('Verified accepted snapshot and complete current public URL inventory required');
  const known = new Set(snapshot.products.map((entry) => productPath(entry.product._id)));
  if (publicPaths.some((path) => !known.has(path)))
    throw Error('New public products are absent from the accepted snapshot; use full acquisition');
  const current = new Set(publicPaths);
  const products = snapshot.products.filter((entry) => current.has(productPath(entry.product._id)));
  return decodeProductSnapshot({ ...snapshot, total: products.length, products }, site);
}

async function captureEntry(
  listed: SeoPublicProduct,
  api: typeof fetch,
): Promise<ProductSnapshotEntry> {
  const result = await fetchCatalogDetailPage({ productId: listed._id }, { fetch: api });
  if (result.status === 'ready')
    return { product: listed, detail: result.detail, revision: result.detail.revision };
  if (result.status !== 'not-found')
    throw new Error(`Public detail ${listed._id}: ${result.status}`);
  const product = projectRow(
    await publicJson(`/api/products/${encodeURIComponent(listed._id)}`, api),
  );
  if (product._id !== listed._id) throw new Error('Public base detail identity mismatch');
  return { product, revision: `legacy-${hash(product)}` };
}
async function verifyEntry(entry: ProductSnapshotEntry, api: typeof fetch): Promise<void> {
  if (entry.detail) {
    const check = await fetchCatalogDetailPage(
      {
        productId: entry.product._id,
        revision: entry.revision,
        pageSize: entry.detail.variants.pageSize,
      },
      { fetch: api },
    );
    if (check.status !== 'ready' || hash(check.detail) !== hash(entry.detail))
      throw new Error(`Public revision changed: ${entry.product._id}`);
  } else {
    const check = projectRow(
      await publicJson(`/api/products/${encodeURIComponent(entry.product._id)}`, api),
    );
    if (publicCardHash(check) !== publicCardHash(entry.product))
      throw new Error(`Legacy public product changed: ${entry.product._id}`);
  }
}

export async function collectProductInventory(
  origin: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<SeoPublicProduct[]> {
  return inventory(publicCatalogFetch(origin, fetcher));
}

const refreshHeadSchema = publicVersionSchema
  .extend({
    productId: z.string().min(1),
    visible: z.boolean(),
    detailRevision: z.string().nullable(),
  })
  .strict();

/** Keep accepted data for unchanged IDs. Missing rows require explicit withdrawal proof. */
export async function collectProductRefresh(
  acceptedInput: unknown,
  headsInput: unknown,
  site: string,
  origin: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ProductSnapshot> {
  const accepted = decodeProductSnapshot(acceptedInput, site);
  if (accepted.purpose !== 'public') throw Error('An accepted public snapshot is required');
  const parsed = z.array(refreshHeadSchema).max(50000).parse(headsInput);
  const heads = new Map(parsed.map((head) => [head.productId, head]));
  if (heads.size !== parsed.length) throw Error('Duplicate refresh head');
  const api = publicCatalogFetch(origin, fetcher);
  const before = await inventory(api);
  const currentIds = new Set(before.map((row) => row._id));
  for (const entry of accepted.products)
    if (!currentIds.has(entry.product._id) && heads.get(entry.product._id)?.visible !== false)
      throw Error('An explicit withdrawal version is required');
  for (const head of heads.values())
    if (head.visible !== currentIds.has(head.productId))
      throw Error('Public inventory and tracked version disagree');
  const old = new Map(accepted.products.map((entry) => [entry.product._id, entry]));
  const refreshed: ProductSnapshotEntry[] = [];
  const products = await mapPublic(before, async (row) => {
    const previous = old.get(row._id);
    const head = heads.get(row._id);
    const cardChanged =
      previous && publicCardHash(projectRow(previous.product)) !== publicCardHash(row);
    if ((!previous || cardChanged) && !head) throw Error('Public change is not tracked');
    const refresh =
      !previous ||
      cardChanged ||
      (head &&
        (head.sequence !== previous.publicVersion?.sequence ||
          head.semanticHash !== previous.publicVersion?.semanticHash));
    if (!refresh && previous) return previous;
    const entry = await captureEntry(row, api);
    if (head && (entry.detail?.revision ?? null) !== head.detailRevision)
      throw Error(`Tracked product revision changed: ${row._id}`);
    const value = {
      ...entry,
      ...(head
        ? {
            publicVersion: {
              sequence: head.sequence,
              semanticHash: head.semanticHash,
              changedAt: head.changedAt,
            },
          }
        : {}),
    };
    refreshed.push(value);
    return value;
  });
  if (hash(before.map(publicCardHash)) !== hash((await inventory(api)).map(publicCardHash)))
    throw Error('Public inventory changed during incremental acquisition');
  await mapPublic(refreshed, (entry) => verifyEntry(entry, api));
  return decodeProductSnapshot(
    { ...accepted, total: products.length, apiOrigin: siteOrigin(origin), products },
    site,
  );
}

function publicCardHash(product: SeoPublicProduct): string {
  const { alibabaSourceLastSyncedAt: _pollTime, ...content } = product;
  return hash(content);
}
