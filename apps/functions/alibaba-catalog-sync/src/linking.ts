/**
 * Deterministic product linking + unpublished draft projection (MIU 7).
 *
 * `alibabaProductLinks._id = sourceKey` and create-if-absent enforce ONE
 * Channel product per source product under any concurrency; a Channel product
 * may aggregate several source products (DESIGN_CHARTER §9). No fuzzy
 * matching exists anywhere — links come from an explicit admin action or a
 * category-mapped draft creation, and worker-created drafts are runtime-
 * verified `published: false` (synchronization invariant 1).
 */
import { list, remove } from '@vibelingan-channel/db';
import { createDoc, createDocWithId, getDoc, updateDoc } from './repo.ts';

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
  if (created === 'exists') {
    const existing = await getDoc('alibabaProductLinks', sourceKey);
    if (existing?.productId === productId) {
      return { ok: true, sourceKey, productId, alreadyLinked: true };
    }
    // Repair path: a crashed draft claim leaves productId '' — adopt it.
    if (existing && existing.productId === '') {
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
    alibabaSourceStatus: source.active === true ? 'available' : 'removed',
    alibabaSourceLastSyncedAt: context.now,
  });
  return { ok: true, sourceKey, productId, alreadyLinked: false };
}

export type UnlinkResult =
  | { ok: true; productId: string; clearedLinks: number }
  | { ok: false; reason: 'product-not-found' };

/**
 * Explicit unlink: remove the link rows and clear ONLY the five Alibaba-owned
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
  | { ok: false; reason: 'source-not-found' | 'no-category-mapping' | 'linked-elsewhere' };

/**
 * Create an UNPUBLISHED draft for a new source product — only when an
 * explicit category mapping exists (never fuzzy, never auto-published, never
 * auto-imaged). Race-safe: the link row is claimed FIRST (single winner);
 * a crash between claim and draft leaves productId '' which this function
 * repairs on retry.
 */
export async function createDraftForSource(
  sourceKey: string,
  context: LinkContext,
): Promise<DraftResult> {
  const source = await getDoc('alibabaSourceProducts', sourceKey);
  if (!source) return { ok: false, reason: 'source-not-found' };

  const mappings = await list({
    collection: 'alibabaCategoryMappings',
    page: 1,
    pageSize: 1,
    filter: {
      combinator: 'and',
      clauses: [
        { field: 'alibabaCategoryId', op: 'eq', value: String(source.sourceCategoryId ?? '') },
      ],
    },
  });
  const mapping = mappings.items[0];
  if (!mapping) return { ok: false, reason: 'no-category-mapping' };

  const claim = await createDocWithId('alibabaProductLinks', sourceKey, {
    sourceKey,
    connectionId: source.connectionId,
    sourceProductId: source.sourceProductId,
    productId: '',
    linkedByUserId: '',
    linkedAt: context.now,
    createdAt: context.now,
    updatedAt: context.now,
  });
  if (claim === 'exists') {
    const existing = await getDoc('alibabaProductLinks', sourceKey);
    if (existing && typeof existing.productId === 'string' && existing.productId !== '') {
      return { ok: true, productId: existing.productId, created: false };
    }
    if (!existing) return { ok: false, reason: 'linked-elsewhere' };
    // fall through: claimed-but-unfinished — this invocation completes it.
  }

  const draft: Record<string, unknown> = {
    name: source.sourceTitle ?? `Alibaba product ${source.sourceProductId}`,
    category: mapping.channelCategory,
    description: source.sourceDescription ?? '',
    published: false,
    alibabaPrimarySourceKey: sourceKey,
    alibabaSourceStatus: 'available',
    alibabaSourceLastSyncedAt: context.now,
  };
  // Runtime invariant, not just a default: the worker can never publish.
  if (draft.published !== false) throw new Error('draft must be unpublished');
  const product = await createDoc('products', draft);
  await updateDoc('alibabaProductLinks', sourceKey, { productId: product._id });
  return { ok: true, productId: product._id, created: true };
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
