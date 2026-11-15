import { normalizeProductSlug, normalizeSkuCode, productFamilyForDoc } from '../catalog-product.ts';
import type { PublicCatalogCollection as PublicCatalog } from '../collections.ts';
/** Public catalog projection shared by HTTP responses and content-change detection. */
import type { CollectionDoc } from '../index.ts';
import { validateManualCatalogPricing } from '../manual-catalog-pricing.ts';
import { PRODUCT_IMAGE_MAX_COUNT, normalizeCatalogImageIds } from '../media.ts';
import { priceSummaryMoq } from './product-detail.ts';
import { resolvePublicVersion } from './public-version.ts';

export interface CatalogProjectionConfig {
  apiBaseUrl?: string;
  enableCatalogDetail?: boolean;
}
export interface CatalogViewer {
  canSeeVipPricing: boolean;
}
const ANONYMOUS_VIEWER: CatalogViewer = { canSeeVipPricing: false };
/** Public row configurations are capped consistently in HTTP and content checks. */
export const PUBLIC_VARIANTS_PER_PRODUCT_CAP = 50;

function normalizeBaseUrl(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function apiUrl(path: string, config: CatalogProjectionConfig): string {
  const base = normalizeBaseUrl(config.apiBaseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function imageUrl(id: string, config: CatalogProjectionConfig): string {
  return apiUrl(`/api/images/${encodeURIComponent(id)}`, config);
}

function catalogImages(
  collection: PublicCatalog,
  doc: CollectionDoc,
  config: CatalogProjectionConfig,
): string[] {
  const imageIds = normalizeCatalogImageIds(doc.imageIds);
  const bounded = collection === 'products' ? imageIds.slice(0, PRODUCT_IMAGE_MAX_COUNT) : imageIds;
  return bounded.map((id) => imageUrl(id, config));
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
  'manualCatalogPricing',
  'catalogPricingMode',
  // Alibaba-linked catalog fields (docs/alibaba-linked-catalog-sync, MIU 9).
  // Row path only: an approved product never ships these (ROW_ONLY_FIELDS in
  // `publicItem`). Ungated by design: anonymous and authenticated callers
  // receive IDENTICAL Alibaba pricing (never in GATED_CATALOG_FIELDS). alibabaPrimaryOfferKey
  // is deliberately absent. The nested pricing object is sub-projected below
  // — offer provenance never ships. Overstock rows can never carry these
  // keys (strict write schema), so the shared allowlist leaves overstock
  // payloads byte-identical.
  'alibabaPrimarySourceKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
] as const;

/**
 * Public sub-projection of `alibabaCatalogPricing` (R1 H1): the supplier
 * offer identifiers stay server-side — a visitor must not be able to locate
 * the source listing and buy direct.
 */
const ALIBABA_PRICING_PRIVATE_KEYS = ['sourceOfferKey', 'sourceProductId', 'sourceSkuId'] as const;

/**
 * The storefront only needs link-IDENTITY, never the key itself (review R2
 * #10): the stored value is sha256(supplier identifiers) and the input space
 * is small enough to brute-force offline, which would let a visitor locate
 * the source listing. Ship a constant marker instead.
 */
function publicAlibabaSourceKey(value: unknown): unknown {
  return typeof value === 'string' && value !== '' ? 'linked' : value;
}

function publicAlibabaCatalogPricing(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((ALIBABA_PRICING_PRIVATE_KEYS as readonly string[]).includes(key)) continue;
    out[key] = entry;
  }
  return out;
}

export interface PublicVariant {
  id: string;
  sku: string;
  optionValues: Record<string, string>;
  inventory?: number;
}

export function publicVariant(doc: CollectionDoc): PublicVariant {
  const options = doc.optionValues;
  const optionValues: Record<string, string> = {};
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const [name, value] of Object.entries(options)) {
      if (typeof value === 'string') optionValues[name] = value;
    }
  }
  const exact =
    doc.inventoryState === 'known' &&
    typeof doc.inventoryQuantity === 'number' &&
    Number.isSafeInteger(doc.inventoryQuantity) &&
    doc.inventoryQuantity >= 0;
  return {
    id: doc._id,
    sku: typeof doc.sku === 'string' ? doc.sku : '',
    optionValues,
    ...(exact ? { inventory: doc.inventoryQuantity as number } : {}),
  };
}
/**
 * Role-gated pricing tiers. Attached ONLY when the resolved viewer is entitled
 * (`canSeeVipPricing`). Never in `PUBLIC_CATALOG_FIELDS` — the anonymous path
 * must never ship these.
 */
const GATED_CATALOG_FIELDS = ['vipPrice'] as const;

/** Row fields that carry price or source state; never shipped for an approved product. */
const ROW_ONLY_FIELDS = new Set<string>([
  'unitPrice',
  'wholesalePrice',
  'clearancePrice',
  'moq',
  'manualCatalogPricing',
  'catalogPricingMode',
  'alibabaPrimarySourceKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
]);

/**
 * One product's public projection plus which version it came from. An approved
 * product shows its approved name, photos, description, price summary and MOQ;
 * row prices and Alibaba markers never ship for it, so a synced and a manual
 * product look the same (DEC-14).
 */
export function publicItem(
  collection: PublicCatalog,
  doc: CollectionDoc,
  config: CatalogProjectionConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): { doc: CollectionDoc; kind: 'approved' | 'row' } {
  const version =
    collection === 'products'
      ? resolvePublicVersion(doc, { detailEnabled: config.enableCatalogDetail === true })
      : ({ kind: 'row' } as const);
  if (version.kind === 'row')
    return { doc: publicDoc(collection, doc, config, viewer), kind: 'row' };
  const { header, priceSummary } = version.publication;
  const out: CollectionDoc = {
    _id: doc._id,
    name: header.name,
    images: header.images.slice(0, PRODUCT_IMAGE_MAX_COUNT).map((path) => apiUrl(path, config)),
  };
  for (const key of PUBLIC_CATALOG_FIELDS) {
    if (key === '_id' || key === 'name' || key === 'description' || key === 'category') continue;
    if (ROW_ONLY_FIELDS.has(key) || !(key in doc)) continue;
    out[key] = doc[key];
  }
  if (header.descriptionText) out.description = header.descriptionText;
  if (priceSummary) out.priceSummary = priceSummary;
  const moq = priceSummaryMoq(version.publication.priceSummary);
  if (moq !== undefined) out.moq = moq;
  const productFamily = productFamilyForDoc(doc);
  if (productFamily !== null) {
    out.productFamily = productFamily;
    if (productFamily === 'headphones' && typeof doc.category === 'string') {
      out.category = doc.category;
    }
  }
  const skuCode = normalizeSkuCode(doc.skuCode);
  const slug = normalizeProductSlug(doc.slug);
  if (skuCode !== null) out.skuCode = skuCode;
  if (slug !== null) out.slug = slug;
  return { doc: out, kind: 'approved' };
}

export function publicDoc(
  collection: PublicCatalog,
  doc: CollectionDoc,
  config: CatalogProjectionConfig,
  viewer: CatalogViewer = ANONYMOUS_VIEWER,
): CollectionDoc {
  // Constructed as a CollectionDoc with `_id` set unconditionally, so the
  // result is structurally guaranteed (no cast) — dropping `_id` from the
  // allowlist can never silently ship an id-less doc.
  const out: CollectionDoc = { _id: doc._id, images: catalogImages(collection, doc, config) };
  for (const key of PUBLIC_CATALOG_FIELDS) {
    if (key !== '_id' && key in doc) {
      if (collection === 'products' && key === 'category') continue;
      if (key === 'manualCatalogPricing') {
        const pricing = validateManualCatalogPricing(doc[key]);
        if (pricing.ok) out.manualCatalogPricing = pricing.value;
        continue;
      }
      out[key] =
        key === 'alibabaCatalogPricing'
          ? publicAlibabaCatalogPricing(doc[key])
          : key === 'alibabaPrimarySourceKey'
            ? publicAlibabaSourceKey(doc[key])
            : doc[key];
    }
  }
  if (collection === 'products') {
    const productFamily = productFamilyForDoc(doc);
    if (productFamily !== null) {
      out.productFamily = productFamily;
      if (productFamily === 'headphones' && typeof doc.category === 'string') {
        out.category = doc.category;
      }
    }
    const skuCode = normalizeSkuCode(doc.skuCode);
    const slug = normalizeProductSlug(doc.slug);
    if (skuCode !== null) out.skuCode = skuCode;
    if (slug !== null) out.slug = slug;
  }
  if (viewer.canSeeVipPricing) {
    for (const key of GATED_CATALOG_FIELDS) {
      if (key in doc) out[key] = doc[key];
    }
  }
  return out;
}
