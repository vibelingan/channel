/**
 * Grouping: store-scoped source listings in, product and variant candidates
 * out.
 *
 * The shape of the problem, in the merchant's own nouns: the workbook has one
 * line per SKU per shop. Four shops selling the same earbud produce four
 * lines. The website needs ONE product with ONE variant, while the operator
 * still needs to see what each shop reported — its own price, its own stock,
 * its own marketplace listing id.
 *
 * So this file collapses on identity and keeps provenance beside it, rather
 * than choosing between them:
 *
 *   same normalized parent SKU  -> one product candidate
 *   same normalized SKU         -> one variant candidate
 *   each (store, SKU) line      -> one store-listing record, kept whole
 *
 * Nothing provider-specific appears here. A Shopify or Lazada adapter that
 * produces `SourceListing` values reuses this logic unchanged.
 */
import type {
  CandidateCategory,
  CandidateMedia,
  CatalogProductCandidate,
  CatalogProvider,
  CatalogVariantCandidate,
  DescriptionProvenance,
  ImportFinding,
  InventorySnapshot,
  MatchHints,
  Money,
} from './contracts.ts';
import { FINDING_CODES, errorFinding, warningFinding } from './findings.ts';
import {
  candidateGroupKey,
  candidateSkuKey,
  normalizeIdentifier,
  normalizeStoreKey,
  sourceProductKey,
  sourceVariantKey,
} from './identity.ts';
import { type InventoryResolution, reconcileInventory } from './inventory.ts';

/** One provider row: a single SKU as one store reported it. */
export interface SourceListing {
  rowNumber: number;
  provider: CatalogProvider;
  /** Provider-side channel the listing belongs to, e.g. `lazada`. */
  taxonomy: string;
  storeKey: string;
  parentSku: string;
  sku: string;
  title: string;
  brand?: string;
  descriptionHtml?: string;
  descriptionText?: string;
  /** Which rung of the fallback chain supplied `descriptionText`. */
  descriptionSource?: DescriptionProvenance;
  attributes: Record<string, string | number | boolean>;
  optionValues: Record<string, string>;
  category?: CandidateCategory;
  /** Product-level images this store listed, in order. */
  productMedia: string[];
  /** A variant-specific image, when the source distinguishes one. */
  variantMedia?: string;
  sourceRegularPrice?: Money;
  sourcePromotionPrice?: Money;
  /** Absent when the store reported no usable quantity. */
  quantity?: number;
  externalProductId?: string;
  externalVariantId?: string;
  sourceListingStatus: 'published' | 'draft' | 'missing' | 'unknown';
  capturedAt?: string;
}

/**
 * One store's listing of one variant, preserved verbatim. This is what later
 * becomes a `catalogSourceLinks` row, and it is why collapsing four shop lines
 * into one variant loses nothing.
 */
export interface StoreListingRecord {
  rowNumber: number;
  provider: CatalogProvider;
  taxonomy: string;
  storeKey: string;
  sourceProductKey: string;
  sourceVariantKey: string;
  candidateGroupKey: string;
  candidateSkuKey: string;
  parentSku: string;
  sku: string;
  externalProductId?: string;
  externalVariantId?: string;
  sourceListingStatus: SourceListing['sourceListingStatus'];
  sourceRegularPrice?: Money;
  sourcePromotionPrice?: Money;
  quantity?: number;
  capturedAt?: string;
}

/** A variant withheld from the catalog because its identity is contradictory. */
export interface QuarantinedVariant {
  candidateSkuKey: string;
  sku: string;
  reason: 'parent-conflict' | 'brand-conflict';
  /** The competing values, for the operator to adjudicate. */
  values: string[];
  rowNumbers: number[];
}

export interface VariantInventory {
  candidateSkuKey: string;
  resolution: InventoryResolution;
}

export interface GroupingResult {
  products: CatalogProductCandidate[];
  storeListings: StoreListingRecord[];
  quarantined: QuarantinedVariant[];
  /** Reconciled inventory per canonical SKU, including conflicts. */
  inventory: VariantInventory[];
  findings: ImportFinding[];
}

interface VariantAccumulator {
  candidateSkuKey: string;
  sku: string;
  groupKeys: Map<string, number[]>;
  brands: Map<string, number[]>;
  optionValues: Record<string, string>;
  snapshots: InventorySnapshot[];
  media: string[];
  firstRow: number;
  regularPrice?: Money;
  promotionPrice?: Money;
  matchHints: MatchHints;
  externalVariantId?: string;
}

interface ProductAccumulator {
  candidateGroupKey: string;
  parentSku: string;
  title: string;
  // Written with `undefined` while accumulating (exactOptionalPropertyTypes
  // forbids assigning undefined to an optional property); the emitted
  // candidate omits the key entirely instead.
  brand: string | undefined;
  descriptionHtml: string | undefined;
  descriptionText: string | undefined;
  descriptionSource: DescriptionProvenance | undefined;
  attributes: Record<string, string | number | boolean>;
  category?: CandidateCategory;
  media: string[];
  variantKeys: string[];
  firstRow: number;
  externalProductId: string | undefined;
  /** Most-available status wins: one live store listing makes the family live. */
  statuses: Set<SourceListing['sourceListingStatus']>;
}

/**
 * Product-level fields come from the FIRST row that supplies a non-empty
 * value, in workbook order. Deterministic and explainable ("row 12 is where
 * the title came from") beats any cleverer merge that an operator cannot
 * predict or audit.
 */
function firstNonEmpty(current: string | undefined, next: string | undefined): string | undefined {
  if (current !== undefined && current !== '') return current;
  return next !== undefined && next !== '' ? next : current;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (value !== '' && !target.includes(value)) target.push(value);
  }
}

function mediaFor(urls: readonly string[], variantSku?: string): CandidateMedia[] {
  return urls.map((sourceUrl, position) => ({
    sourceUrl,
    role:
      variantSku !== undefined
        ? ('variant' as const)
        : position === 0
          ? ('primary' as const)
          : ('gallery' as const),
    position,
    ...(variantSku === undefined ? {} : { variantSku }),
  }));
}

/** The most available status across a family's store listings. */
function resolveStatus(
  statuses: ReadonlySet<SourceListing['sourceListingStatus']>,
): CatalogProductCandidate['sourceListingStatus'] {
  if (statuses.has('published')) return 'published';
  if (statuses.has('draft')) return 'draft';
  if (statuses.has('missing')) return 'missing';
  return 'unknown';
}

/**
 * Collapse store-scoped listings into product and variant candidates.
 *
 * Rows whose identity cannot be normalized are dropped with a finding; rows
 * whose identity CONTRADICTS another row's are quarantined rather than merged,
 * because guessing which parent SKU is right would silently move a variant
 * onto the wrong product page.
 */
export function groupListings(listings: readonly SourceListing[]): GroupingResult {
  const findings: ImportFinding[] = [];
  const variants = new Map<string, VariantAccumulator>();
  const products = new Map<string, ProductAccumulator>();
  const storeListings: StoreListingRecord[] = [];
  const seenStoreVariants = new Set<string>();

  for (const listing of listings) {
    const groupKey = candidateGroupKey(listing.provider, listing.parentSku);
    const skuKey = candidateSkuKey(listing.provider, listing.sku);
    const productKey = sourceProductKey({
      provider: listing.provider,
      taxonomy: listing.taxonomy,
      store: listing.storeKey,
      value: listing.parentSku,
    });
    const variantKey = sourceVariantKey({
      provider: listing.provider,
      taxonomy: listing.taxonomy,
      store: listing.storeKey,
      value: listing.sku,
    });
    if (groupKey === null || skuKey === null || productKey === null || variantKey === null) {
      findings.push(
        errorFinding(
          groupKey === null ? FINDING_CODES.ROW_MISSING_PARENT_SKU : FINDING_CODES.ROW_MISSING_SKU,
          'Row identity could not be normalized to a stable key.',
          { rowNumber: listing.rowNumber },
        ),
      );
      continue;
    }

    // The same (store, SKU) twice is a duplicated export line. The first wins;
    // the second is reported so the merchant can fix the export rather than
    // having its price silently overwrite the first.
    if (seenStoreVariants.has(variantKey)) {
      findings.push(
        warningFinding(
          FINDING_CODES.ROW_DUPLICATE_STORE_VARIANT,
          `Store ${JSON.stringify(listing.storeKey)} lists SKU ${JSON.stringify(listing.sku)} more than once; only the first line was used.`,
          { rowNumber: listing.rowNumber, parentSku: listing.parentSku, sku: listing.sku },
        ),
      );
      continue;
    }
    seenStoreVariants.add(variantKey);

    storeListings.push({
      rowNumber: listing.rowNumber,
      provider: listing.provider,
      taxonomy: listing.taxonomy,
      storeKey: listing.storeKey,
      sourceProductKey: productKey,
      sourceVariantKey: variantKey,
      candidateGroupKey: groupKey,
      candidateSkuKey: skuKey,
      parentSku: listing.parentSku,
      sku: listing.sku,
      sourceListingStatus: listing.sourceListingStatus,
      ...(listing.externalProductId === undefined
        ? {}
        : { externalProductId: listing.externalProductId }),
      ...(listing.externalVariantId === undefined
        ? {}
        : { externalVariantId: listing.externalVariantId }),
      ...(listing.sourceRegularPrice === undefined
        ? {}
        : { sourceRegularPrice: listing.sourceRegularPrice }),
      ...(listing.sourcePromotionPrice === undefined
        ? {}
        : { sourcePromotionPrice: listing.sourcePromotionPrice }),
      ...(listing.quantity === undefined ? {} : { quantity: listing.quantity }),
      ...(listing.capturedAt === undefined ? {} : { capturedAt: listing.capturedAt }),
    });

    // --- variant ---------------------------------------------------------
    let variant = variants.get(skuKey);
    if (variant === undefined) {
      variant = {
        candidateSkuKey: skuKey,
        sku: listing.sku,
        groupKeys: new Map(),
        brands: new Map(),
        optionValues: {},
        snapshots: [],
        media: [],
        firstRow: listing.rowNumber,
        matchHints: { sku: listing.sku, parentSku: listing.parentSku },
      };
      variants.set(skuKey, variant);
    }
    variant.groupKeys.set(groupKey, [
      ...(variant.groupKeys.get(groupKey) ?? []),
      listing.rowNumber,
    ]);
    const normalizedBrand = normalizeIdentifier(listing.brand);
    if (normalizedBrand !== null) {
      variant.brands.set(normalizedBrand, [
        ...(variant.brands.get(normalizedBrand) ?? []),
        listing.rowNumber,
      ]);
    }
    variant.optionValues = { ...listing.optionValues, ...variant.optionValues };
    if (listing.quantity !== undefined) {
      variant.snapshots.push({
        quantity: listing.quantity,
        semantics: 'unknown',
        ...(normalizeStoreKey(listing.storeKey) === null ? {} : { storeKey: listing.storeKey }),
        ...(listing.capturedAt === undefined ? {} : { capturedAt: listing.capturedAt }),
      });
    }
    if (listing.variantMedia !== undefined) appendUnique(variant.media, [listing.variantMedia]);
    if (variant.regularPrice === undefined && listing.sourceRegularPrice !== undefined) {
      variant.regularPrice = listing.sourceRegularPrice;
    }
    if (variant.promotionPrice === undefined && listing.sourcePromotionPrice !== undefined) {
      variant.promotionPrice = listing.sourcePromotionPrice;
    }
    if (variant.externalVariantId === undefined && listing.externalVariantId !== undefined) {
      variant.externalVariantId = listing.externalVariantId;
    }
    if (variant.matchHints.brand === undefined && listing.brand !== undefined) {
      variant.matchHints = { ...variant.matchHints, brand: listing.brand };
    }

    // --- product ---------------------------------------------------------
    let product = products.get(groupKey);
    if (product === undefined) {
      product = {
        candidateGroupKey: groupKey,
        parentSku: listing.parentSku,
        title: listing.title,
        brand: undefined,
        descriptionHtml: undefined,
        descriptionText: undefined,
        descriptionSource: undefined,
        externalProductId: undefined,
        attributes: {},
        media: [],
        variantKeys: [],
        firstRow: listing.rowNumber,
        statuses: new Set(),
      };
      products.set(groupKey, product);
    }
    product.title = firstNonEmpty(product.title, listing.title) ?? listing.title;
    product.brand = firstNonEmpty(product.brand, listing.brand);
    const previousDescription = product.descriptionText;
    product.descriptionHtml = firstNonEmpty(product.descriptionHtml, listing.descriptionHtml);
    product.descriptionText = firstNonEmpty(product.descriptionText, listing.descriptionText);
    // Keep the provenance attached to the row the copy actually came from; a
    // stale label would tell a reviewer the text was authored when it was
    // generated, which is the one thing this field exists to prevent.
    if (
      previousDescription !== product.descriptionText ||
      product.descriptionSource === undefined
    ) {
      product.descriptionSource = listing.descriptionSource;
    }
    product.externalProductId = firstNonEmpty(product.externalProductId, listing.externalProductId);
    if (product.category === undefined && listing.category !== undefined) {
      product.category = listing.category;
    }
    product.attributes = { ...listing.attributes, ...product.attributes };
    appendUnique(product.media, listing.productMedia);
    product.statuses.add(listing.sourceListingStatus);
    if (!product.variantKeys.includes(skuKey)) product.variantKeys.push(skuKey);
  }

  // --- quarantine contradictory variants ---------------------------------
  const quarantined: QuarantinedVariant[] = [];
  for (const variant of variants.values()) {
    if (variant.groupKeys.size > 1) {
      const rowNumbers = [...variant.groupKeys.values()].flat().sort((a, b) => a - b);
      quarantined.push({
        candidateSkuKey: variant.candidateSkuKey,
        sku: variant.sku,
        reason: 'parent-conflict',
        values: [...variant.groupKeys.keys()],
        rowNumbers,
      });
      findings.push(
        errorFinding(
          FINDING_CODES.VARIANT_PARENT_CONFLICT,
          `SKU ${JSON.stringify(variant.sku)} is listed under ${variant.groupKeys.size} different parent SKUs (${[...variant.groupKeys.keys()].join(', ')}); it was withheld rather than attached to one of them.`,
          { rowNumber: rowNumbers[0] as number, sku: variant.sku },
        ),
      );
      continue;
    }
    if (variant.brands.size > 1) {
      const rowNumbers = [...variant.brands.values()].flat().sort((a, b) => a - b);
      quarantined.push({
        candidateSkuKey: variant.candidateSkuKey,
        sku: variant.sku,
        reason: 'brand-conflict',
        values: [...variant.brands.keys()],
        rowNumbers,
      });
      findings.push(
        errorFinding(
          FINDING_CODES.VARIANT_BRAND_CONFLICT,
          `SKU ${JSON.stringify(variant.sku)} carries different brands across stores (${[...variant.brands.keys()].join(', ')}); it was withheld for review.`,
          { rowNumber: rowNumbers[0] as number, sku: variant.sku },
        ),
      );
    }
  }
  const quarantinedKeys = new Set(quarantined.map((entry) => entry.candidateSkuKey));

  // --- reconcile inventory ------------------------------------------------
  const inventory: VariantInventory[] = [];
  for (const variant of variants.values()) {
    if (quarantinedKeys.has(variant.candidateSkuKey)) continue;
    const resolution = reconcileInventory(variant.snapshots);
    inventory.push({ candidateSkuKey: variant.candidateSkuKey, resolution });
    if (resolution.state === 'conflict') {
      findings.push(
        errorFinding(
          FINDING_CODES.INVENTORY_CONFLICT,
          `Stores report different stock for SKU ${JSON.stringify(variant.sku)} (${resolution.quantities.join(', ')}); no count was chosen and none was summed.`,
          { rowNumber: variant.firstRow, sku: variant.sku },
        ),
      );
    } else if (resolution.state === 'unknown') {
      findings.push(
        warningFinding(
          FINDING_CODES.INVENTORY_UNKNOWN,
          `No store reported usable stock for SKU ${JSON.stringify(variant.sku)}; inventory is unknown.`,
          { rowNumber: variant.firstRow, sku: variant.sku },
        ),
      );
    }
  }

  // --- assemble candidates ------------------------------------------------
  const orderedProducts = [...products.values()].sort((a, b) => a.firstRow - b.firstRow);
  const result: CatalogProductCandidate[] = [];

  for (const product of orderedProducts) {
    const keptVariantKeys = product.variantKeys.filter((key) => !quarantinedKeys.has(key));
    if (keptVariantKeys.length === 0) continue;

    const provider = listings[0]?.provider ?? 'dianxiaomi';
    const variantCandidates: CatalogVariantCandidate[] = [];
    for (const key of keptVariantKeys) {
      const variant = variants.get(key);
      if (variant === undefined) continue;
      const resolved = inventory.find((entry) => entry.candidateSkuKey === key);
      variantCandidates.push({
        identity: {
          provider,
          sourceProductKey: product.candidateGroupKey,
          sourceVariantKey: variant.candidateSkuKey,
          ...(variant.externalVariantId === undefined
            ? {}
            : { externalVariantId: variant.externalVariantId }),
        },
        matchHints: variant.matchHints,
        sku: variant.sku,
        optionValues: variant.optionValues,
        inventory: resolved?.resolution.snapshots ?? [],
        media: mediaFor(variant.media, variant.sku),
        ...(variant.regularPrice === undefined ? {} : { sourceRegularPrice: variant.regularPrice }),
        ...(variant.promotionPrice === undefined
          ? {}
          : { sourcePromotionPrice: variant.promotionPrice }),
      });
    }

    result.push({
      identity: {
        provider,
        sourceProductKey: product.candidateGroupKey,
        ...(product.externalProductId === undefined
          ? {}
          : { externalProductId: product.externalProductId }),
      },
      matchHints: {
        parentSku: product.parentSku,
        ...(product.brand === undefined ? {} : { brand: product.brand }),
      },
      parentSku: product.parentSku,
      title: product.title,
      attributes: product.attributes,
      media: mediaFor(product.media),
      variants: variantCandidates,
      sourceListingStatus: resolveStatus(product.statuses),
      ...(product.brand === undefined ? {} : { brand: product.brand }),
      ...(product.descriptionHtml === undefined
        ? {}
        : { descriptionHtml: product.descriptionHtml }),
      ...(product.descriptionText === undefined
        ? {}
        : { descriptionText: product.descriptionText }),
      ...(product.descriptionSource === undefined
        ? {}
        : { descriptionSource: product.descriptionSource }),
      ...(product.category === undefined ? {} : { category: product.category }),
    });
  }

  return { products: result, storeListings, quarantined, inventory, findings };
}

export interface GroupingCounts {
  rows: number;
  parentSkus: number;
  skus: number;
  storeProducts: number;
  storeVariants: number;
  stores: number;
  uniqueImageUrls: number;
  imageReferences: number;
  /** Distinct marketplace product ids across the file. */
  marketplaceIds: number;
  /** Rows that carry a marketplace product id. */
  rowsWithMarketplaceId: number;
  /**
   * SKUs listed by more than one store. This is the population the inventory
   * reconciliation rule exists for, so it belongs in the summary rather than
   * being inferred from the gap between `skus` and `storeVariants`.
   */
  skusInMultipleStores: number;
}

/**
 * The cardinalities used for local acceptance. They are counted from the
 * LISTINGS rather than from the candidates so that quarantined and rejected
 * items still appear in the totals — a summary that only counts what
 * succeeded cannot be reconciled against the workbook.
 */
export function countListings(listings: readonly SourceListing[]): GroupingCounts {
  const parentSkus = new Set<string>();
  const skus = new Set<string>();
  const storeProducts = new Set<string>();
  const storeVariants = new Set<string>();
  const stores = new Set<string>();
  const images = new Set<string>();
  const marketplaceIds = new Set<string>();
  const storesPerSku = new Map<string, Set<string>>();
  let imageReferences = 0;
  let rowsWithMarketplaceId = 0;

  for (const listing of listings) {
    const group = candidateGroupKey(listing.provider, listing.parentSku);
    const sku = candidateSkuKey(listing.provider, listing.sku);
    const store = normalizeStoreKey(listing.storeKey);
    if (group !== null) parentSkus.add(group);
    if (sku !== null) skus.add(sku);
    if (store !== null) stores.add(store);
    if (group !== null) storeProducts.add(`${store ?? ''}|${group}`);
    if (sku !== null) {
      storeVariants.add(`${store ?? ''}|${sku}`);
      storesPerSku.set(sku, (storesPerSku.get(sku) ?? new Set()).add(store ?? ''));
    }
    if (listing.externalProductId !== undefined && listing.externalProductId !== '') {
      marketplaceIds.add(listing.externalProductId);
      rowsWithMarketplaceId += 1;
    }
    for (const url of listing.productMedia) {
      images.add(url);
      imageReferences += 1;
    }
    if (listing.variantMedia !== undefined) {
      images.add(listing.variantMedia);
      imageReferences += 1;
    }
  }

  return {
    rows: listings.length,
    parentSkus: parentSkus.size,
    skus: skus.size,
    storeProducts: storeProducts.size,
    storeVariants: storeVariants.size,
    stores: stores.size,
    uniqueImageUrls: images.size,
    imageReferences,
    marketplaceIds: marketplaceIds.size,
    rowsWithMarketplaceId,
    skusInMultipleStores: [...storesPerSku.values()].filter((set) => set.size > 1).length,
  };
}

/**
 * Everything one parse produces: the normative bundle plus the store-scoped
 * provenance, reconciliation and counts that persistence and preview need.
 *
 * Kept separate from `CatalogImportBundle` on purpose — that type is the
 * normative contract and stays exactly as specified. This is a
 * provider-neutral envelope around it, so a future connector returns the same
 * shape rather than inventing a parallel one.
 */
export interface CatalogImportDetail {
  bundle: import('./contracts.ts').CatalogImportBundle;
  storeListings: StoreListingRecord[];
  inventory: VariantInventory[];
  quarantined: QuarantinedVariant[];
  counts: GroupingCounts;
  /** Header labels exactly as the source spelled them, for calibration. */
  templateHeaders: string[];
  sheetName: string;
  /** Data rows the source contained, including rows that were rejected. */
  dataRowCount: number;
  /** False when the source could not be interpreted at all. */
  structurallyValid: boolean;
}
