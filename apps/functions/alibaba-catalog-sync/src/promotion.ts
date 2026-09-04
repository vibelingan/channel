/**
 * Fenced product promotion (MIU 8): materialize the selected primary offer
 * into the linked product's Alibaba-owned fields.
 *
 * The write path is `updateDocWithAlibabaLease` — the lease's holder/fence/
 * expiry are re-verified INSIDE the same transaction as the patch (R1 E2),
 * so a stale holder can never promote after a fence takeover. The patch
 * carries ONLY Alibaba-owned additive fields; curated fields,
 * publication state, and legacy pricing are structurally out of reach.
 */
import {
  type AlibabaCatalogPricing,
  type OfferForSelection,
  buildPromotionCandidate,
  computeCandidateHash,
  priceMoveExceedsThreshold,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { type AlibabaLeaseGuard, list, updateDocWithAlibabaLease } from '@vibelingan-channel/db';
import { getDoc } from './repo.ts';

export interface PromoteInput {
  sourceKey: string;
  guard: AlibabaLeaseGuard;
  now: string;
}

export type PromoteResult =
  | {
      ok: true;
      productId: string;
      candidateHash: string;
      priceMoveAlert: boolean;
      changed: boolean;
    }
  | {
      ok: false;
      reason: 'not-linked' | 'product-missing' | 'link-identity-mismatch' | 'fence-rejected';
    };

/** Read the ACTIVE offers for one source product (bounded by SKU count). */
async function activeOffers(sourceKey: string): Promise<OfferForSelection[]> {
  const result = await list({
    collection: 'alibabaSupplierOffers',
    page: 1,
    pageSize: 100,
    filter: { combinator: 'and', clauses: [{ field: 'sourceKey', op: 'eq', value: sourceKey }] },
  });
  return result.items.map((doc) => ({
    offerKey: doc._id,
    sourceKey: String(doc.sourceKey ?? ''),
    sourceSkuId: String(doc.sourceSkuId ?? ''),
    active: doc.active === true,
    pricing: doc.pricing as AlibabaCatalogPricing,
    ...(typeof doc.sourceAvailability === 'number'
      ? { sourceAvailability: doc.sourceAvailability }
      : {}),
  }));
}

export async function promoteLinkedProduct(input: PromoteInput): Promise<PromoteResult> {
  const link = await getDoc('alibabaProductLinks', input.sourceKey);
  if (!link || typeof link.productId !== 'string' || link.productId === '') {
    return { ok: false, reason: 'not-linked' };
  }
  const product = await getDoc('products', link.productId);
  if (!product) return { ok: false, reason: 'product-missing' };
  // Link identity recheck (MIU 8 contract): the product must still claim this
  // source as its primary; an unlink/relink between read and promotion makes
  // the candidate stale.
  if (product.alibabaPrimarySourceKey !== input.sourceKey) {
    return { ok: false, reason: 'link-identity-mismatch' };
  }

  const source = await getDoc('alibabaSourceProducts', input.sourceKey);
  const offers = await activeOffers(input.sourceKey);
  // Read the OPERATOR pin, never the sync's own previous selection
  // (blessing-gate P1): feeding alibabaPrimaryOfferKey back in made the first
  // run's auto-selection permanent, so a supplier re-pricing could never move
  // the storefront to the cheaper offer §5 mandates.
  const pinned =
    typeof product.alibabaPinnedOfferKey === 'string' && product.alibabaPinnedOfferKey !== ''
      ? product.alibabaPinnedOfferKey
      : undefined;
  const candidate = buildPromotionCandidate({
    sourceKey: input.sourceKey,
    offers,
    source: { active: source?.active === true },
    ...(pinned !== undefined ? { pinnedOfferKey: pinned } : {}),
    now: input.now,
  });
  const patch = {
    ...candidate.patch,
    alibabaSourceProductId: String(source?.sourceProductId ?? ''),
    alibabaSourceCategoryId: String(source?.sourceCategoryId ?? ''),
    alibabaSourceImageUrls: Array.isArray(source?.sourceImageUrls)
      ? source.sourceImageUrls.filter((value): value is string => typeof value === 'string')
      : [],
  };

  const previousPricing = (product.alibabaCatalogPricing ?? null) as AlibabaCatalogPricing | null;
  const priceMoveAlert = priceMoveExceedsThreshold(
    previousPricing,
    candidate.patch.alibabaCatalogPricing,
  );
  const candidateHash = computeCandidateHash({
    sourceKey: input.sourceKey,
    productId: link.productId,
    patch,
  });

  const changed =
    computeCandidateHash({
      p: previousPricing,
      k: product.alibabaPrimaryOfferKey ?? null,
      s: product.alibabaSourceStatus ?? null,
      i: product.alibabaSourceProductId ?? null,
      c: product.alibabaSourceCategoryId ?? null,
      m: product.alibabaSourceImageUrls ?? null,
    }) !==
    computeCandidateHash({
      p: candidate.patch.alibabaCatalogPricing,
      k: candidate.patch.alibabaPrimaryOfferKey,
      s: candidate.patch.alibabaSourceStatus,
      i: patch.alibabaSourceProductId,
      c: patch.alibabaSourceCategoryId,
      m: patch.alibabaSourceImageUrls,
    });

  const applied = await updateDocWithAlibabaLease('products', link.productId, patch, input.guard);
  if (!applied) return { ok: false, reason: 'fence-rejected' };
  return { ok: true, productId: link.productId, candidateHash, priceMoveAlert, changed };
}
