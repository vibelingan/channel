/**
 * Primary-offer selection + product promotion patches (ARCHITECTURE §5/§7,
 * MIU 8). Pure: the function layer supplies documents and applies patches
 * through the FENCED write; nothing here touches storage.
 *
 * Selection is a TOTAL order (R1 M2): operator pin when still valid; else
 * amount-bearing offers within the highest-priority currency present
 * (USD > CNY — amounts are never compared across currencies, FX is banned);
 * else negotiable outranks unavailable; final tie-break is lexical
 * (sourceKey, then sourceSkuId). An all-negotiable set materializes the
 * tie-break winner's negotiable pricing.
 */
import { createHash } from 'node:crypto';
import type { AlibabaCatalogPricing, AlibabaCurrency } from './alibaba-pricing.ts';

export interface OfferForSelection {
  offerKey: string;
  sourceKey: string;
  sourceSkuId: string;
  active: boolean;
  pricing: AlibabaCatalogPricing;
  sourceAvailability?: number;
}

/** Representative minimum unit amount for an amount-bearing pricing shape. */
export function minimumUnitAmount(pricing: AlibabaCatalogPricing): number | undefined {
  switch (pricing.mode) {
    case 'fixed':
      return pricing.amountMinor;
    case 'range':
      return pricing.minAmountMinor;
    case 'tiered': {
      const amounts = (pricing.tiers ?? []).map((tier) => tier.unitAmountMinor);
      return amounts.length > 0 ? Math.min(...amounts) : undefined;
    }
    default:
      return undefined;
  }
}

const CURRENCY_PRIORITY: readonly AlibabaCurrency[] = ['USD', 'CNY'];
const MODE_RANK: Record<AlibabaCatalogPricing['mode'], number> = {
  fixed: 0,
  range: 0,
  tiered: 0,
  negotiable: 1,
  unavailable: 2,
};

function lexicalTieBreak(a: OfferForSelection, b: OfferForSelection): number {
  if (a.sourceKey !== b.sourceKey) return a.sourceKey < b.sourceKey ? -1 : 1;
  if (a.sourceSkuId !== b.sourceSkuId) return a.sourceSkuId < b.sourceSkuId ? -1 : 1;
  return 0;
}

/** Deterministic primary-offer choice across ACTIVE offers; undefined for an empty set. */
export function selectPrimaryOffer(
  offers: readonly OfferForSelection[],
  pinnedOfferKey?: string,
): OfferForSelection | undefined {
  const active = offers.filter((offer) => offer.active);
  if (active.length === 0) return undefined;
  if (pinnedOfferKey) {
    const pinned = active.find((offer) => offer.offerKey === pinnedOfferKey);
    if (pinned) return pinned;
    // Invalid/stale pin falls through to automatic selection.
  }
  const amountBearing = active.filter((offer) => minimumUnitAmount(offer.pricing) !== undefined);
  if (amountBearing.length > 0) {
    const currency = CURRENCY_PRIORITY.find((candidate) =>
      amountBearing.some((offer) => offer.pricing.currency === candidate),
    );
    const pool = amountBearing.filter((offer) => offer.pricing.currency === currency);
    pool.sort((a, b) => {
      const amountA = minimumUnitAmount(a.pricing) ?? Number.MAX_SAFE_INTEGER;
      const amountB = minimumUnitAmount(b.pricing) ?? Number.MAX_SAFE_INTEGER;
      if (amountA !== amountB) return amountA - amountB;
      return lexicalTieBreak(a, b);
    });
    return pool[0];
  }
  const ranked = [...active].sort((a, b) => {
    const rank = MODE_RANK[a.pricing.mode] - MODE_RANK[b.pricing.mode];
    if (rank !== 0) return rank;
    return lexicalTieBreak(a, b);
  });
  return ranked[0];
}

export interface PromotionSource {
  active: boolean;
}

export interface PromotionInput {
  sourceKey: string;
  offers: readonly OfferForSelection[];
  source: PromotionSource;
  pinnedOfferKey?: string;
  now: string;
}

export interface PromotionCandidate {
  /** ONLY Alibaba-owned additive fields — never curated, never legacy pricing. */
  patch: {
    alibabaPrimaryOfferKey: string | null;
    alibabaCatalogPricing: AlibabaCatalogPricing | null;
    alibabaSourceStatus: 'available' | 'unavailable' | 'removed';
    alibabaSourceLastSyncedAt: string;
  };
}

/**
 * Build the promotion patch for a linked product. Source deletion keeps the
 * materialized object with mode 'unavailable' (R1 canonical form) so
 * provenance and syncedAt survive.
 */
export function buildPromotionCandidate(input: PromotionInput): PromotionCandidate {
  const selected = selectPrimaryOffer(input.offers, input.pinnedOfferKey);
  if (!input.source.active) {
    // R1 canonical source-deleted form: keep the object, mode 'unavailable',
    // provenance + syncedAt survive; numeric fields are REQUIRED-ABSENT.
    const base = selected
      ? (stripUndefined({
          schemaVersion: selected.pricing.schemaVersion,
          source: selected.pricing.source,
          mode: 'unavailable',
          sourceMoq: selected.pricing.sourceMoq,
          sourceOfferKey: selected.pricing.sourceOfferKey,
          sourceProductId: selected.pricing.sourceProductId,
          sourceSkuId: selected.pricing.sourceSkuId,
          sourceUpdatedAt: selected.pricing.sourceUpdatedAt,
          syncedAt: input.now,
        } as Record<string, unknown>) as unknown as AlibabaCatalogPricing)
      : null;
    return {
      patch: {
        alibabaPrimaryOfferKey: selected?.offerKey ?? null,
        alibabaCatalogPricing: base,
        alibabaSourceStatus: 'removed',
        alibabaSourceLastSyncedAt: input.now,
      },
    };
  }
  if (!selected) {
    return {
      patch: {
        alibabaPrimaryOfferKey: null,
        alibabaCatalogPricing: null,
        alibabaSourceStatus: 'unavailable',
        alibabaSourceLastSyncedAt: input.now,
      },
    };
  }
  const pricing = stripUndefined({ ...selected.pricing, syncedAt: input.now });
  const amountBearing = minimumUnitAmount(pricing) !== undefined;
  return {
    patch: {
      alibabaPrimaryOfferKey: selected.offerKey,
      alibabaCatalogPricing: pricing,
      alibabaSourceStatus:
        amountBearing || pricing.mode === 'negotiable' ? 'available' : 'unavailable',
      alibabaSourceLastSyncedAt: input.now,
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/**
 * Item-level price-move audit (DESIGN_CHARTER §6.3): moves above the ratio
 * are alerted but still applied on a healthy run.
 */
export const PRICE_MOVE_ALERT_RATIO = 0.3;

export function priceMoveExceedsThreshold(
  previous: AlibabaCatalogPricing | null | undefined,
  next: AlibabaCatalogPricing | null | undefined,
): boolean {
  const before = previous ? minimumUnitAmount(previous) : undefined;
  const after = next ? minimumUnitAmount(next) : undefined;
  if (before === undefined || after === undefined || before === 0) return false;
  if (previous?.currency !== next?.currency) return false; // incomparable, not a move
  return Math.abs(after - before) / before > PRICE_MOVE_ALERT_RATIO;
}

/** Canonical, key-sorted JSON hash — the immutable quarantine candidate id (§12). */
export function computeCandidateHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
