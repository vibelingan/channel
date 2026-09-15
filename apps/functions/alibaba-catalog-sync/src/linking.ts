/**
 * Deterministic product linking + unpublished draft projection (MIU 7).
 *
 * `alibabaProductLinks._id = sourceKey` and revision-checked transactions enforce ONE
 * Channel product per source product under any concurrency; a Channel product
 * may aggregate several source products (DESIGN_CHARTER §9). No fuzzy
 * matching exists anywhere — links come from an explicit admin action or an
 * observed-source draft creation, and worker-created drafts are runtime-
 * verified `published: false` (synchronization invariant 1).
 */
import { createHash } from 'node:crypto';
import {
  type CatalogSourceObservation,
  type CatalogSourcePricing,
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import';
import {
  ALIBABA_PRODUCT_LINK_LIMIT,
  type AlibabaProductLinkIdentity,
  type AlibabaProductMutationInput,
  type AlibabaProductMutationResult,
  alibabaLinkRevision,
  list,
  mutateAlibabaProduct,
} from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  LEGACY_HEADPHONES_CATEGORY_OPTIONS,
  isProductFamily,
} from '@vibelingan-channel/shared';
import { listAllDocs } from './list-all.ts';
import { getDoc } from './repo.ts';

export interface LinkContext {
  now: string;
  userId?: string;
  resolveCategory?: ReturnType<typeof createAlibabaCategoryResolver>;
}

export type LinkResult =
  | { ok: true; sourceKey: string; productId: string; alreadyLinked: boolean }
  | Extract<AlibabaProductMutationResult, { ok: false }>;

type AlibabaProductIdentitySnapshot = Pick<
  AlibabaProductMutationInput,
  'productId' | 'expectedRevision' | 'expectedPrimarySourceKey' | 'expectedLinks'
>;

export async function snapshotAlibabaProductIdentity(
  product: CollectionDoc,
): Promise<
  | { ok: true; expectation: AlibabaProductIdentitySnapshot }
  | { ok: false; reason: 'identity-conflict' | 'link-limit' }
> {
  const expectedRevision = alibabaLinkRevision(product);
  const expectedPrimarySourceKey = product.alibabaPrimarySourceKey ?? null;
  if (
    expectedRevision === null ||
    expectedRevision === Number.MAX_SAFE_INTEGER ||
    (expectedPrimarySourceKey !== null && typeof expectedPrimarySourceKey !== 'string')
  )
    return { ok: false, reason: 'identity-conflict' };

  const links = await listAllDocs('alibabaProductLinks', [
    { field: 'productId', op: 'eq', value: product._id },
  ]);
  if (links.length > ALIBABA_PRODUCT_LINK_LIMIT) return { ok: false, reason: 'link-limit' };
  const expectedLinks: AlibabaProductLinkIdentity[] = [];
  for (const link of links) {
    const { _id, sourceKey, connectionId, sourceProductId, productId, linkedAt } = link;
    if (
      typeof sourceKey !== 'string' ||
      typeof connectionId !== 'string' ||
      typeof sourceProductId !== 'string' ||
      typeof productId !== 'string' ||
      typeof linkedAt !== 'string' ||
      [_id, sourceKey, connectionId, sourceProductId, productId, linkedAt].some(
        (value) => value.trim() === '',
      ) ||
      _id !== sourceKey ||
      productId !== product._id ||
      expectedLinks.some((expected) => expected._id === _id)
    )
      return { ok: false, reason: 'identity-conflict' };
    expectedLinks.push({ _id, sourceKey, connectionId, sourceProductId, productId, linkedAt });
  }
  return {
    ok: true,
    expectation: {
      productId: product._id,
      expectedRevision,
      expectedPrimarySourceKey,
      expectedLinks,
    },
  };
}

/** Explicit admin link of an EXISTING Channel product to a source product. */
export async function linkExistingProduct(
  sourceKey: string,
  productId: string,
  context: LinkContext,
): Promise<LinkResult> {
  const product = await getDoc('products', productId);
  if (!product) return { ok: false, reason: 'product-not-found' };
  const snapshot = await snapshotAlibabaProductIdentity(product);
  if (!snapshot.ok) return snapshot;
  const source = await getDoc('alibabaSourceProducts', sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };
  const observation = await loadAlibabaObservation(source);
  const result = await mutateAlibabaProduct({
    ...snapshot.expectation,
    action: 'link',
    sourceKey,
    linkedByUserId: context.userId ?? '',
    now: context.now,
    patch: {
      alibabaDescriptionImageUrls: observation?.content.description?.imageUrls ?? [],
      alibabaSourceImageUrls: Array.isArray(source.sourceImageUrls)
        ? source.sourceImageUrls.filter((value): value is string => typeof value === 'string')
        : [],
    },
  });
  if (!result.ok) return result;
  return { ok: true, sourceKey, productId, alreadyLinked: result.alreadyLinked === true };
}

export type UnlinkResult =
  | { ok: true; productId: string; clearedLinks: number }
  | Extract<AlibabaProductMutationResult, { ok: false }>;

/**
 * Explicit unlink: remove the link rows and clear ONLY the Alibaba-owned
 * product fields — legacy pricing was never touched, so the legacy rendering
 * path resumes immediately (COMPATIBILITY plan §4; the rollback command
 * shares this implementation and must never modify legacy fields).
 */
export async function unlinkProduct(
  productId: string,
  context: LinkContext,
): Promise<UnlinkResult> {
  const product = await getDoc('products', productId);
  if (!product) return { ok: false, reason: 'product-not-found' };
  const snapshot = await snapshotAlibabaProductIdentity(product);
  if (!snapshot.ok) return snapshot;
  const result = await mutateAlibabaProduct({
    ...snapshot.expectation,
    action: 'unlink',
    now: context.now,
  });
  if (!result.ok) return result;
  return { ok: true, productId, clearedLinks: result.clearedLinks };
}

export type DraftResult =
  | { ok: true; productId: string; created: boolean }
  | { ok: false; reason: 'source-not-found' | 'linked-elsewhere' };

type DraftMutationResult =
  | Extract<DraftResult, { ok: true }>
  | Extract<AlibabaProductMutationResult, { ok: false }>;

/**
 * Stable opaque id for the first Channel draft created from one source row.
 * The link remains the authority; the deterministic id only makes a retry or
 * concurrent materialization converge without leaving orphan draft products.
 */
export function draftProductId(sourceKey: string): string {
  const hex = createHash('sha256').update(`channel-product\0${sourceKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface AlibabaSourceReview {
  schemaVersion: 'alibaba-source-review-v1';
  provider: 'alibaba';
  externalProductId: string;
  sourceCategoryId?: string;
  sourceCategoryName?: string;
  sourceUpdatedAt?: string;
  sourceListingStatus: CatalogSourceObservation['lifecycle']['sourceListingStatus'];
  variantCount: number;
  offerCount: number;
  modelNumbers: string[];
  optionNames: string[];
  minimumOrderQuantity?: number;
  primaryPricing?: CatalogSourcePricing;
}

function normalizedOptionName(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^model (?:no|number)$/.test(normalized) || normalized === '型号') return 'model number';
  return normalized;
}

function minimumUnitAmount(pricing: CatalogSourcePricing): number | undefined {
  switch (pricing.mode) {
    case 'fixed':
      return pricing.amountMinor;
    case 'range':
      return pricing.minimumAmountMinor;
    case 'tiered':
      return Math.min(...pricing.tiers.map((tier) => tier.unitAmountMinor));
    default:
      return undefined;
  }
}

function pricingCurrency(pricing: CatalogSourcePricing): string | undefined {
  return 'currency' in pricing ? pricing.currency : undefined;
}

function primaryReviewPricing(
  offers: CatalogSourceObservation['offers'],
): CatalogSourcePricing | undefined {
  const priced = offers.filter((offer) => minimumUnitAmount(offer.pricing) !== undefined);
  if (priced.length > 0) {
    const currencies = [
      ...new Set(
        priced
          .map((offer) => pricingCurrency(offer.pricing))
          .filter((value): value is string => value !== undefined),
      ),
    ];
    currencies.sort((left, right) => {
      const rank = (value: string) => (value === 'USD' ? 0 : value === 'CNY' ? 1 : 2);
      return rank(left) - rank(right) || left.localeCompare(right);
    });
    const preferredCurrency = currencies[0];
    return [...priced]
      .filter((offer) => pricingCurrency(offer.pricing) === preferredCurrency)
      .sort(
        (left, right) =>
          (minimumUnitAmount(left.pricing) ?? Number.MAX_SAFE_INTEGER) -
            (minimumUnitAmount(right.pricing) ?? Number.MAX_SAFE_INTEGER) ||
          left.sourceOfferKey.localeCompare(right.sourceOfferKey),
      )[0]?.pricing;
  }
  return [...offers].sort((left, right) => {
    const rank = (pricing: CatalogSourcePricing) =>
      pricing.mode === 'negotiable' ? 0 : pricing.mode === 'unavailable' ? 1 : 2;
    return (
      rank(left.pricing) - rank(right.pricing) ||
      left.sourceOfferKey.localeCompare(right.sourceOfferKey)
    );
  })[0]?.pricing;
}

export function buildAlibabaSourceReview(
  observation: CatalogSourceObservation,
): AlibabaSourceReview {
  const optionNames = new Set<string>();
  const modelNumbers = new Map<string, string>();
  for (const variant of observation.variants) {
    for (const option of variant.options) {
      const name = normalizedOptionName(option.sourceName);
      if (name !== '') optionNames.add(name);
      if (name === 'model number') {
        const value = String(option.value).trim();
        if (value !== '') modelNumbers.set(value.toLocaleLowerCase('en-US'), value);
      }
    }
  }
  const minimumOrderQuantities = observation.offers
    .map((offer) => offer.pricing.minimumOrderQuantity)
    .filter((value): value is number => typeof value === 'number');
  const primaryPricing = primaryReviewPricing(observation.offers);
  const sourceCategoryId = observation.identity.category?.sourceCategoryId;
  const sourceCategoryName = observation.identity.category?.sourceCategoryName;
  return {
    schemaVersion: 'alibaba-source-review-v1',
    provider: 'alibaba',
    externalProductId: observation.source.externalProductId ?? '',
    ...(sourceCategoryId === undefined ? {} : { sourceCategoryId }),
    ...(sourceCategoryName === undefined ? {} : { sourceCategoryName }),
    ...(observation.source.sourceUpdatedAt === undefined
      ? {}
      : { sourceUpdatedAt: observation.source.sourceUpdatedAt }),
    sourceListingStatus: observation.lifecycle.sourceListingStatus,
    variantCount: observation.variants.length,
    offerCount: observation.offers.length,
    modelNumbers: [...modelNumbers.values()].sort((left, right) => left.localeCompare(right)),
    optionNames: [...optionNames].sort((left, right) => left.localeCompare(right)),
    ...(minimumOrderQuantities.length === 0
      ? {}
      : { minimumOrderQuantity: Math.min(...minimumOrderQuantities) }),
    ...(primaryPricing === undefined ? {} : { primaryPricing }),
  };
}

export async function loadAlibabaObservation(
  source: Record<string, unknown> & { _id: string },
): Promise<CatalogSourceObservation | null> {
  const observationDoc = await getDoc(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', source._id),
  );
  const validated = validateCatalogSourceObservation(observationDoc?.observation);
  return validated.ok &&
    validated.value.source.provider === 'alibaba' &&
    validated.value.source.sourceProductKey === source._id
    ? validated.value
    : null;
}

export async function loadAlibabaSourceReview(
  source: Record<string, unknown> & { _id: string },
): Promise<AlibabaSourceReview | null> {
  const observation = await loadAlibabaObservation(source);
  return observation === null ? null : buildAlibabaSourceReview(observation);
}

async function reconcileLinkedDraft(
  expectation: AlibabaProductIdentitySnapshot,
  source: Record<string, unknown> & { _id: string },
  observation: CatalogSourceObservation | null,
  now: string,
): Promise<DraftMutationResult> {
  const patch: Record<string, unknown> = {
    alibabaDescriptionImageUrls: observation?.content.description?.imageUrls ?? [],
    ...(observation === null ? {} : { alibabaSourceReview: buildAlibabaSourceReview(observation) }),
  };
  const result = await mutateAlibabaProduct({
    ...expectation,
    action: 'reconcile',
    sourceKey: source._id,
    patch,
    now,
  });
  return result.ok ? { ok: true, productId: expectation.productId, created: false } : result;
}

async function mappedCategory(sourceCategoryId: string): Promise<{
  productFamily?: string;
  channelCategory?: string;
}> {
  if (sourceCategoryId === '') return {};

  // New provider-neutral mapping is authoritative when present.
  const common = await list({
    collection: 'sourceCategoryMappings',
    page: 1,
    pageSize: 2,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'provider', op: 'eq', value: 'alibaba' },
        { field: 'sourceTaxonomy', op: 'eq', value: 'alibaba:icbu' },
        { field: 'sourceCategoryId', op: 'eq', value: sourceCategoryId },
      ],
    },
  });
  const commonMapping = common.items[0];
  if (common.items.length > 0 || common.total > 0) {
    if (
      common.total !== 1 ||
      !commonMapping ||
      commonMapping.reviewRequired === true ||
      !isProductFamily(commonMapping.productFamily)
    )
      return {};
    return {
      productFamily: commonMapping.productFamily,
      ...(commonMapping.productFamily === 'headphones' &&
      typeof commonMapping.channelCategory === 'string' &&
      LEGACY_HEADPHONES_CATEGORY_OPTIONS.some((value) => value === commonMapping.channelCategory)
        ? { channelCategory: commonMapping.channelCategory }
        : {}),
    };
  }

  // Compatibility with the original Alibaba-only headphones mapping.
  const legacy = await list({
    collection: 'alibabaCategoryMappings',
    page: 1,
    pageSize: 2,
    filter: {
      combinator: 'and',
      clauses: [{ field: 'alibabaCategoryId', op: 'eq', value: sourceCategoryId }],
    },
  });
  const legacyMapping = legacy.items[0];
  return legacy.total === 1 &&
    typeof legacyMapping?.channelCategory === 'string' &&
    LEGACY_HEADPHONES_CATEGORY_OPTIONS.some((value) => value === legacyMapping.channelCategory)
    ? { productFamily: 'headphones', channelCategory: legacyMapping.channelCategory }
    : {};
}

/** One lookup per distinct category per batch; no cross-run stale cache. */
export function createAlibabaCategoryResolver() {
  const cache = new Map<string, ReturnType<typeof mappedCategory>>();
  return (categoryId: string) => {
    let result = cache.get(categoryId);
    if (!result) {
      result = mappedCategory(categoryId);
      cache.set(categoryId, result);
    }
    return result;
  };
}

/**
 * Create an UNPUBLISHED draft for every observed source product. Category
 * mapping enriches the draft but is no longer a visibility gate: an unmapped
 * product remains visible under "All products" and publication validation
 * still requires an operator-chosen family. Never fuzzy-map, auto-publish, or
 * auto-import media.
 *
 * Product creation and claim repair share one transaction and product revision.
 * Existing claims are compared exactly before repair; no standalone claim is written.
 */
export async function createDraftForSource(
  sourceKey: string,
  context: LinkContext,
): Promise<DraftResult> {
  const result = await materializeDraftForSource(sourceKey, context);
  return result.ok
    ? result
    : {
        ok: false,
        reason: result.reason === 'source-not-found' ? 'source-not-found' : 'linked-elsewhere',
      };
}

async function materializeDraftForSource(
  sourceKey: string,
  context: LinkContext,
): Promise<DraftMutationResult> {
  const proposedProductId = draftProductId(sourceKey);

  const claim = await getDoc('alibabaProductLinks', sourceKey);
  let expectedClaim: AlibabaProductLinkIdentity | null = null;
  if (claim) {
    const {
      _id,
      sourceKey: claimedSourceKey,
      connectionId,
      sourceProductId,
      productId,
      linkedAt,
    } = claim;
    if (
      claimedSourceKey !== sourceKey ||
      _id !== sourceKey ||
      typeof connectionId !== 'string' ||
      connectionId.trim() === '' ||
      typeof sourceProductId !== 'string' ||
      sourceProductId.trim() === '' ||
      typeof productId !== 'string' ||
      (productId !== '' && productId.trim() === '') ||
      typeof linkedAt !== 'string' ||
      linkedAt.trim() === ''
    )
      return { ok: false, reason: 'identity-conflict' };
    expectedClaim = {
      _id,
      sourceKey: claimedSourceKey,
      connectionId,
      sourceProductId,
      productId,
      linkedAt,
    };
  }
  const productId = expectedClaim?.productId || proposedProductId;
  const product = await getDoc('products', productId);
  const snapshot = await snapshotAlibabaProductIdentity(product ?? { _id: productId });
  if (!snapshot.ok) return snapshot;
  const source = await getDoc('alibabaSourceProducts', sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };
  const observation = await loadAlibabaObservation(source);
  if (product && expectedClaim?.productId === productId) {
    return reconcileLinkedDraft(snapshot.expectation, source, observation, context.now);
  }
  const category = await (context.resolveCategory ?? createAlibabaCategoryResolver())(
    String(source.sourceCategoryId ?? ''),
  );
  const result = await createLinkedDraft(
    source,
    {
      ...snapshot.expectation,
      expectedRevision: product ? snapshot.expectation.expectedRevision : null,
    },
    expectedClaim,
    category,
    observation,
    context.now,
  );
  if (!result.ok && result.reason === 'identity-conflict' && product === null) {
    const winner = await getDoc('products', productId);
    const winnerClaim = await getDoc('alibabaProductLinks', sourceKey);
    if (
      winner?.alibabaPrimarySourceKey === sourceKey &&
      alibabaLinkRevision(winner) === 1 &&
      winnerClaim?.productId === productId &&
      winnerClaim.sourceKey === sourceKey &&
      winnerClaim.connectionId === source.connectionId &&
      winnerClaim.sourceProductId === source.sourceProductId
    ) {
      return { ok: true, productId, created: false };
    }
  }
  return result;
}

async function createLinkedDraft(
  source: Record<string, unknown> & { _id: string },
  expectation: AlibabaProductIdentitySnapshot,
  expectedClaim: AlibabaProductLinkIdentity | null,
  category: { productFamily?: string; channelCategory?: string },
  observation: CatalogSourceObservation | null,
  now: string,
): Promise<DraftMutationResult> {
  const observedTitle = observation?.identity.title;
  const observedDescription = observation?.content.description?.text;

  const draft: Record<string, unknown> = {
    alibabaDescriptionImageUrls: observation?.content.description?.imageUrls ?? [],
    name:
      typeof observedTitle === 'string' && observedTitle.trim() !== ''
        ? observedTitle
        : typeof source.sourceTitle === 'string' && source.sourceTitle.trim() !== ''
          ? source.sourceTitle
          : `Alibaba product ${String(source.sourceProductId ?? '')}`,
    ...(typeof observedDescription === 'string' && observedDescription.trim() !== ''
      ? { description: observedDescription }
      : {}),
    ...(category.productFamily === undefined
      ? {}
      : {
          productFamily: category.productFamily,
          alibabaClassifiedCategoryId: String(source.sourceCategoryId ?? ''),
        }),
    ...(category.channelCategory === undefined ? {} : { category: category.channelCategory }),
    published: false,
    archived: false,
    alibabaPrimarySourceKey: source._id,
    alibabaSourceProductId: String(source.sourceProductId ?? ''),
    alibabaSourceCategoryId: String(source.sourceCategoryId ?? ''),
    alibabaSourceImageUrls: Array.isArray(source.sourceImageUrls)
      ? source.sourceImageUrls.filter((value): value is string => typeof value === 'string')
      : [],
    alibabaSourceStatus: source.active === true ? 'available' : 'removed',
    alibabaSourceLastSyncedAt: now,
    alibabaReviewPending: true,
    ...(observation === null ? {} : { alibabaSourceReview: buildAlibabaSourceReview(observation) }),
    createdAt: now,
    updatedAt: now,
  };
  // Runtime invariant, not just a default: the worker can never publish.
  if (draft.published !== false) throw new Error('draft must be unpublished');
  const result = await mutateAlibabaProduct({
    ...expectation,
    action: 'create-draft',
    sourceKey: source._id,
    expectedClaim,
    draft,
    now,
  });
  return result.ok
    ? { ok: true, productId: expectation.productId, created: result.created === true }
    : result;
}

export type SetPinnedOfferResult =
  | { ok: true; productId: string; pinnedOfferKey: string }
  | Extract<AlibabaProductMutationResult, { ok: false }>;

/**
 * Operator pin for ARCHITECTURE §5 rule 1 (MIU_BREAKDOWN R1 L4). The field is
 * readOnly in generic CRUD, so this action is its ONLY write path.
 *
 * The pin is validated against the product's OWN primary source: pinning an
 * offer from another supplier product would silently materialize a price that
 * belongs to a different listing. An empty offerKey clears the pin and hands
 * selection back to §5's total order.
 */
export async function setPinnedOffer(input: {
  productId: string;
  offerKey: string;
  now: string;
}): Promise<SetPinnedOfferResult> {
  const product = await getDoc('products', input.productId);
  if (!product) return { ok: false, reason: 'product-not-found' };
  const sourceKey =
    typeof product.alibabaPrimarySourceKey === 'string' ? product.alibabaPrimarySourceKey : '';
  if (sourceKey === '') return { ok: false, reason: 'not-linked' };

  const snapshot = await snapshotAlibabaProductIdentity(product);
  if (!snapshot.ok) return snapshot;
  const result = await mutateAlibabaProduct({
    ...snapshot.expectation,
    action: 'pin',
    sourceKey,
    offerKey: input.offerKey,
    now: input.now,
  });
  if (!result.ok) return result;
  return { ok: true, productId: input.productId, pinnedOfferKey: input.offerKey };
}
