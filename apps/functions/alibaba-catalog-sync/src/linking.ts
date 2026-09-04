/**
 * Deterministic product linking + unpublished draft projection (MIU 7).
 *
 * `alibabaProductLinks._id = sourceKey` and create-if-absent enforce ONE
 * Channel product per source product under any concurrency; a Channel product
 * may aggregate several source products (DESIGN_CHARTER §9). No fuzzy
 * matching exists anywhere — links come from an explicit admin action or an
 * observed-source draft creation, and worker-created drafts are runtime-
 * verified `published: false` (synchronization invariant 1).
 */
import { createHash } from 'node:crypto';
import {
  sourceObservationDocumentId,
  validateCatalogSourceObservation,
} from '@vibelingan-channel/catalog-import';
import { list, remove } from '@vibelingan-channel/db';
import { createDocWithId, getDoc, updateDoc } from './repo.ts';

export interface LinkContext {
  now: string;
  userId?: string;
}

export type LinkResult =
  | { ok: true; sourceKey: string; productId: string; alreadyLinked: boolean }
  | {
      ok: false;
      reason: 'source-not-found' | 'product-not-found' | 'source-linked-elsewhere';
    };

/** Explicit admin link of an EXISTING Channel product to a source product. */
export async function linkExistingProduct(
  sourceKey: string,
  productId: string,
  context: LinkContext,
): Promise<LinkResult> {
  const source = await getDoc('alibabaSourceProducts', sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };
  const product = await getDoc('products', productId);
  if (!product) return { ok: false, reason: 'product-not-found' };

  const created = await createDocWithId('alibabaProductLinks', sourceKey, {
    sourceKey,
    connectionId: source.connectionId,
    sourceProductId: source.sourceProductId,
    productId,
    linkedByUserId: context.userId ?? '',
    linkedAt: context.now,
    createdAt: context.now,
    updatedAt: context.now,
  });
  let alreadyLinked = false;
  if (created === 'exists') {
    const existing = await getDoc('alibabaProductLinks', sourceKey);
    if (existing?.productId === productId) {
      alreadyLinked = true;
    } else if (existing && existing.productId === '') {
      // Repair path: a crashed draft claim leaves productId '' — adopt it.
      await updateDoc('alibabaProductLinks', sourceKey, {
        productId,
        linkedByUserId: context.userId ?? '',
        linkedAt: context.now,
      });
    } else {
      return { ok: false, reason: 'source-linked-elsewhere' };
    }
  }

  // The product becomes Alibaba-linked; pricing materialization is MIU 8's
  // fenced promotion — here only the link identity + a conservative status.
  await updateDoc('products', productId, {
    alibabaPrimarySourceKey: sourceKey,
    alibabaSourceProductId: String(source.sourceProductId ?? ''),
    alibabaSourceCategoryId: String(source.sourceCategoryId ?? ''),
    alibabaSourceImageUrls: Array.isArray(source.sourceImageUrls)
      ? source.sourceImageUrls.filter((value): value is string => typeof value === 'string')
      : [],
    alibabaSourceStatus: source.active === true ? 'available' : 'removed',
    alibabaSourceLastSyncedAt: context.now,
  });
  return { ok: true, sourceKey, productId, alreadyLinked };
}

export type UnlinkResult =
  | { ok: true; productId: string; clearedLinks: number }
  | { ok: false; reason: 'product-not-found' };

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
  const links = await list({
    collection: 'alibabaProductLinks',
    page: 1,
    pageSize: 100,
    filter: { combinator: 'and', clauses: [{ field: 'productId', op: 'eq', value: productId }] },
  });
  for (const link of links.items) {
    await remove('alibabaProductLinks', link._id);
  }
  await updateDoc('products', productId, {
    alibabaPrimarySourceKey: null,
    alibabaSourceProductId: null,
    alibabaSourceCategoryId: null,
    alibabaSourceImageUrls: null,
    alibabaPrimaryOfferKey: null,
    // The operator pin must clear too (blessing-gate P2): unlink is the
    // documented rollback command, and a surviving pin would silently rebind
    // a stale offer if the product were ever linked again.
    alibabaPinnedOfferKey: null,
    alibabaCatalogPricing: null,
    alibabaSourceStatus: null,
    alibabaSourceLastSyncedAt: context.now,
  });
  return { ok: true, productId, clearedLinks: links.items.length };
}

export type DraftResult =
  | { ok: true; productId: string; created: boolean }
  | { ok: false; reason: 'source-not-found' | 'linked-elsewhere' };

/**
 * Stable opaque id for the first Channel draft created from one source row.
 * The link remains the authority; the deterministic id only makes a retry or
 * concurrent materialization converge without leaving orphan draft products.
 */
export function draftProductId(sourceKey: string): string {
  const hex = createHash('sha256').update(`channel-product\0${sourceKey}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    pageSize: 1,
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
  if (typeof commonMapping?.productFamily === 'string' && commonMapping.productFamily !== '') {
    return {
      productFamily: commonMapping.productFamily,
      ...(typeof commonMapping.channelCategory === 'string' && commonMapping.channelCategory !== ''
        ? { channelCategory: commonMapping.channelCategory }
        : {}),
    };
  }

  // Compatibility with the original Alibaba-only headphones mapping.
  const legacy = await list({
    collection: 'alibabaCategoryMappings',
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [{ field: 'alibabaCategoryId', op: 'eq', value: sourceCategoryId }],
    },
  });
  const legacyMapping = legacy.items[0];
  return typeof legacyMapping?.channelCategory === 'string' && legacyMapping.channelCategory !== ''
    ? { productFamily: 'headphones', channelCategory: legacyMapping.channelCategory }
    : {};
}

/**
 * Create an UNPUBLISHED draft for every observed source product. Category
 * mapping enriches the draft but is no longer a visibility gate: an unmapped
 * product remains visible under "All products" and publication validation
 * still requires an operator-chosen family. Never fuzzy-map, auto-publish, or
 * auto-import media.
 *
 * Race-safe: the link row is claimed FIRST with a deterministic product id;
 * a crash between link and product is repaired by the next invocation.
 */
export async function createDraftForSource(
  sourceKey: string,
  context: LinkContext,
): Promise<DraftResult> {
  const source = await getDoc('alibabaSourceProducts', sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };

  const category = await mappedCategory(String(source.sourceCategoryId ?? ''));
  const proposedProductId = draftProductId(sourceKey);

  const claim = await createDocWithId('alibabaProductLinks', sourceKey, {
    sourceKey,
    connectionId: source.connectionId,
    sourceProductId: source.sourceProductId,
    productId: proposedProductId,
    linkedByUserId: '',
    linkedAt: context.now,
    createdAt: context.now,
    updatedAt: context.now,
  });
  if (claim === 'exists') {
    const existing = await getDoc('alibabaProductLinks', sourceKey);
    if (existing && typeof existing.productId === 'string' && existing.productId !== '') {
      const linkedProduct = await getDoc('products', existing.productId);
      if (linkedProduct) return { ok: true, productId: existing.productId, created: false };
      // A previous invocation committed the link then crashed. Recreate the
      // missing product at the id already named by the authoritative link.
      return createLinkedDraft(source, existing.productId, category, context.now);
    }
    if (!existing) return { ok: false, reason: 'linked-elsewhere' };
    // Compatibility repair for old empty claims written by the previous
    // algorithm. Every retry chooses the same id.
    await updateDoc('alibabaProductLinks', sourceKey, { productId: proposedProductId });
  }

  return createLinkedDraft(source, proposedProductId, category, context.now);
}

async function createLinkedDraft(
  source: Record<string, unknown> & { _id: string },
  productId: string,
  category: { productFamily?: string; channelCategory?: string },
  now: string,
): Promise<DraftResult> {
  const observationDoc = await getDoc(
    'catalogSourceObservations',
    sourceObservationDocumentId('alibaba', source._id),
  );
  const validated = validateCatalogSourceObservation(observationDoc?.observation);
  const observation =
    validated.ok &&
    validated.value.source.provider === 'alibaba' &&
    validated.value.source.sourceProductKey === source._id
      ? validated.value
      : null;
  const observedTitle = observation?.identity.title;
  const observedDescription = observation?.content.description?.text;

  const draft: Record<string, unknown> = {
    name:
      typeof observedTitle === 'string' && observedTitle.trim() !== ''
        ? observedTitle
        : typeof source.sourceTitle === 'string' && source.sourceTitle.trim() !== ''
          ? source.sourceTitle
          : `Alibaba product ${String(source.sourceProductId ?? '')}`,
    ...(typeof observedDescription === 'string' && observedDescription.trim() !== ''
      ? { description: observedDescription }
      : {}),
    ...(category.productFamily === undefined ? {} : { productFamily: category.productFamily }),
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
    createdAt: now,
    updatedAt: now,
  };
  // Runtime invariant, not just a default: the worker can never publish.
  if (draft.published !== false) throw new Error('draft must be unpublished');
  const created = await createDocWithId('products', productId, draft);
  if (created === 'exists') {
    const existingProduct = await getDoc('products', productId);
    if (existingProduct?.alibabaPrimarySourceKey !== source._id) {
      return { ok: false, reason: 'linked-elsewhere' };
    }
  }
  return { ok: true, productId, created: created === 'created' };
}

export type SetPinnedOfferResult =
  | { ok: true; productId: string; pinnedOfferKey: string }
  | {
      ok: false;
      reason: 'product-not-found' | 'not-linked' | 'offer-not-found' | 'offer-not-active';
    };

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

  if (input.offerKey !== '') {
    const offer = await getDoc('alibabaSupplierOffers', input.offerKey);
    if (!offer) return { ok: false, reason: 'offer-not-found' };
    if (String(offer.sourceKey ?? '') !== sourceKey)
      return { ok: false, reason: 'offer-not-found' };
    if (offer.active !== true) return { ok: false, reason: 'offer-not-active' };
  }

  await updateDoc('products', input.productId, {
    alibabaPinnedOfferKey: input.offerKey,
    updatedAt: input.now,
  });
  return { ok: true, productId: input.productId, pinnedOfferKey: input.offerKey };
}
