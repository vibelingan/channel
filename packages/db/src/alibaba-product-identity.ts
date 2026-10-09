import {
  type CollectionDoc,
  PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  PRODUCT_IMAGE_MAX_COUNT,
  alibabaPhotoSources,
} from '@vibelingan-channel/shared';
import {
  createAlibabaPricingAdapter,
  resolveManualCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import {
  ALIBABA_SYNC_LEASE_COLLECTION,
  type AlibabaLeaseGuard,
  holdsAlibabaLease,
} from './adapter.ts';
import {
  type AlibabaPricingEvidenceExpectation,
  alibabaPricingFingerprint,
} from './alibaba-pricing-fingerprint.ts';

export const ALIBABA_PRODUCT_LINK_LIMIT = 40;

export interface AlibabaProductLinkIdentity {
  _id: string;
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  productId: string;
  linkedAt: string;
}

interface AlibabaProductExpectation {
  productId: string;
  expectedRevision: number | null;
  expectedPrimarySourceKey: string | null;
  expectedLinks: AlibabaProductLinkIdentity[];
  now: string;
}

export type AlibabaProductMutationInput = AlibabaProductExpectation &
  (
    | { action: 'unlink' }
    | { action: 'link'; sourceKey: string; linkedByUserId: string; patch: Record<string, unknown> }
    | { action: 'pin'; sourceKey: string; offerKey: string }
    | { action: 'reconcile'; sourceKey: string; patch: Record<string, unknown> }
    | {
        action: 'create-draft';
        sourceKey: string;
        expectedClaim: AlibabaProductLinkIdentity | null;
        draft: Record<string, unknown>;
      }
    | {
        action: 'repair-pricing';
        sourceKey: string;
        guard: AlibabaLeaseGuard;
        expectedProductHash: string;
        expectedEvidence: AlibabaPricingEvidenceExpectation[];
        patch: Record<string, unknown>;
      }
    | {
        action: 'promote';
        sourceKey: string;
        guard: AlibabaLeaseGuard;
        patch: Record<string, unknown>;
        /** What a buyer would see from the source now (MIU-16); flags "changed". */
        publicSourceDigest?: string;
      }
  );

export type AlibabaProductMutationResult =
  | { ok: true; revision: number; clearedLinks: number; alreadyLinked?: boolean; created?: boolean }
  | {
      ok: false;
      reason:
        | 'product-not-found'
        | 'source-not-found'
        | 'source-linked-elsewhere'
        | 'not-linked'
        | 'offer-not-found'
        | 'offer-not-active'
        | 'identity-conflict'
        | 'link-limit'
        | 'invalid-patch'
        | 'fence-rejected';
    };

export interface AlibabaProductTransaction {
  get(collection: string, id: string): Promise<CollectionDoc | null>;
  set(collection: string, row: CollectionDoc): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}

const clearedFields = {
  alibabaPrimarySourceKey: null,
  alibabaSourceProductId: null,
  alibabaSourceCategoryId: null,
  alibabaSourceImageUrls: null,
  alibabaDescriptionImageUrls: null,
  alibabaPrimaryOfferKey: null,
  alibabaPinnedOfferKey: null,
  alibabaCatalogPricing: null,
  alibabaSourceStatus: null,
  alibabaSourceReview: null,
  alibabaReviewPending: null,
  alibabaReviewReason: null,
  alibabaSourcePublicDigest: null,
  alibabaReviewedAt: null,
  alibabaReviewedByUserId: null,
  // An unlinked product is never hidden as a draft waiting for photos (PT-G).
  alibabaPhotosPending: null,
};

const writableFields = new Set([
  'alibabaPrimarySourceKey',
  'alibabaSourceProductId',
  'alibabaSourceCategoryId',
  'alibabaSourceImageUrls',
  'alibabaDescriptionImageUrls',
  'alibabaPrimaryOfferKey',
  'alibabaCatalogPricing',
  'alibabaSourceStatus',
  'alibabaSourceLastSyncedAt',
  'alibabaSourceReview',
  'alibabaReviewPending',
  'alibabaReviewReason',
]);

const reconciliationFields = new Set(['alibabaDescriptionImageUrls', 'alibabaSourceReview']);
const draftFields = new Set([
  'name',
  'description',
  'productFamily',
  'category',
  'published',
  'archived',
  'alibabaClassifiedCategoryId',
  'alibabaPhotosPending',
  'createdAt',
  'updatedAt',
  ...writableFields,
]);

const PHOTO_SOURCE_PARTS = [
  {
    field: 'imageIds',
    sources: 'alibabaSourceImageUrls',
    part: 'gallery',
    limit: PRODUCT_IMAGE_MAX_COUNT,
  },
  {
    field: 'descriptionImageIds',
    sources: 'alibabaDescriptionImageUrls',
    part: 'description',
    limit: PRODUCT_DESCRIPTION_IMAGE_MAX_COUNT,
  },
] as const;

/**
 * One product is one unit (PT-G, owner 2026-10-09): when a sync changes the
 * Alibaba photos of a draft whose photos are still the sync's, the draft is
 * hidden until photo preparation has copied the new ones, so nobody works on
 * new data with old photos. Live, approved or archived products never hide,
 * and photos an admin chose are theirs.
 */
export function photosRefresh(product: CollectionDoc, patch: Record<string, unknown>) {
  if (
    product.published === true ||
    product.archived === true ||
    Boolean(product.catalogDetailApprovalReceipt)
  )
    return {};
  const auto = product.alibabaAutoPhotos;
  const refreshes = PHOTO_SOURCE_PARTS.some(({ field, sources, part, limit }) => {
    if (!Object.hasOwn(patch, sources)) return false;
    // Compared as the photo job reads them (normalized, first `limit`), so a
    // change it would not act on does not hide the draft.
    if (
      JSON.stringify(alibabaPhotoSources(patch[sources], limit)) ===
      JSON.stringify(alibabaPhotoSources(product[sources], limit))
    )
      return false;
    const filled = auto && typeof auto === 'object' ? Reflect.get(auto, part) : undefined;
    const filledIds =
      filled && typeof filled === 'object' ? Reflect.get(filled, 'imageIds') : undefined;
    // The sync's while never set, or while it still equals what the sync filled.
    return filledIds === undefined
      ? product[field] === undefined
      : JSON.stringify(product[field] ?? []) === JSON.stringify(filledIds);
  });
  return refreshes ? { alibabaPhotosPending: true } : {};
}

function reconciliationPatch(product: CollectionDoc, patch: Record<string, unknown>) {
  const reviewed =
    typeof product.alibabaReviewedAt === 'string' && product.alibabaReviewedAt.trim() !== '';
  return {
    ...patch,
    // A row from before the review flag gets one; 'new' only when it is pending.
    ...(typeof product.alibabaReviewPending === 'boolean'
      ? {}
      : { alibabaReviewPending: !reviewed, alibabaReviewReason: reviewed ? null : 'new' }),
  };
}

const REASON_STRENGTH = { new: 0, edited: 1, changed: 2, removed: 3 } as const;
type FlagReason = keyof typeof REASON_STRENGTH;

/** The review fields after flagging `reason`, keeping a stronger reason already set. */
export function flagForReview(product: CollectionDoc, reason: FlagReason) {
  const existing = product.alibabaReviewReason;
  const keep =
    product.alibabaReviewPending === true &&
    typeof existing === 'string' &&
    Object.hasOwn(REASON_STRENGTH, existing) &&
    REASON_STRENGTH[existing as FlagReason] > REASON_STRENGTH[reason];
  return { alibabaReviewPending: true, alibabaReviewReason: keep ? existing : reason };
}

/**
 * A sync flags an approved product whose source no longer matches what was
 * approved: 'removed' when the source is inactive, 'changed' when the public
 * digest differs (MIU-19). Never clears a flag; an existing flag keeps the
 * stronger reason. Products without an approved digest are left to the
 * one-time change audit; archived products are never flagged.
 */
function sourceChangeFlag(
  product: CollectionDoc,
  sourceActive: boolean,
  digest: string | undefined,
): Record<string, unknown> {
  const receipt = product.catalogDetailApprovalReceipt;
  const approved =
    receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'sourceDigest') : undefined;
  if (typeof approved !== 'string' || product.archived === true) return {};
  const reason: FlagReason | undefined = !sourceActive
    ? 'removed'
    : digest !== undefined && digest !== approved
      ? 'changed'
      : undefined;
  return reason ? flagForReview(product, reason) : {};
}

export function alibabaLinkRevision(product: CollectionDoc): number | null {
  const value = product.alibabaLinkRevision;
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function linkIdentity(
  row: CollectionDoc | AlibabaProductLinkIdentity,
  allowEmptyClaim = false,
): AlibabaProductLinkIdentity | null {
  const { _id, sourceKey, connectionId, sourceProductId, productId, linkedAt } = row;
  if (
    [_id, sourceKey, connectionId, sourceProductId, linkedAt].some(
      (value) => typeof value !== 'string' || value.trim() === '',
    ) ||
    typeof productId !== 'string' ||
    (productId.trim() === '' && !(allowEmptyClaim && productId === '')) ||
    _id !== sourceKey
  )
    return null;
  return {
    _id,
    sourceKey,
    connectionId,
    sourceProductId,
    productId,
    linkedAt,
  } as AlibabaProductLinkIdentity;
}

function sameLink(
  left: CollectionDoc | AlibabaProductLinkIdentity,
  right: AlibabaProductLinkIdentity,
  allowEmptyClaim = false,
): boolean {
  const identity = linkIdentity(left, allowEmptyClaim);
  return (
    identity !== null &&
    linkIdentity(right, allowEmptyClaim) !== null &&
    Object.entries(identity).every(
      ([field, value]) => value === right[field as keyof AlibabaProductLinkIdentity],
    )
  );
}

function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/**
 * Link enumeration is bounded and occurs outside the native transaction.
 * Re-read the product revision and every enumerated link by document ID inside
 * it; every link writer also writes that product revision. Additional claim,
 * source, offer and lease reads precede all writes. Native transaction retries
 * recheck the original expectation, never adopt a concurrent relink.
 * Only create-draft accepts expectedRevision=null, meaning product absent.
 */
export async function runAlibabaProductMutation(
  transaction: AlibabaProductTransaction,
  observedLinks: CollectionDoc[],
  input: AlibabaProductMutationInput,
): Promise<AlibabaProductMutationResult> {
  if (
    observedLinks.length > ALIBABA_PRODUCT_LINK_LIMIT ||
    input.expectedLinks.length > ALIBABA_PRODUCT_LINK_LIMIT
  ) {
    return { ok: false, reason: 'link-limit' };
  }
  const product = await transaction.get('products', input.productId);
  if (!product && input.action !== 'create-draft')
    return { ok: false, reason: 'product-not-found' };
  const revision = product ? alibabaLinkRevision(product) : null;
  const primary = product?.alibabaPrimarySourceKey ?? null;
  if (
    (product !== null && revision === null) ||
    revision !== input.expectedRevision ||
    revision === Number.MAX_SAFE_INTEGER ||
    primary !== input.expectedPrimarySourceKey ||
    !isCanonicalInstant(input.now) ||
    input.expectedLinks.length !== observedLinks.length ||
    new Set(input.expectedLinks.map((row) => row._id)).size !== input.expectedLinks.length ||
    new Set(observedLinks.map((row) => row._id)).size !== observedLinks.length ||
    input.expectedLinks.some(
      (row) =>
        !linkIdentity(row) ||
        row.productId !== input.productId ||
        !observedLinks.some((observed) => sameLink(observed, row)),
    )
  )
    return { ok: false, reason: 'identity-conflict' };

  for (const expected of input.expectedLinks) {
    const actual = await transaction.get('alibabaProductLinks', expected._id);
    if (!actual || !sameLink(actual, expected)) return { ok: false, reason: 'identity-conflict' };
  }

  if (input.action === 'unlink') {
    if (!product || revision === null) return { ok: false, reason: 'identity-conflict' };
    if (
      observedLinks.length === 0 &&
      Object.keys(clearedFields).every((field) => product[field] == null)
    ) {
      return { ok: true, revision, clearedLinks: 0 };
    }
    await transaction.set('products', {
      ...product,
      ...clearedFields,
      alibabaLinkRevision: revision + 1,
      alibabaSourceLastSyncedAt: input.now,
      updatedAt: input.now,
    });
    for (const link of input.expectedLinks)
      await transaction.remove('alibabaProductLinks', link._id);
    return { ok: true, revision: revision + 1, clearedLinks: observedLinks.length };
  }

  const link = await transaction.get('alibabaProductLinks', input.sourceKey);
  const source = await transaction.get('alibabaSourceProducts', input.sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };
  if (
    typeof source.connectionId !== 'string' ||
    source.connectionId.trim() === '' ||
    typeof source.sourceProductId !== 'string' ||
    source.sourceProductId.trim() === ''
  ) {
    return { ok: false, reason: 'identity-conflict' };
  }
  if (
    input.action === 'create-draft' &&
    (input.expectedClaim === null
      ? link !== null
      : !link || !sameLink(link, input.expectedClaim, true))
  )
    return { ok: false, reason: 'identity-conflict' };
  if (
    link &&
    (link.sourceKey !== input.sourceKey ||
      link.connectionId !== source.connectionId ||
      link.sourceProductId !== source.sourceProductId)
  ) {
    return { ok: false, reason: 'identity-conflict' };
  }
  if (link && link.productId !== input.productId && link.productId !== '') {
    return { ok: false, reason: 'source-linked-elsewhere' };
  }
  const alreadyLinked = link?.productId === input.productId;
  if (alreadyLinked && !input.expectedLinks.some((expected) => expected._id === input.sourceKey)) {
    return { ok: false, reason: 'identity-conflict' };
  }

  if (input.action === 'create-draft') {
    if (product && primary !== input.sourceKey) return { ok: false, reason: 'identity-conflict' };
    if (
      input.draft.published !== false ||
      input.draft.archived !== false ||
      Object.keys(input.draft).some((field) => !draftFields.has(field))
    ) {
      return { ok: false, reason: 'invalid-patch' };
    }
    if (!alreadyLinked && observedLinks.length === ALIBABA_PRODUCT_LINK_LIMIT)
      return { ok: false, reason: 'link-limit' };
    const nextRevision = (revision ?? 0) + 1;
    const reviewPatch = Object.fromEntries(
      Object.entries(input.draft).filter(([field]) => reconciliationFields.has(field)),
    );
    const nextProduct: CollectionDoc = product
      ? {
          ...product,
          ...reconciliationPatch(product, reviewPatch),
          ...photosRefresh(product, reviewPatch),
          alibabaLinkRevision: nextRevision,
          updatedAt: input.now,
        }
      : {
          ...input.draft,
          _id: input.productId,
          published: false,
          archived: false,
          alibabaPrimarySourceKey: input.sourceKey,
          alibabaSourceProductId: source.sourceProductId,
          alibabaSourceCategoryId: String(source.sourceCategoryId ?? ''),
          alibabaSourceStatus: source.active === true ? 'available' : 'removed',
          alibabaReviewPending: true,
          alibabaReviewReason: 'new',
          alibabaLinkRevision: nextRevision,
          alibabaSourceLastSyncedAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        };
    await transaction.set('products', nextProduct);
    if (!alreadyLinked)
      await transaction.set('alibabaProductLinks', {
        ...link,
        _id: input.sourceKey,
        sourceKey: input.sourceKey,
        connectionId: source.connectionId,
        sourceProductId: source.sourceProductId,
        productId: input.productId,
        linkedByUserId: '',
        linkedAt: input.now,
        createdAt: link?.createdAt ?? input.now,
        updatedAt: input.now,
      });
    return { ok: true, revision: nextRevision, clearedLinks: 0, created: product === null };
  }

  if (!product || revision === null) return { ok: false, reason: 'identity-conflict' };
  if (input.action === 'repair-pricing') {
    if (
      !alreadyLinked ||
      primary !== input.sourceKey ||
      source.active !== true ||
      product.archived === true ||
      alibabaPricingFingerprint(product) !== input.expectedProductHash
    )
      return { ok: false, reason: 'identity-conflict' };
    if (
      resolveManualCatalogPricing({ ...product, catalogPricingMode: product.catalogPricingMode })
        .source !== 'inherit'
    )
      return { ok: false, reason: 'invalid-patch' };
    const fields = Object.keys(input.patch);
    const pricing = input.patch.alibabaCatalogPricing;
    const offerKey = input.patch.alibabaPrimaryOfferKey;
    if (
      fields.length !== 2 ||
      fields.some((key) => !['alibabaCatalogPricing', 'alibabaPrimaryOfferKey'].includes(key)) ||
      !pricing ||
      typeof pricing !== 'object' ||
      Array.isArray(pricing) ||
      typeof offerKey !== 'string'
    )
      return { ok: false, reason: 'invalid-patch' };
    const publicPricing = Object.fromEntries(
      Object.entries(pricing).filter(
        ([key]) => !['sourceOfferKey', 'sourceProductId', 'sourceSkuId'].includes(key),
      ),
    );
    if (createAlibabaPricingAdapter().resolve(primary, publicPricing).state !== 'available')
      return { ok: false, reason: 'invalid-patch' };
    if (
      input.expectedEvidence.length > 48 ||
      !input.expectedEvidence.some(
        (e) => e.collection === 'alibabaSourceProducts' && e.id === input.sourceKey,
      ) ||
      !input.expectedEvidence.some(
        (e) => e.collection === 'alibabaSupplierOffers' && e.id === offerKey,
      ) ||
      !input.expectedEvidence.some(
        (e) => e.collection === 'alibabaSyncRuns' && e.id === source.lastSeenRunId,
      )
    )
      return { ok: false, reason: 'invalid-patch' };
    for (const expected of input.expectedEvidence) {
      if (
        !['alibabaSourceProducts', 'alibabaSupplierOffers', 'alibabaSyncRuns'].includes(
          expected.collection,
        )
      )
        return { ok: false, reason: 'invalid-patch' };
      const row = await transaction.get(expected.collection, expected.id);
      if (
        !row ||
        alibabaPricingFingerprint(row) !== expected.hash ||
        (expected.collection === 'alibabaSyncRuns' && row.status !== 'completed')
      )
        return { ok: false, reason: 'identity-conflict' };
      if (
        expected.collection === 'alibabaSupplierOffers' &&
        (row.sourceKey !== input.sourceKey ||
          row.active !== true ||
          alibabaPricingFingerprint(row.pricing) !== alibabaPricingFingerprint(pricing))
      )
        return { ok: false, reason: 'identity-conflict' };
    }
    const lease = await transaction.get(ALIBABA_SYNC_LEASE_COLLECTION, input.guard.connectionId);
    // Re-evaluate wall time on native retries, rather than trusting the old plan's timestamp.
    if (
      !lease ||
      input.guard.connectionId !== source.connectionId ||
      !holdsAlibabaLease(lease, input.guard.holder, input.guard.fence, new Date().toISOString())
    )
      return { ok: false, reason: 'fence-rejected' };
    await transaction.set(ALIBABA_SYNC_LEASE_COLLECTION, lease);
    await transaction.set('products', {
      ...product,
      ...input.patch,
      alibabaLinkRevision: revision + 1,
      updatedAt: input.now,
    });
    return { ok: true, revision: revision + 1, clearedLinks: 0 };
  }
  if (input.action === 'pin') {
    if (!alreadyLinked || primary !== input.sourceKey) return { ok: false, reason: 'not-linked' };
    if (input.offerKey !== '') {
      const offer = await transaction.get('alibabaSupplierOffers', input.offerKey);
      if (!offer || offer.sourceKey !== input.sourceKey)
        return { ok: false, reason: 'offer-not-found' };
      if (offer.active !== true) return { ok: false, reason: 'offer-not-active' };
    }
    await transaction.set('products', {
      ...product,
      alibabaPinnedOfferKey: input.offerKey,
      alibabaLinkRevision: revision + 1,
      updatedAt: input.now,
    });
    return { ok: true, revision: revision + 1, clearedLinks: 0 };
  }

  if (input.action === 'reconcile') {
    if (!alreadyLinked) return { ok: false, reason: 'identity-conflict' };
    if (Object.keys(input.patch).some((field) => !reconciliationFields.has(field)))
      return { ok: false, reason: 'invalid-patch' };
    if (primary !== input.sourceKey) return { ok: true, revision, clearedLinks: 0 };
    await transaction.set('products', {
      ...product,
      ...reconciliationPatch(product, input.patch),
      ...photosRefresh(product, input.patch),
      alibabaLinkRevision: revision + 1,
      updatedAt: input.now,
    });
    return { ok: true, revision: revision + 1, clearedLinks: 0 };
  }

  if (
    Object.keys(input.patch).some((field) => !writableFields.has(field)) ||
    (Object.hasOwn(input.patch, 'alibabaPrimarySourceKey') &&
      input.patch.alibabaPrimarySourceKey !== input.sourceKey)
  )
    return { ok: false, reason: 'invalid-patch' };

  if (input.action === 'promote') {
    if (!alreadyLinked || primary !== input.sourceKey)
      return { ok: false, reason: 'identity-conflict' };
    const lease = await transaction.get(ALIBABA_SYNC_LEASE_COLLECTION, input.guard.connectionId);
    if (
      !isCanonicalInstant(input.guard.now) ||
      !lease ||
      input.guard.connectionId !== source.connectionId ||
      !holdsAlibabaLease(lease, input.guard.holder, input.guard.fence, input.guard.now)
    ) {
      return { ok: false, reason: 'fence-rejected' };
    }
    await transaction.set(ALIBABA_SYNC_LEASE_COLLECTION, lease);
  } else {
    if (!alreadyLinked && observedLinks.length === ALIBABA_PRODUCT_LINK_LIMIT)
      return { ok: false, reason: 'link-limit' };
    await transaction.set('alibabaProductLinks', {
      ...link,
      _id: input.sourceKey,
      sourceKey: input.sourceKey,
      connectionId: source.connectionId,
      sourceProductId: source.sourceProductId,
      productId: input.productId,
      linkedByUserId: input.linkedByUserId,
      linkedAt: input.now,
      createdAt: link?.createdAt ?? input.now,
      updatedAt: input.now,
    });
  }

  await transaction.set('products', {
    ...product,
    ...(input.action === 'link' && primary !== input.sourceKey ? clearedFields : {}),
    ...input.patch,
    alibabaPrimarySourceKey: input.sourceKey,
    alibabaSourceProductId: source.sourceProductId,
    alibabaSourceCategoryId: String(source.sourceCategoryId ?? ''),
    ...(input.action === 'link'
      ? { alibabaSourceStatus: source.active === true ? 'available' : 'removed' }
      : {}),
    ...(input.action === 'promote'
      ? sourceChangeFlag(product, source.active === true, input.publicSourceDigest)
      : {}),
    ...(input.action === 'promote' ? photosRefresh(product, input.patch) : {}),
    // What the sync last saw; publishing an approval of older data keeps the flag.
    ...(input.action === 'promote' && input.publicSourceDigest !== undefined
      ? { alibabaSourcePublicDigest: input.publicSourceDigest }
      : {}),
    alibabaLinkRevision: revision + 1,
    alibabaSourceLastSyncedAt: input.now,
    updatedAt: input.now,
  });
  return {
    ok: true,
    revision: revision + 1,
    clearedLinks: 0,
    ...(input.action === 'link' ? { alreadyLinked } : {}),
  };
}
