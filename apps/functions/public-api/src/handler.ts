import { verifySession } from '@vibelingan-channel/auth/jwt';
import { get, list } from '@vibelingan-channel/db';
import { mediaStorage } from '@vibelingan-channel/media-storage';
import {
  type ApiResult,
  type CollectionDoc,
  type FilterClause,
  canSeeVipPricing,
  err,
  ok,
} from '@vibelingan-channel/shared';

const CATALOGS = ['products', 'overstock'] as const;
const MAX_PUBLIC_PAGE_SIZE = 48;
const IMAGE_SCAN_PAGE_SIZE = 100;
const PLACEHOLDER_IMAGE_ID = '_placeholder';

export type PublicCatalog = (typeof CATALOGS)[number];

export interface CatalogQuery {
  categories?: readonly string[];
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
}

/**
 * The pricing entitlement of the CURRENT catalog caller, resolved server-side
 * from a verified session token. `canSeeVipPricing` is the ONLY gate that
 * unlocks the VIP tier in the projection — never a client-supplied flag.
 */
export interface CatalogViewer {
  canSeeVipPricing: boolean;
}

const ANONYMOUS_VIEWER: CatalogViewer = { canSeeVipPricing: false };

function bearerToken(authorization: string | undefined): string {
  if (!authorization) return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? '';
}

/**
 * Resolve the caller's catalog entitlement from an `Authorization: Bearer …`
 * header. Fails closed to the anonymous viewer on every ambiguous input — no
 * secret configured, no/blank token, or an invalid/expired signature — so a
 * missing or forged token can never unlock gated pricing.
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
  return { canSeeVipPricing: canSeeVipPricing(claims.role) };
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

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function apiUrl(path: string, config: PublicApiConfig): string {
  const base = normalizeBaseUrl(config.apiBaseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function imageUrl(id: string, config: PublicApiConfig): string {
  return apiUrl(`/api/images/${encodeURIComponent(id)}`, config);
}

function catalogImages(doc: CollectionDoc, config: PublicApiConfig): string[] {
  const ids = Array.isArray(doc.imageIds) ? doc.imageIds.map(String) : [];
  return ids.map((id) => imageUrl(id, config));
}

/**
 * Fields a catalog document may expose to ANY caller. Everything not listed
 * (imageIds, timestamps, any future internal field) is withheld by default.
 * `unitPrice` and `clearancePrice` are here because the storefront renders them
 * ungated (spec sheet / strike-through discount). Role-gated tiers live in
 * `GATED_CATALOG_FIELDS` and are attached only for an entitled viewer.
 */
const PUBLIC_CATALOG_FIELDS = [
  '_id',
  'name',
  'category',
  'series',
  'modName',
  'modType',
  'description',
  'productCode',
  'moq',
  'inventory',
  'unitPrice',
  'wholesalePrice',
  'clearancePrice',
  'published',
] as const;

/**
 * Role-gated pricing tiers. Attached ONLY when the resolved viewer is entitled
 * (`canSeeVipPricing`). Never in `PUBLIC_CATALOG_FIELDS` — the anonymous path
 * must never ship these.
 */
const GATED_CATALOG_FIELDS = ['vipPrice'] as const;

function publicDoc(
  doc: CollectionDoc,
  config: PublicApiConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): CollectionDoc {
  // Constructed as a CollectionDoc with `_id` set unconditionally, so the
  // result is structurally guaranteed (no cast) — dropping `_id` from the
  // allowlist can never silently ship an id-less doc.
  const out: CollectionDoc = { _id: doc._id, images: catalogImages(doc, config) };
  for (const key of PUBLIC_CATALOG_FIELDS) {
    if (key !== '_id' && key in doc) out[key] = doc[key];
  }
  if (viewer.canSeeVipPricing) {
    for (const key of GATED_CATALOG_FIELDS) {
      if (key in doc) out[key] = doc[key];
    }
  }
  return out;
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
  const clauses: FilterClause[] = [{ field: 'published', op: 'eq', value: true }];
  const categories = query.categories?.map((c) => c.trim()).filter(Boolean) ?? [];
  if (categories.length > 0) {
    clauses.push({ field: 'category', op: 'in' as const, value: categories });
  }

  const result = await list({
    collection,
    page,
    pageSize,
    search: query.search ?? '',
    filter: { combinator: 'and', clauses },
  });

  return ok({
    items: result.items.map((doc) => publicDoc(doc, config, viewer)),
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
  if (!doc || doc.published !== true) {
    return err('NOT_FOUND', 'Item not found');
  }
  return ok(publicDoc(doc, config, viewer));
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
    });
    if (
      result.items.some(
        (doc) => Array.isArray(doc.imageIds) && doc.imageIds.map(String).includes(imageId),
      )
    ) {
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
  const doc = await get('images', imageId);
  if (!doc) return err('NOT_FOUND', 'Image not found');

  // The placeholder is public by explicit id — never gated on refcount/status.
  if (imageId === PLACEHOLDER_IMAGE_ID) {
    return typeof doc.data === 'string'
      ? binaryImage(doc, doc.data)
      : err('NOT_FOUND', 'Image not found');
  }

  const provider = typeof doc.storageProvider === 'string' ? doc.storageProvider : 'legacy-base64';
  // publishedRefCount is "valid" only as a finite NUMBER. The writer/backfill
  // always store a number (and `isStorageBackedImage` narrows on
  // `typeof === 'number'`), so a numeric STRING like "1" — or any non-number — is
  // a corrupt value and must fail closed, not coerce to a positive count.
  const refCount = doc.publishedRefCount;
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
