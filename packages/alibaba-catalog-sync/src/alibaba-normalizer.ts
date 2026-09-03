/**
 * Normalization: product-detail drafts → deterministic source-mirror records
 * and supplier offers with validated pricing (ARCHITECTURE §3.6-3.8, MIU 6).
 *
 * Every constructed pricing object MUST pass validateAlibabaCatalogPricing;
 * anything malformed degrades to the canonical `unavailable` shape (never a
 * throw, never a legacy-field fallback — DESIGN_CHARTER §6.2). Deterministic
 * keys make every downstream write idempotent by document id.
 */
import { createHash } from 'node:crypto';
import type { AlibabaLadderPriceDraft, AlibabaProductDetailDraft } from './alibaba-contracts.ts';
import { parseDecimalToMinorUnits } from './alibaba-money.ts';
import {
  ALIBABA_CATALOG_PRICING_SCHEMA_VERSION,
  type AlibabaCatalogPricing,
  type AlibabaCurrency,
  type AlibabaPriceTier,
  validateAlibabaCatalogPricing,
} from './alibaba-pricing.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Deterministic source key (DESIGN_CHARTER §9). */
export function alibabaSourceKey(connectionId: string, sourceProductId: string): string {
  return sha256(`alibaba|${connectionId}|${sourceProductId}`);
}

/** Product-level offers use a sentinel SKU segment. */
export const PRODUCT_LEVEL_SKU_SENTINEL = '@product';

export function alibabaOfferKey(
  connectionId: string,
  sourceProductId: string,
  sourceSkuId?: string,
): string {
  return sha256(
    `alibaba|${connectionId}|${sourceProductId}|${sourceSkuId ?? PRODUCT_LEVEL_SKU_SENTINEL}`,
  );
}

export interface NormalizedSourceProduct {
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  payloadId: string;
  sourceTitle?: string;
  sourceDescription?: string;
  sourceCategoryId?: string;
  sourceCategoryPath?: string[];
  sourceImageUrls: string[];
  sourceUpdatedAt?: string;
  fetchedAt: string;
  active: true;
  parseVersion: 'alibaba-source-product-v1';
}

export interface NormalizedSupplierOffer {
  offerKey: string;
  sourceKey: string;
  connectionId: string;
  sourceProductId: string;
  sourceSkuId: string;
  active: true;
  sourceAttributes: Record<string, string>;
  sourceAvailability?: number;
  pricing: AlibabaCatalogPricing;
  sourceUpdatedAt?: string;
  syncedAt: string;
}

export type NormalizeResult =
  | {
      ok: true;
      sourceProduct: NormalizedSourceProduct;
      offers: NormalizedSupplierOffer[];
      /** True when a price existed but its currency is outside CNY/USD (quarantine input, §12). */
      unsupportedCurrency: boolean;
    }
  | { ok: false; reason: 'missing-product-id' };

/**
 * Source `gmt_modified`-style lexemes ("2026-08-01 10:00:00") are China
 * standard time; convert to a canonical UTC instant, or drop when unparseable.
 */
export function gmtLexemeToUtcIso(lexeme: string | undefined): string | undefined {
  if (!lexeme) return undefined;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(lexeme)) {
    const ms = Date.parse(`${lexeme.replace(' ', 'T')}+08:00`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const direct = Date.parse(lexeme);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  return undefined;
}

function normalizeCurrency(lexeme: string | undefined): {
  currency?: AlibabaCurrency;
  unsupported: boolean;
} {
  if (lexeme === undefined) return { unsupported: false };
  const upper = lexeme.toUpperCase();
  if (upper === 'USD') return { currency: 'USD', unsupported: false };
  if (upper === 'CNY' || upper === 'RMB') return { currency: 'CNY', unsupported: false };
  return { unsupported: true };
}

interface PricingContext {
  currency?: AlibabaCurrency;
  sourceMoq?: number;
  sourceProductId: string;
  sourceSkuId?: string;
  sourceUpdatedAt?: string;
  syncedAt: string;
  offerKey: string;
}

function unavailablePricing(context: PricingContext): AlibabaCatalogPricing {
  const pricing: AlibabaCatalogPricing = {
    schemaVersion: ALIBABA_CATALOG_PRICING_SCHEMA_VERSION,
    source: 'alibaba',
    mode: 'unavailable',
    sourceOfferKey: context.offerKey,
    sourceProductId: context.sourceProductId,
    syncedAt: context.syncedAt,
  };
  if (context.sourceSkuId !== undefined) pricing.sourceSkuId = context.sourceSkuId;
  if (context.sourceUpdatedAt !== undefined) pricing.sourceUpdatedAt = context.sourceUpdatedAt;
  return pricing;
}

/** Validate-or-degrade: only shapes passing the strict validator are persisted. */
function finalize(
  candidate: AlibabaCatalogPricing,
  context: PricingContext,
): AlibabaCatalogPricing {
  const validated = validateAlibabaCatalogPricing(candidate);
  return validated.ok ? validated.value : unavailablePricing(context);
}

function baseFields(context: PricingContext): Omit<AlibabaCatalogPricing, 'mode'> {
  const base: Omit<AlibabaCatalogPricing, 'mode'> = {
    schemaVersion: ALIBABA_CATALOG_PRICING_SCHEMA_VERSION,
    source: 'alibaba',
    sourceOfferKey: context.offerKey,
    sourceProductId: context.sourceProductId,
    syncedAt: context.syncedAt,
  };
  if (context.currency !== undefined) base.currency = context.currency;
  if (context.sourceMoq !== undefined) base.sourceMoq = context.sourceMoq;
  if (context.sourceSkuId !== undefined) base.sourceSkuId = context.sourceSkuId;
  if (context.sourceUpdatedAt !== undefined) base.sourceUpdatedAt = context.sourceUpdatedAt;
  return base;
}

function fixedPricing(priceLexeme: string, context: PricingContext): AlibabaCatalogPricing {
  const parsed = parseDecimalToMinorUnits(priceLexeme);
  if (!parsed.ok) return unavailablePricing(context);
  return finalize(
    { ...baseFields(context), mode: 'fixed', amountMinor: parsed.minorUnits },
    context,
  );
}

function rangePricing(
  minLexeme: string,
  maxLexeme: string,
  context: PricingContext,
): AlibabaCatalogPricing {
  const min = parseDecimalToMinorUnits(minLexeme);
  const max = parseDecimalToMinorUnits(maxLexeme);
  if (!min.ok || !max.ok) return unavailablePricing(context);
  if (min.minorUnits === max.minorUnits) {
    return finalize(
      { ...baseFields(context), mode: 'fixed', amountMinor: min.minorUnits },
      context,
    );
  }
  return finalize(
    {
      ...baseFields(context),
      mode: 'range',
      minAmountMinor: min.minorUnits,
      maxAmountMinor: max.minorUnits,
    },
    context,
  );
}

function tieredPricing(
  ladders: AlibabaLadderPriceDraft[],
  context: PricingContext,
): AlibabaCatalogPricing {
  const parsedTiers: AlibabaPriceTier[] = [];
  for (const ladder of ladders) {
    if (ladder.minQuantityLexeme === undefined || ladder.priceLexeme === undefined) {
      return unavailablePricing(context);
    }
    if (!/^[0-9]+$/.test(ladder.minQuantityLexeme)) return unavailablePricing(context);
    const minQuantity = Number(ladder.minQuantityLexeme);
    const price = parseDecimalToMinorUnits(ladder.priceLexeme);
    if (!price.ok || !Number.isSafeInteger(minQuantity) || minQuantity <= 0) {
      return unavailablePricing(context);
    }
    parsedTiers.push({ minQuantity, unitAmountMinor: price.minorUnits });
  }
  parsedTiers.sort((a, b) => a.minQuantity - b.minQuantity);
  const tiers: AlibabaPriceTier[] = parsedTiers.map((tier, index) => {
    const next = parsedTiers[index + 1];
    return next ? { ...tier, maxQuantity: next.minQuantity - 1 } : tier;
  });
  // A source MOQ above the first tier start is inconsistent source data; keep
  // the tiers (commercially meaningful) and drop the MOQ rather than degrade.
  const firstTier = tiers[0];
  const moqIncompatible =
    context.sourceMoq !== undefined && firstTier && firstTier.minQuantity > context.sourceMoq;
  const { sourceMoq: _dropped, ...withoutMoq } = context;
  const candidateContext: PricingContext = moqIncompatible ? withoutMoq : context;
  return finalize({ ...baseFields(candidateContext), mode: 'tiered', tiers }, candidateContext);
}

/** Normalize one product detail into its mirror record + offers. */
export function normalizeProductDetail(input: {
  connectionId: string;
  detail: AlibabaProductDetailDraft;
  payloadId: string;
  now: string;
}): NormalizeResult {
  const { connectionId, detail, payloadId, now } = input;
  if (!detail.sourceProductId) return { ok: false, reason: 'missing-product-id' };
  const sourceProductId = detail.sourceProductId;
  const sourceKey = alibabaSourceKey(connectionId, sourceProductId);
  const sourceUpdatedAt = gmtLexemeToUtcIso(detail.gmtModified);
  const { currency, unsupported } = normalizeCurrency(detail.currencyLexeme);

  const moq =
    detail.moqLexeme !== undefined && /^[0-9]+$/.test(detail.moqLexeme)
      ? Number(detail.moqLexeme)
      : undefined;
  const sourceMoq = moq !== undefined && Number.isSafeInteger(moq) && moq > 0 ? moq : undefined;

  const sourceProduct: NormalizedSourceProduct = {
    sourceKey,
    connectionId,
    sourceProductId,
    payloadId,
    sourceImageUrls: detail.imageUrls,
    fetchedAt: now,
    active: true,
    parseVersion: 'alibaba-source-product-v1',
  };
  if (detail.subject !== undefined) sourceProduct.sourceTitle = detail.subject;
  if (detail.description !== undefined) sourceProduct.sourceDescription = detail.description;
  if (detail.categoryId !== undefined) sourceProduct.sourceCategoryId = detail.categoryId;
  if (detail.categoryPath !== undefined) sourceProduct.sourceCategoryPath = detail.categoryPath;
  if (sourceUpdatedAt !== undefined) sourceProduct.sourceUpdatedAt = sourceUpdatedAt;

  const offers: NormalizedSupplierOffer[] = [];
  const contextBase = {
    sourceProductId,
    syncedAt: now,
    ...(currency !== undefined ? { currency } : {}),
    ...(sourceMoq !== undefined ? { sourceMoq } : {}),
    ...(sourceUpdatedAt !== undefined ? { sourceUpdatedAt } : {}),
  };

  if (detail.skus.length > 0) {
    for (const sku of detail.skus) {
      const offerKey = alibabaOfferKey(connectionId, sourceProductId, sku.sourceSkuId);
      const context: PricingContext = { ...contextBase, offerKey, sourceSkuId: sku.sourceSkuId };
      const pricing = unsupported
        ? unavailablePricing(context)
        : sku.ladderPrices && sku.ladderPrices.length > 0
          ? tieredPricing(sku.ladderPrices, context)
          : sku.priceLexeme !== undefined
            ? fixedPricing(sku.priceLexeme, context)
            : unavailablePricing(context);
      const offer: NormalizedSupplierOffer = {
        offerKey,
        sourceKey,
        connectionId,
        sourceProductId,
        sourceSkuId: sku.sourceSkuId,
        active: true,
        sourceAttributes: sku.attributes,
        pricing,
        syncedAt: now,
      };
      if (sku.availableQuantity !== undefined) offer.sourceAvailability = sku.availableQuantity;
      if (sourceUpdatedAt !== undefined) offer.sourceUpdatedAt = sourceUpdatedAt;
      offers.push(offer);
    }
  } else {
    const offerKey = alibabaOfferKey(connectionId, sourceProductId);
    const context: PricingContext = { ...contextBase, offerKey };
    let pricing: AlibabaCatalogPricing;
    if (unsupported) {
      pricing = unavailablePricing(context);
    } else if (detail.ladderPrices.length > 0) {
      pricing = tieredPricing(detail.ladderPrices, context);
    } else if (detail.fobMinLexeme !== undefined && detail.fobMaxLexeme !== undefined) {
      pricing = rangePricing(detail.fobMinLexeme, detail.fobMaxLexeme, context);
    } else {
      pricing = unavailablePricing(context);
    }
    const offer: NormalizedSupplierOffer = {
      offerKey,
      sourceKey,
      connectionId,
      sourceProductId,
      sourceSkuId: PRODUCT_LEVEL_SKU_SENTINEL,
      active: true,
      sourceAttributes: {},
      pricing,
      syncedAt: now,
    };
    if (sourceUpdatedAt !== undefined) offer.sourceUpdatedAt = sourceUpdatedAt;
    offers.push(offer);
  }

  return { ok: true, sourceProduct, offers, unsupportedCurrency: unsupported };
}
