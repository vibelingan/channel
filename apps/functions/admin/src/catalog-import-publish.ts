import type { Buffer } from 'node:buffer';
/**
 * Promoting staged candidates into the Channel catalog.
 *
 * This is the one merge service, and it consumes CANDIDATES — not Dianxiaomi
 * rows. A second connector reaches it by producing candidates and changes
 * nothing here.
 *
 * Three rules decide almost every line below.
 *
 * OPERATOR CONTENT IS NOT SOURCE CONTENT. On a repeat import, only
 * source-owned fields move. A title an operator rewrote, a description they
 * edited, the website category they chose, the publication state and the image
 * order all survive: the merchant's shop feed does not get to undo their work.
 *
 * NO ALIBABA FIELD IS EVER WRITTEN. Every patch to `products` goes through
 * `assertNoAlibabaFields`, so the rule is enforced at one seam instead of
 * being asserted six times in comments.
 *
 * USD PRICES STAY OFF. Source amounts are CNY, and four pricing decisions are
 * still open (markup vs. target margin and its value, regular vs. promotion
 * input, FX source and cadence, rounding). Until those land, nothing writes
 * `unitPrice`, `wholesalePrice` or `vipPrice`, and publication says so rather
 * than quietly shipping a CNY number as if it were dollars.
 */
import { createHash } from 'node:crypto';
import type {
  CatalogProductCandidate,
  CatalogVariantCandidate,
  StoreListingRecord,
  VariantInventory,
} from '@vibelingan-channel/catalog-import';
import { get, saveCatalogProductWithIdentities, updateDoc } from '@vibelingan-channel/db';
import { normalizeProductSlug } from '@vibelingan-channel/shared';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { fetchSourceImage, migrateImageLocally, sniffImageMime } from './catalog-import-media.ts';
import {
  IMPORT_ITEMS,
  assertNoAlibabaFields,
  bindProduct,
  bindVariant,
  listImportItems,
  recordStoreLink,
  resolveCategoryMapping,
  writeVariant,
} from './catalog-import-store.ts';

/**
 * Channel fields an operator owns once the product exists. A repeat import
 * reads them, never writes them.
 */
export const OPERATOR_OWNED_PRODUCT_FIELDS: readonly string[] = [
  'name',
  'description',
  'slug',
  'productFamily',
  'category',
  'imageIds',
  'published',
  'archived',
  'series',
  'modName',
  'modType',
  'moq',
  'unitPrice',
  'wholesalePrice',
  'vipPrice',
  'manualCatalogPricing',
] as const;

type SaveOutcome = Awaited<ReturnType<typeof saveCatalogProductWithIdentities>>;

/** Plain-language reason a product could not be written or published. */
function describeSaveFailure(outcome: SaveOutcome): string {
  switch (outcome.result) {
    case 'conflict':
      return `another product already uses that ${outcome.kind} (${outcome.normalizedValue})`;
    case 'invalid':
      return `the generated ${outcome.kind} is not a usable value`;
    case 'invalid-product':
      return outcome.issues.map((issue) => issue.message).join('; ');
    case 'missing':
      return 'the product row disappeared mid-write';
    case 'exists':
      return 'a product already exists with that id';
    default:
      return 'unknown failure';
  }
}

/**
 * Write the product through the catalog's identity-reserving save.
 *
 * A slug collision is recoverable rather than fatal: the seeded slug is a
 * convenience derived from the parent SKU, and an operator is expected to
 * replace it. Retrying once without a slug keeps the product importable and
 * reports what happened, instead of dropping a real product over a URL.
 */
async function writeProduct(
  productId: string,
  patch: Record<string, unknown>,
  exists: boolean,
): Promise<{ blocked: string | null }> {
  const mode = exists ? 'update' : 'create';
  const first = await saveCatalogProductWithIdentities({ mode, productId, data: patch });
  if (first.result === 'saved') return { blocked: null };
  if (first.result === 'conflict' && first.kind === 'slug' && 'slug' in patch) {
    const { slug: _dropped, ...withoutSlug } = patch;
    const retry = await saveCatalogProductWithIdentities({
      mode,
      productId,
      data: withoutSlug,
    });
    if (retry.result === 'saved') return { blocked: null };
    return { blocked: describeSaveFailure(retry) };
  }
  return { blocked: describeSaveFailure(first) };
}

export interface PublishSampleInput {
  jobId: string;
  /** Publish at most this many staged products. 0 means "none". */
  limit: number;
  /** Download at most this many distinct source images across the whole run. */
  fetchImages?: number;
  /** Make the sample publicly visible when it satisfies publication rules. */
  makePublic?: boolean;
  /**
   * LOCAL PROOF ONLY. A stand-in image used when no source image could be
   * fetched, so the storefront path can be exercised end to end on a machine
   * that cannot reach the supplier CDN. It goes through the same validation,
   * hashing and media-migration code as a real download — only the transport
   * differs — and production has no call site that supplies it.
   */
  localSeedImage?: { bytes: Buffer; name: string };
  now?: string;
}

export interface BlockedItem {
  parentSku: string;
  reason: string;
}

export interface PublishSampleResult {
  products: number;
  variants: number;
  sourceLinks: number;
  imagesMigrated: number;
  imagesFailed: number;
  /** Products that ended up visible on the storefront. */
  publishedPublic: number;
  blocked: BlockedItem[];
  /** Always true in this branch: calculated USD prices are not activated. */
  usdPricingWithheld: true;
}

interface StagedItem {
  doc: CollectionDoc;
  candidate: CatalogProductCandidate;
  storeListings: StoreListingRecord[];
  inventory: VariantInventory[];
}

function readStagedItem(doc: CollectionDoc): StagedItem | null {
  const candidate = doc.candidate as CatalogProductCandidate | undefined;
  if (candidate === undefined || !Array.isArray(candidate.variants)) return null;
  return {
    doc,
    candidate,
    storeListings: Array.isArray(doc.storeListings)
      ? (doc.storeListings as StoreListingRecord[])
      : [],
    inventory: Array.isArray(doc.inventory) ? (doc.inventory as VariantInventory[]) : [],
  };
}

/**
 * A slug that is unique enough to reserve on first write. The parent SKU is
 * the only stable, human-meaningful handle a source product has; the operator
 * is expected to rewrite it, and the merge never touches it again afterwards.
 */
function seedSlug(candidate: CatalogProductCandidate): string | null {
  return normalizeProductSlug(`${candidate.parentSku}-${candidate.title}`.slice(0, 110));
}

/**
 * Publish a bounded sample of one job's staged products.
 *
 * Bounded on purpose: the acceptance flow inspects a handful of products
 * before anyone lets 77 of them near the catalog.
 */
export async function publishImportedSample(
  input: PublishSampleInput,
): Promise<PublishSampleResult> {
  const now = input.now ?? new Date().toISOString();
  const imageBudget = input.fetchImages ?? 0;
  const seenImageHashes = new Map<string, string>();

  const staged = (await listImportItems(input.jobId))
    .map(readStagedItem)
    .filter((item): item is StagedItem => item !== null)
    .filter((item) => item.doc.status !== 'rejected');

  const result: PublishSampleResult = {
    products: 0,
    variants: 0,
    sourceLinks: 0,
    imagesMigrated: 0,
    imagesFailed: 0,
    publishedPublic: 0,
    blocked: [],
    usdPricingWithheld: true,
  };

  let imagesFetched = 0;

  for (const item of staged.slice(0, Math.max(0, input.limit))) {
    const { candidate } = item;
    const groupKey = candidate.identity.sourceProductKey;

    // 1. Bind (or adopt) the Channel product id for this source family.
    const binding = await bindProduct(groupKey, candidate, now);
    const productId = binding.channelId;
    const existing = await get('products', productId);

    // 2. Resolve the website category. An unmapped source category is a real
    //    answer: the product is still created, as an unpublished draft.
    const mapping = await resolveCategoryMapping(
      candidate.identity.provider,
      candidate.category?.sourceTaxonomy ?? '',
      candidate.category?.sourceCategoryId,
    );

    // 3. Images, for the bounded local proof only.
    const imageIds: string[] = [];
    for (const media of candidate.media) {
      if (imagesFetched >= imageBudget) break;
      imagesFetched += 1;
      const fetched = await fetchSourceImage(media.sourceUrl);
      if (!fetched.ok) {
        // One bad URL costs one image. The product still imports and the URL
        // stays retryable on the next run.
        result.imagesFailed += 1;
        continue;
      }
      const migrated = await migrateImageLocally(
        fetched,
        `${candidate.parentSku} ${media.role}`,
        seenImageHashes,
      );
      if (!migrated.reused) result.imagesMigrated += 1;
      imageIds.push(migrated.imageId);
    }

    // Local-proof fallback: only when the supplier images were unreachable and
    // the caller explicitly supplied a stand-in.
    if (imageIds.length === 0 && input.localSeedImage !== undefined) {
      const mimeType = sniffImageMime(input.localSeedImage.bytes);
      if (mimeType !== null) {
        const migrated = await migrateImageLocally(
          {
            ok: true,
            bytes: input.localSeedImage.bytes,
            mimeType,
            sha256: createHash('sha256').update(input.localSeedImage.bytes).digest('hex'),
            finalUrl: `local-proof:${input.localSeedImage.name}`,
          },
          `LOCAL PROOF placeholder for ${candidate.parentSku}`,
          seenImageHashes,
        );
        if (!migrated.reused) result.imagesMigrated += 1;
        imageIds.push(migrated.imageId);
      }
    }

    // 4. Write the product. On a repeat import every operator-owned field is
    //    read from the existing row and written back unchanged.
    const operatorOwned: Record<string, unknown> = {};
    if (existing !== null) {
      for (const field of OPERATOR_OWNED_PRODUCT_FIELDS) {
        if (Object.hasOwn(existing, field)) operatorOwned[field] = existing[field];
      }
    }

    const seeded: Record<string, unknown> = {
      name: candidate.title,
      archived: false,
      published: false,
      ...(candidate.descriptionText === undefined
        ? {}
        : { description: candidate.descriptionText }),
      ...(mapping === null ? {} : { productFamily: mapping.productFamily }),
      ...(mapping?.channelCategory === undefined ? {} : { category: mapping.channelCategory }),
      ...(imageIds.length === 0 ? {} : { imageIds }),
    };
    const slug = seedSlug(candidate);
    if (slug !== null) seeded.slug = slug;

    const patch: Record<string, unknown> = { ...seeded, ...operatorOwned };
    assertNoAlibabaFields(patch, 'catalog import product write');

    // Routed through the catalog's OWN save, not a raw upsert: that path
    // reserves the slug and SKU code in `catalogProductIdentities` inside the
    // same transaction as the write. Bypassing it would let two imported
    // families claim one slug and quietly shadow each other on the storefront.
    const saved = await writeProduct(productId, patch, existing !== null);
    if (saved.blocked !== null) {
      result.blocked.push({ parentSku: candidate.parentSku, reason: saved.blocked });
      await updateDoc(IMPORT_ITEMS, item.doc._id, {
        status: 'failed',
        errorSummary: saved.blocked,
      });
      continue;
    }
    result.products += 1;

    // 5. Variants and their reconciled inventory.
    const inventoryByKey = new Map(
      item.inventory.map((entry) => [entry.candidateSkuKey, entry] as const),
    );
    let position = 0;
    const variantIds = new Map<string, string>();
    for (const variant of candidate.variants as CatalogVariantCandidate[]) {
      const skuKey = variant.identity.sourceVariantKey ?? '';
      if (skuKey === '') continue;
      const variantBinding = await bindVariant(
        skuKey,
        productId,
        candidate.identity.provider,
        variant.sku,
        now,
      );
      variantIds.set(skuKey, variantBinding.channelId);
      await writeVariant({
        variantId: variantBinding.channelId,
        productId,
        sku: variant.sku,
        position,
        optionValues: variant.optionValues,
        inventory: inventoryByKey.get(skuKey),
        ...(variant.sourceRegularPrice === undefined
          ? {}
          : { sourceRegularPrice: variant.sourceRegularPrice }),
        ...(variant.sourcePromotionPrice === undefined
          ? {}
          : { sourcePromotionPrice: variant.sourcePromotionPrice }),
      });
      position += 1;
      result.variants += 1;
    }

    // 6. Store provenance: one row per shop line, pointing at the Channel ids.
    for (const listing of item.storeListings) {
      const variantId = variantIds.get(listing.candidateSkuKey);
      if (variantId === undefined) continue; // quarantined variant
      await recordStoreLink(listing, productId, variantId, input.jobId, now);
      result.sourceLinks += 1;
    }

    // 7. Optionally make it public. The decision is the CATALOG's, not this
    //    file's: `saveCatalogProductWithIdentities` runs the same publication
    //    rules the admin form runs, so an imported product can never reach the
    //    storefront by a route an operator-edited one could not.
    if (input.makePublic === true) {
      const publishPatch = { published: true };
      assertNoAlibabaFields(publishPatch, 'catalog import publish');
      const promoted = await saveCatalogProductWithIdentities({
        mode: 'update',
        productId,
        data: publishPatch,
      });
      if (promoted.result === 'saved') {
        result.publishedPublic += 1;
      } else {
        result.blocked.push({
          parentSku: candidate.parentSku,
          reason: describeSaveFailure(promoted),
        });
      }
    }

    await updateDoc(IMPORT_ITEMS, item.doc._id, {
      status: 'applied',
      productId,
      appliedAt: now,
    });
  }

  return result;
}
