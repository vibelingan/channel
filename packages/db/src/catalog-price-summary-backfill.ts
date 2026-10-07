/**
 * One-time backfill of `catalogDetailPublication.priceSummary` for versions
 * approved before summaries existed (MIU-6). Planning reads outside any
 * transaction through an injected reader; each write is the
 * `price-summary-backfill` staging command, which re-checks the revision.
 *
 * Approved SKU rows are immutable per revision, so a summary derived from the
 * rows of revision R stays correct while the product still points at R.
 */
import type { CollectionDoc } from '@vibelingan-channel/shared';
import {
  CatalogDetailPublicationSchema,
  CatalogDetailVariantSchema,
  type CatalogPriceSummary,
  derivePriceSummary,
} from '@vibelingan-channel/shared/catalog-detail';

export type ApprovedVariantStorage = 'immutable-v1' | 'legacy';

export interface PriceSummaryBackfillReader {
  /** Products ordered by `_id`, strictly after `afterId`. */
  listProducts(afterId: string | undefined, pageSize: number): Promise<CollectionDoc[]>;
  /** Every approved SKU row of one revision (all pages). */
  listApprovedVariants(
    productId: string,
    revision: string,
    storage: ApprovedVariantStorage,
  ): Promise<CollectionDoc[]>;
}

export type PriceSummaryBackfillRow =
  | { productId: string; revision: string; outcome: 'ready'; priceSummary: CatalogPriceSummary }
  | {
      productId: string;
      revision?: string;
      outcome: 'already-present' | 'not-approved' | 'invalid-variant-rows' | 'no-price';
    };

export interface PriceSummaryBackfillPlan {
  rows: PriceSummaryBackfillRow[];
  /** Pass back as `afterId` for the next page; equal to the input when done. */
  nextAfterId: string | undefined;
  done: boolean;
}

async function planOne(
  reader: PriceSummaryBackfillReader,
  product: CollectionDoc,
): Promise<PriceSummaryBackfillRow> {
  const parsed = CatalogDetailPublicationSchema.safeParse(product.catalogDetailPublication);
  if (!parsed.success || parsed.data.header._id !== product._id) {
    return { productId: product._id, outcome: 'not-approved' };
  }
  const publication = parsed.data;
  const base = { productId: product._id, revision: publication.revision };
  if (publication.priceSummary) return { ...base, outcome: 'already-present' };
  const storage = publication.variantStorage === 'immutable-v1' ? 'immutable-v1' : 'legacy';
  const rows = await reader.listApprovedVariants(product._id, publication.revision, storage);
  const variants = rows.map((row) =>
    CatalogDetailVariantSchema.safeParse(row.catalogDetailApproved),
  );
  if (variants.length !== publication.variantCount || variants.some((v) => !v.success)) {
    return { ...base, outcome: 'invalid-variant-rows' };
  }
  const priceSummary = derivePriceSummary({
    websitePricing: publication.header.websitePricing,
    offers: publication.header.offers,
    variants: variants.flatMap((v) =>
      v.success ? [{ id: v.data.id, offers: v.data.offers }] : [],
    ),
  });
  return priceSummary
    ? { ...base, outcome: 'ready', priceSummary }
    : { ...base, outcome: 'no-price' };
}

/** Read-only. Never writes; `ready` rows go to the `price-summary-backfill` command. */
export async function planPriceSummaryBackfill(
  reader: PriceSummaryBackfillReader,
  input: { afterId?: string; pageSize: number },
): Promise<PriceSummaryBackfillPlan> {
  const pageSize = Math.max(1, Math.min(20, Math.trunc(input.pageSize)));
  const products = await reader.listProducts(input.afterId, pageSize);
  const rows: PriceSummaryBackfillRow[] = [];
  for (const product of products) rows.push(await planOne(reader, product));
  return {
    rows,
    nextAfterId: products.at(-1)?._id ?? input.afterId,
    done: products.length < pageSize,
  };
}
