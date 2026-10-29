import { isDeepStrictEqual } from 'node:util';
import {
  type CollectionDoc,
  productFamilyForDoc,
  storedCatalogTaxonomy,
} from '@vibelingan-channel/shared';
import { resolvePublicVersion } from '@vibelingan-channel/shared/catalog-public-version';
import {
  type CatalogPublicChangeStore,
  planCatalogPublicRefresh,
  writeCatalogPublicChange,
} from './catalog-public-changes.ts';
import { prepareCatalogPublicState } from './catalog-public-content.ts';
import {
  type CatalogSeoRecordingConfig,
  CatalogSeoRecordingConfigSchema,
  type CatalogSeoRequest,
  CatalogSeoRequestSchema,
  createCatalogSeoRequest,
} from './catalog-seo-requests.ts';

export interface CatalogSeoReadStore {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  list(
    collection: string,
    filter: Readonly<Record<string, unknown>>,
    cursor: string | null,
    limit: number,
  ): Promise<CollectionDoc[]>;
}
export interface CatalogSeoStore extends CatalogSeoReadStore {
  transaction<T>(operation: (tx: CatalogPublicChangeStore) => Promise<T>): Promise<T>;
}
type Result =
  | {
      status: 'checked';
      kind: 'initialized' | 'changed' | 'metadata' | 'unchanged';
      sequence: number | null;
    }
  | { status: 'expanded'; queued: number; complete: boolean }
  | { status: 'stale' | 'already-checked' };
const PAGE_SIZE = 100;
const FAMILY_BATCH = 20;
const MAX_VARIANTS = 10000;
const MAX_VARIANT_BYTES = 32 * 1024 * 1024;

/** Prepare outside a transaction; the final commit compares and fences the exact request. */
export async function consumeCatalogSeoRequest(
  db: CatalogSeoStore,
  input: unknown,
  options: CatalogSeoRecordingConfig,
  now: string,
): Promise<Result> {
  const config = CatalogSeoRecordingConfigSchema.parse(options);
  const request = CatalogSeoRequestSchema.parse(input);
  if (request.siteOrigin !== config.siteOrigin) throw Error('SEO request belongs to another site');
  const expected = createCatalogSeoRequest(
    config.siteOrigin,
    request.kind === 'product'
      ? {
          kind: 'product',
          productId: request.productId,
          previouslyPublic: request.previouslyPublic,
        }
      : { kind: 'family', family: request.family },
    now,
  );
  if (request._id !== expected._id) throw Error('SEO request identity mismatch');
  if (request.state === 'checked') return { status: 'already-checked' };
  if (request.kind === 'family') return expandFamily(db, request, config, now);
  const source = await readProduct(db, request.productId, config);
  const after = source.product
    ? prepareCatalogPublicState({
        product: source.product,
        detailEnabled: config.detailEnabled,
        ...(source.taxonomy ? { taxonomy: source.taxonomy } : {}),
        ...(source.variants ? { variants: source.variants } : {}),
      })
    : { productId: request.productId, visible: false as const };
  return db.transaction(async (tx) => {
    const store = cached(tx);
    const current = await store.get('catalogSeoRequests', request._id);
    if (!current || !isDeepStrictEqual(current, request)) return { status: 'stale' };
    if (!isDeepStrictEqual(await store.get('products', request.productId), source.product))
      return { status: 'stale' };
    let familyRequest: CatalogSeoRequest | null = null;
    if (source.family) {
      if (!isDeepStrictEqual(await store.get('catalogTaxonomies', source.family), source.registry))
        return { status: 'stale' };
      const seed = createCatalogSeoRequest(
        config.siteOrigin,
        { kind: 'family', family: source.family },
        now,
      );
      const row = await store.get('catalogSeoRequests', seed._id);
      familyRequest = row ? CatalogSeoRequestSchema.parse(row) : { ...seed, state: 'checked' };
      if (
        familyRequest._id !== seed._id ||
        familyRequest.kind !== 'family' ||
        familyRequest.siteOrigin !== config.siteOrigin ||
        familyRequest.family !== source.family
      )
        throw Error('Corrupt SEO family fence');
    }
    const plan = await planCatalogPublicRefresh(store, {
      siteOrigin: config.siteOrigin,
      after,
      now: request.requestedAt,
    });
    // A same-value write takes a write conflict against concurrent taxonomy updates.
    if (familyRequest) await store.set('catalogSeoRequests', familyRequest);
    await writeCatalogPublicChange(store, plan);
    await store.set('catalogSeoRequests', { ...request, state: 'checked' });
    return { status: 'checked', kind: plan.kind, sequence: plan.sequence };
  });
}

async function readProduct(
  db: CatalogSeoReadStore,
  productId: string,
  config: CatalogSeoRecordingConfig,
) {
  const product = await db.get('products', productId);
  if (product && product._id !== productId) throw Error('Wrong product returned for SEO read');
  const family = product ? productFamilyForDoc(product) : null;
  const registry = family ? await db.get('catalogTaxonomies', family) : null;
  const taxonomy = family ? storedCatalogTaxonomy(family, registry) : null;
  if (family && !taxonomy) throw Error('Invalid SEO taxonomy');
  if (
    !product ||
    product.published !== true ||
    (Object.hasOwn(product, 'archived') && product.archived !== false)
  )
    return { product, family, registry, taxonomy, variants: null };
  const version = resolvePublicVersion(product, { detailEnabled: config.detailEnabled });
  const collection =
    version.kind === 'approved' && version.publication.variantStorage === 'immutable-v1'
      ? 'catalogDetailVariants'
      : 'productVariants';
  const filter = {
    productId,
    ...(version.kind === 'approved' ? { catalogDetailRevision: version.publication.revision } : {}),
  };
  const items: CollectionDoc[] = [];
  let cursor: string | null = null;
  let bytes = 0;
  for (;;) {
    const page = await db.list(collection, filter, cursor, PAGE_SIZE);
    if (page.length > PAGE_SIZE) throw Error('SEO variant page exceeds its limit');
    for (const row of page) {
      if (
        !row ||
        typeof row._id !== 'string' ||
        row._id <= (cursor ?? '') ||
        row.productId !== productId ||
        (version.kind === 'approved' && row.catalogDetailRevision !== version.publication.revision)
      )
        throw Error('Unstable SEO variant page');
      cursor = row._id;
      if (row.archived === true) continue;
      bytes += Buffer.byteLength(JSON.stringify(row));
      items.push(row);
      if (items.length > MAX_VARIANTS || bytes > MAX_VARIANT_BYTES)
        throw Error('SEO variant read exceeds its budget');
    }
    if (page.length < PAGE_SIZE) break;
  }
  return {
    product,
    family,
    registry,
    taxonomy,
    variants: { kind: version.kind, total: items.length, items },
  };
}

async function expandFamily(
  db: CatalogSeoStore,
  request: Extract<CatalogSeoRequest, { kind: 'family' }>,
  config: CatalogSeoRecordingConfig,
  now: string,
): Promise<Result> {
  const rows = await db.list('products', { published: true }, request.cursor ?? null, FAMILY_BATCH);
  if (
    rows.length > FAMILY_BATCH ||
    rows.some(
      (row, index) => row._id <= (index ? (rows[index - 1]?._id ?? '') : (request.cursor ?? '')),
    )
  )
    throw Error('Unstable SEO family page');
  return db.transaction(async (tx) => {
    const current = await tx.get('catalogSeoRequests', request._id);
    if (!isDeepStrictEqual(current, request)) return { status: 'stale' };
    const writes: CatalogSeoRequest[] = [];
    for (const row of rows) {
      const product = await tx.get('products', row._id);
      if (
        !product ||
        product.published !== true ||
        product.archived === true ||
        productFamilyForDoc(product) !== request.family
      )
        continue;
      const next = createCatalogSeoRequest(
        config.siteOrigin,
        { kind: 'product', productId: product._id, previouslyPublic: true },
        request.requestedAt,
      );
      const pending = await tx.get('catalogSeoRequests', next._id);
      if (pending) {
        const parsed = CatalogSeoRequestSchema.parse(pending);
        if (
          parsed.kind !== 'product' ||
          parsed.productId !== product._id ||
          parsed.siteOrigin !== config.siteOrigin
        )
          throw Error('Corrupt SEO product request');
        if (parsed.state === 'pending') continue;
      }
      writes.push(next);
    }
    for (const row of writes) await tx.set('catalogSeoRequests', row);
    const complete = rows.length < FAMILY_BATCH;
    await tx.set('catalogSeoRequests', {
      ...request,
      ...(rows.length ? { cursor: rows[rows.length - 1]?._id } : {}),
      state: complete ? 'checked' : 'pending',
    });
    return { status: 'expanded', queued: writes.length, complete };
  });
}

function cached(tx: CatalogPublicChangeStore): CatalogPublicChangeStore {
  const rows = new Map<string, CollectionDoc | null>();
  return {
    get: async (collection, id) => {
      const key = JSON.stringify([collection, id]);
      if (!rows.has(key)) rows.set(key, await tx.get(collection, id));
      return structuredClone(rows.get(key) ?? null);
    },
    set: (collection, row) => tx.set(collection, row),
  };
}
