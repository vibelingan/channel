import { verifySession } from '@vibelingan-channel/auth/jwt';
import {
  CATALOG_IMAGE_REFERENCE_LEDGER_FIELD,
  emptyCatalogImageReferenceCount,
  findByField,
  get,
  list,
  readCatalogImageReference,
} from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import {
  type ApiResult,
  type CollectionDoc,
  type FilterClause,
  PUBLIC_CATALOG_COLLECTIONS,
  type ProductFamily,
  canSeeVipPricing,
  catalogReferencedImageIds,
  err,
  isProductFamily,
  isProductSubcategoryIds,
  normalizeProductSlug,
  ok,
  productFamilyForDoc,
  publicSearchFields,
  toRole,
} from '@vibelingan-channel/shared';
import {
  type CatalogViewer,
  PUBLIC_VARIANTS_PER_PRODUCT_CAP,
  type PublicVariant,
  publicDoc,
  publicItem,
  publicVariant,
} from '@vibelingan-channel/shared/catalog-public-projection';
export {
  type CatalogViewer,
  publicDoc,
  publicItem,
} from '@vibelingan-channel/shared/catalog-public-projection';
import { readCatalogTaxonomy } from './catalog-taxonomy.ts';

const CATALOGS = PUBLIC_CATALOG_COLLECTIONS;
const MAX_PUBLIC_PAGE_SIZE = 48;
const IMAGE_SCAN_PAGE_SIZE = 100;
const PLACEHOLDER_IMAGE_ID = '_placeholder';

export type PublicCatalog = (typeof CATALOGS)[number];

export interface CatalogQuery {
  productFamily?: ProductFamily;
  categories?: readonly string[];
  subcategoryIds?: readonly string[];
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface PublicApiConfig {
  apiBaseUrl?: string;
  /**
   * Portal session-signing secret (same value the admin function signs with).
   * When set, the catalog routes verify a presented Bearer token and may attach
   * role-gated pricing tiers. Absent → the catalog is anonymous-only (no gated
   * tiers ever attached), which is the safe default.
   */
  jwtSecret?: string;
  /**
   * Approved product detail is on. Also decides which version of a product is
   * public everywhere (DEC-1): the approved version when this is on.
   */
  enableCatalogDetail?: boolean;
}

/**
 * The pricing entitlement of the CURRENT catalog caller, resolved server-side
 * from a verified session token. `canSeeVipPricing` is the ONLY gate that
 * unlocks the VIP tier in the projection — never a client-supplied flag.
 */

const ANONYMOUS_VIEWER: CatalogViewer = { canSeeVipPricing: false };

function bearerToken(authorization: string | undefined): string {
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? '';
}

/**
 * Resolve the caller's catalog entitlement from an `Authorization: Bearer …`
 * header. Fails closed to the anonymous viewer on every ambiguous input — no
 * secret configured, no/blank token, an invalid/expired signature, a missing
 * or suspended users row, or a failed row lookup — so a missing, forged, or
 * revoked token can never unlock gated pricing.
 *
 * Mirrors the admin function's `revalidateSession` (V3 revocation): the JWT
 * proves identity for its TTL, but the entitlement comes from the users row
 * as it exists NOW — a suspended/deleted account loses VIP visibility on its
 * next request and a demoted (or promoted) user drops/gains the tier
 * immediately. The row read costs one `get` per AUTHENTICATED request only;
 * anonymous catalog traffic never touches the users collection.
 */
export async function resolveCatalogViewer(
  authorization: string | undefined,
  config: PublicApiConfig,
): Promise<CatalogViewer> {
  if (!config.jwtSecret) return ANONYMOUS_VIEWER;
  const token = bearerToken(authorization);
  if (!token) return ANONYMOUS_VIEWER;
  const claims = await verifySession(config.jwtSecret, token);
  if (!claims) return ANONYMOUS_VIEWER;
  try {
    const user = await get('users', claims.sub);
    if (!user || user.status === 'suspended') return ANONYMOUS_VIEWER;
    return { canSeeVipPricing: canSeeVipPricing(toRole(user.role)) };
  } catch (e) {
    // The catalog must stay up even if the entitlement lookup fails; degrade
    // to the anonymous projection rather than surfacing an error. Logged so a
    // persistent users-collection outage (every member silently losing VIP
    // pricing) is visible in ops rather than a mystery.
    console.error('[fn-public-api] catalog entitlement lookup failed:', e);
    return ANONYMOUS_VIEWER;
  }
}

export interface BinaryResult {
  ok: true;
  body: string;
  isBase64Encoded: true;
  headers: Record<string, string>;
}

function isPublicCatalog(value: string): value is PublicCatalog {
  return (CATALOGS as readonly string[]).includes(value);
}

/**
 * Public projection of an imported product's variants.
 *
 * The allowlist is three fields wide and stays that way. `productVariants`
 * rows also carry `inventorySnapshots` (which names the merchant's SHOPS),
 * `sourceRegularPrice`/`sourcePromotionPrice` (source CNY, while the website
 * quotes USD) and the reconciliation state — none of which a visitor has any
 * business seeing, and the first of which would publish the merchant's channel
 * strategy to their competitors.
 *
 * `inventory` is attached ONLY when reconciliation produced an exact count.
 * A conflict or an unknown ships no number at all: the merchant asked for an
 * exact figure, and a fabricated one would be a promise the warehouse cannot
 * keep.
 */

/**
 * Attach variants to the products on one page, in ONE query rather than one
 * query per product. Products with no variants are left byte-identical — every
 * legacy and Alibaba-linked row predates this collection and must not gain an
 * empty `variants` key it never had.
 */
async function attachVariants(
  collection: PublicCatalog,
  docs: readonly CollectionDoc[],
): Promise<Map<string, PublicVariant[]>> {
  const byProduct = new Map<string, PublicVariant[]>();
  if (collection !== 'products' || docs.length === 0) return byProduct;

  const page = await list({
    collection: 'productVariants',
    page: 1,
    pageSize: MAX_PUBLIC_PAGE_SIZE * PUBLIC_VARIANTS_PER_PRODUCT_CAP,
    filter: {
      combinator: 'and',
      clauses: [{ field: 'productId', op: 'in', value: docs.map((doc) => doc._id) }],
    },
    sort: [
      { field: 'position', dir: 'asc' },
      { field: '_id', dir: 'asc' },
    ],
  });
  for (const doc of page.items) {
    if (doc.archived === true) continue;
    const productId = typeof doc.productId === 'string' ? doc.productId : '';
    if (productId === '') continue;
    const existing = byProduct.get(productId) ?? [];
    if (existing.length >= PUBLIC_VARIANTS_PER_PRODUCT_CAP) continue;
    existing.push(publicVariant(doc));
    byProduct.set(productId, existing);
  }
  return byProduct;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

export async function listCatalog(
  collection: PublicCatalog,
  query: CatalogQuery,
  config: PublicApiConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): Promise<ApiResult<unknown>> {
  const page = positiveInt(query.page, 1);
  const pageSize = Math.min(MAX_PUBLIC_PAGE_SIZE, positiveInt(query.pageSize, 24));
  const clauses: FilterClause[] = [{ field: 'published', op: 'isLiteralTrue' }];
  if (query.subcategoryIds !== undefined) {
    if (
      collection !== 'products' ||
      !isProductFamily(query.productFamily) ||
      query.categories !== undefined ||
      !isProductSubcategoryIds(query.subcategoryIds) ||
      query.subcategoryIds.length === 0
    ) {
      return err('VALIDATION_ERROR', 'Invalid product subcategory selection.');
    }
    const taxonomy = await readCatalogTaxonomy(query.productFamily);
    if (!taxonomy.ok) return taxonomy;
    const activeIds = new Set(
      taxonomy.data.children.filter((child) => child.status === 'active').map((child) => child.id),
    );
    if (!query.subcategoryIds.every((id) => activeIds.has(id))) {
      return err('VALIDATION_ERROR', 'Unknown or archived product subcategory.');
    }
    clauses.push({
      field: 'subcategoryIds',
      op: 'matchesProductSubcategories',
      value: {
        family: query.productFamily,
        ids: query.subcategoryIds,
        knownIds: taxonomy.data.children.map((child) => child.id),
      },
    });
  }
  if (collection === 'products') {
    clauses.push({ field: 'archived', op: 'isFalseOrMissing' });
    if (query.productFamily) {
      clauses.push({
        field: 'productFamily',
        op: 'matchesProductFamily',
        value: query.productFamily,
      });
    }
  }
  const categories = query.categories?.map((c) => c.trim()).filter(Boolean) ?? [];
  if (categories.length > 0) {
    clauses.push({ field: 'category', op: 'in' as const, value: categories });
  }

  const result = await list({
    collection,
    page,
    pageSize,
    search: query.search ?? '',
    // Buyers search what they can see; internal ids (Alibaba's) stay admin-only.
    searchFields: publicSearchFields(collection),
    filter: { combinator: 'and' as const, clauses },
    sort: [{ field: '_id', dir: 'asc' }],
  });

  const projections = result.items.map((doc) => publicItem(collection, doc, config, viewer));
  // Row configurations are not part of an approved version; only row-fallback
  // products keep them.
  const variants = await attachVariants(
    collection,
    result.items.filter((_, index) => projections[index]?.kind === 'row'),
  );
  return ok({
    items: result.items.map((doc, index) => {
      const projected = projections[index]?.doc ?? publicDoc(collection, doc, config, viewer);
      const own = variants.get(doc._id);
      // Only products that actually have variants gain the key, so existing
      // legacy and Alibaba-linked payloads stay byte-identical.
      return own === undefined || own.length === 0 ? projected : { ...projected, variants: own };
    }),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

export async function getCatalogItem(
  collection: PublicCatalog,
  id: string,
  config: PublicApiConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): Promise<ApiResult<unknown>> {
  const doc = await get(collection, id);
  if (
    !doc ||
    doc.published !== true ||
    (collection === 'products' && Object.hasOwn(doc, 'archived') && doc.archived !== false)
  ) {
    return err('NOT_FOUND', 'Item not found');
  }
  return ok(await withVariants(collection, doc, publicItem(collection, doc, config, viewer)));
}

export async function getCatalogItemBySlug(
  slug: string,
  config: PublicApiConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): Promise<ApiResult<unknown>> {
  if (normalizeProductSlug(slug) !== slug) return err('NOT_FOUND', 'Item not found');
  const doc = await findByField('products', 'slug', slug);
  if (
    !doc ||
    doc.published !== true ||
    (Object.hasOwn(doc, 'archived') && doc.archived !== false)
  ) {
    return err('NOT_FOUND', 'Item not found');
  }
  return ok(await withVariants('products', doc, publicItem('products', doc, config, viewer)));
}

/** Attach variants to one already-projected document, when it has any. */
async function withVariants(
  collection: PublicCatalog,
  doc: CollectionDoc,
  item: { doc: CollectionDoc; kind: 'approved' | 'row' },
): Promise<CollectionDoc> {
  const projected = item.doc;
  if (item.kind === 'approved') return projected;
  const variants = (await attachVariants(collection, [doc])).get(doc._id);
  return variants === undefined || variants.length === 0 ? projected : { ...projected, variants };
}

async function publishedCatalogReferencesImage(
  collection: PublicCatalog,
  imageId: string,
): Promise<boolean> {
  let page = 1;
  for (;;) {
    const result = await list({
      collection,
      page,
      pageSize: IMAGE_SCAN_PAGE_SIZE,
      search: '',
      filter: {
        combinator: 'and',
        clauses: [{ field: 'published', op: 'eq', value: true }],
      },
      sort: [{ field: '_id', dir: 'asc' }],
    });
    if (result.items.some((doc) => catalogReferencedImageIds(doc).includes(imageId))) {
      return true;
    }
    if (page * result.pageSize >= result.total || result.items.length === 0) return false;
    page += 1;
  }
}

/**
 * Legacy compatibility fallback: scan published catalogs for a reference to this
 * image. Used ONLY for legacy-base64 rows that predate `publishedRefCount`; once
 * the Phase-D backfill runs, the ref count is canonical for every provider and
 * this O(catalog) scan is no longer reached.
 */
async function legacyImageIsPublicFallback(imageId: string): Promise<boolean> {
  for (const collection of CATALOGS) {
    if (await publishedCatalogReferencesImage(collection, imageId)) return true;
  }
  return false;
}

/**
 * Content-Type values public image delivery may reflect. `mimeType` is
 * server-managed (readOnly in the registry, byte-sniffed at completeUpload),
 * but delivery still refuses to reflect anything outside this list so a
 * corrupt or pre-hardening value degrades to octet-stream instead of becoming
 * a scriptable Content-Type. SVG stays: legacy seeded rows are SVG and legacy
 * `data` bytes have no write path.
 */
const PUBLIC_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

function binaryImage(doc: CollectionDoc, body: string): BinaryResult {
  const declared = typeof doc.mimeType === 'string' ? doc.mimeType.trim().toLowerCase() : '';
  return {
    ok: true,
    body,
    isBase64Encoded: true,
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Content-Type': PUBLIC_IMAGE_MIME_TYPES.has(declared) ? declared : 'application/octet-stream',
      // Never let a browser second-guess the declared type into text/html.
      'X-Content-Type-Options': 'nosniff',
      // Defense-in-depth for the one active-content type on the allowlist:
      // image/svg+xml opened DIRECTLY (navigated, not <img>) is a document and
      // nosniff does not stop inline <script> in it. `sandbox` (no allow-scripts)
      // runs it in a script-disabled unique origin; `default-src 'none'` blocks
      // any external fetch it attempts. Legacy SVG rows have no user write path,
      // so this is belt-and-suspenders, not the primary control.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  };
}

export async function getCatalogImage(imageId: string): Promise<ApiResult<unknown> | BinaryResult> {
  let doc = await get('images', imageId);
  if (!doc || doc._id !== imageId) return err('NOT_FOUND', 'Image not found');

  // The placeholder is public by explicit id — never gated on refcount/status.
  if (imageId === PLACEHOLDER_IMAGE_ID) {
    return typeof doc.data === 'string'
      ? binaryImage(doc, doc.data)
      : err('NOT_FOUND', 'Image not found');
  }

  let refCount = doc.publishedRefCount;
  if (Object.hasOwn(doc, CATALOG_IMAGE_REFERENCE_LEDGER_FIELD)) {
    try {
      const emptyCount = emptyCatalogImageReferenceCount(doc);
      if (emptyCount !== null) refCount = emptyCount;
      else {
        const snapshot = await readCatalogImageReference({ action: 'read', imageId });
        if (
          snapshot.state !== 'counted' ||
          snapshot.image._id !== imageId ||
          !Object.hasOwn(snapshot.image, 'publishedRefCount') ||
          !Number.isSafeInteger(snapshot.effectiveCount) ||
          snapshot.effectiveCount < 0 ||
          snapshot.settled
        )
          return err('NOT_FOUND', 'Image not found');
        doc = snapshot.image;
        refCount = snapshot.effectiveCount;
      }
    } catch (error) {
      const value = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      const code =
        typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'UNAVAILABLE';
      console.error('[fn-public-api] image reference snapshot unavailable', { imageId, code });
      return err('NOT_FOUND', 'Image not found');
    }
  }
  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : 'legacy-base64';
  // publishedRefCount is "valid" only as a finite NUMBER. The writer/backfill
  // always store a number (and `isStorageBackedImage` narrows on
  // `typeof === 'number'`), so a numeric STRING like "1" — or any non-number — is
  // a corrupt value and must fail closed, not coerce to a positive count.
  const visibleByRefCount =
    typeof refCount === 'number' && Number.isFinite(refCount) && refCount > 0;
  const hasRefCountField = Object.hasOwn(doc, 'publishedRefCount');

  if (provider === 'legacy-base64') {
    // The O(catalog) scan is a compatibility fallback ONLY for rows that predate
    // publishedRefCount (field absent). Once the field is PRESENT it is canonical
    // — a present-but-invalid counter is corruption and fails closed, never scans.
    const visible = hasRefCountField
      ? visibleByRefCount
      : await legacyImageIsPublicFallback(imageId);
    if (!visible || typeof doc.data !== 'string') return err('NOT_FOUND', 'Image not found');
    return binaryImage(doc, doc.data);
  }

  // Storage-backed: only the recognised providers may proxy (matches the shared
  // `isStorageBackedImage` set) — an unknown/corrupt provider fails closed. Then
  // require active status, a positive finite numeric count, and a string fileId.
  const storageFileId = doc.storageFileId;
  if (
    (provider !== 'cloudbase-storage' && provider !== 'local-disk') ||
    doc.status !== 'active' ||
    !visibleByRefCount ||
    typeof storageFileId !== 'string'
  ) {
    return err('NOT_FOUND', 'Image not found');
  }
  try {
    const object = await mediaStorage().getObjectAsBase64(storageFileId);
    return binaryImage(doc, object.body);
  } catch (e) {
    // Active metadata but unfetchable bytes (missing object / transient store
    // error): 404 for public delivery rather than leaking a 500.
    console.error(`[fn-public-api] storage fetch failed for image ${imageId}:`, e);
    return err('NOT_FOUND', 'Image not found');
  }
}

export function parseCatalogName(pathPart: string): PublicCatalog | null {
  return isPublicCatalog(pathPart) ? pathPart : null;
}
