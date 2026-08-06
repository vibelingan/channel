/**
 * AlibabaCatalogPricing — the provider-specific materialized pricing contract
 * (DESIGN_CHARTER §6.2, revised per REVISION_R1 M1/L1).
 *
 * The validator is deliberately strict: unknown keys are rejected and every
 * per-mode absent field is REQUIRED-ABSENT, because canonical objects feed
 * candidate hashing (ARCHITECTURE §12) — two writers must never produce
 * different byte shapes for the same commercial fact.
 */

import { isValidMinorUnits } from './alibaba-money.ts';

export type AlibabaPriceMode = 'fixed' | 'range' | 'tiered' | 'negotiable' | 'unavailable';

export type AlibabaCurrency = 'CNY' | 'USD';

export interface AlibabaPriceTier {
  minQuantity: number;
  maxQuantity?: number;
  unitAmountMinor: number;
}

export interface AlibabaCatalogPricing {
  schemaVersion: 'alibaba-catalog-pricing-v1';
  source: 'alibaba';
  /** Required for amount-bearing modes; optional for negotiable/unavailable. */
  currency?: AlibabaCurrency;
  mode: AlibabaPriceMode;
  amountMinor?: number;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  tiers?: AlibabaPriceTier[];
  sourceMoq?: number;
  sourceOfferKey?: string;
  sourceProductId?: string;
  sourceSkuId?: string;
  sourceUpdatedAt?: string;
  syncedAt: string;
}

export const ALIBABA_CATALOG_PRICING_SCHEMA_VERSION = 'alibaba-catalog-pricing-v1';

export type PricingValidationResult =
  | { ok: true; value: AlibabaCatalogPricing }
  | { ok: false; errors: string[] };

const MODES: readonly AlibabaPriceMode[] = [
  'fixed',
  'range',
  'tiered',
  'negotiable',
  'unavailable',
];
const CURRENCIES: readonly AlibabaCurrency[] = ['CNY', 'USD'];
const AMOUNT_BEARING_MODES: readonly AlibabaPriceMode[] = ['fixed', 'range', 'tiered'];

const KNOWN_KEYS = new Set([
  'schemaVersion',
  'source',
  'currency',
  'mode',
  'amountMinor',
  'minAmountMinor',
  'maxAmountMinor',
  'tiers',
  'sourceMoq',
  'sourceOfferKey',
  'sourceProductId',
  'sourceSkuId',
  'sourceUpdatedAt',
  'syncedAt',
]);

const KNOWN_TIER_KEYS = new Set(['minQuantity', 'maxQuantity', 'unitAmountMinor']);

/**
 * Canonical UTC instant, lexicographically ordered — the same shape the DB
 * adapter's stale-holder compares rely on (`2026-08-06T07:00:00.000Z` or the
 * second-precision variant).
 */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function isCanonicalUtcInstant(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validateTiers(tiers: unknown, errors: string[]): tiers is AlibabaPriceTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('tiers must be a non-empty array for tiered pricing');
    return false;
  }
  let sound = true;
  for (const [index, tier] of tiers.entries()) {
    if (typeof tier !== 'object' || tier === null || Array.isArray(tier)) {
      errors.push(`tiers[${index}] must be an object`);
      sound = false;
      continue;
    }
    for (const key of Object.keys(tier)) {
      if (!KNOWN_TIER_KEYS.has(key)) {
        errors.push(`tiers[${index}] has unknown key "${key}"`);
        sound = false;
      }
    }
    const { minQuantity, maxQuantity, unitAmountMinor } = tier as Record<string, unknown>;
    if (!isPositiveInteger(minQuantity)) {
      errors.push(`tiers[${index}].minQuantity must be a positive integer`);
      sound = false;
    }
    if (maxQuantity !== undefined && !isPositiveInteger(maxQuantity)) {
      errors.push(`tiers[${index}].maxQuantity must be a positive integer when present`);
      sound = false;
    }
    if (!isValidMinorUnits(unitAmountMinor)) {
      errors.push(`tiers[${index}].unitAmountMinor must be a non-negative safe integer`);
      sound = false;
    }
    if (
      isPositiveInteger(minQuantity) &&
      maxQuantity !== undefined &&
      isPositiveInteger(maxQuantity) &&
      maxQuantity < minQuantity
    ) {
      errors.push(`tiers[${index}].maxQuantity must be >= minQuantity`);
      sound = false;
    }
  }
  if (!sound) return false;

  const typed = tiers as AlibabaPriceTier[];
  for (let i = 0; i < typed.length; i += 1) {
    const tier = typed[i] as AlibabaPriceTier;
    const next = typed[i + 1];
    if (tier.maxQuantity === undefined && i !== typed.length - 1) {
      errors.push(`tiers[${i}] is open-ended but not the final tier`);
      sound = false;
    }
    if (next) {
      if (next.minQuantity <= tier.minQuantity) {
        errors.push(
          'tiers must be sorted strictly ascending by minQuantity with no duplicate starts',
        );
        sound = false;
      } else if (tier.maxQuantity !== undefined && next.minQuantity <= tier.maxQuantity) {
        errors.push(`tiers[${i}] and tiers[${i + 1}] overlap`);
        sound = false;
      }
    }
  }
  return sound;
}

export function validateAlibabaCatalogPricing(value: unknown): PricingValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['pricing must be a plain object'] };
  }
  const errors: string[] = [];
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }

  if (record.schemaVersion !== ALIBABA_CATALOG_PRICING_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${ALIBABA_CATALOG_PRICING_SCHEMA_VERSION}"`);
  }
  if (record.source !== 'alibaba') {
    errors.push('source must be "alibaba"');
  }

  const mode = record.mode as AlibabaPriceMode;
  if (!MODES.includes(mode)) {
    errors.push(`mode must be one of ${MODES.join('/')}`);
    return { ok: false, errors };
  }

  if (!isCanonicalUtcInstant(record.syncedAt)) {
    errors.push('syncedAt must be a canonical UTC instant (YYYY-MM-DDTHH:mm:ss[.SSS]Z)');
  }
  if (record.sourceUpdatedAt !== undefined && !isCanonicalUtcInstant(record.sourceUpdatedAt)) {
    errors.push('sourceUpdatedAt must be a canonical UTC instant when present');
  }

  // Currency: required + valid for amount-bearing modes, optional-but-valid otherwise.
  const amountBearing = AMOUNT_BEARING_MODES.includes(mode);
  if (record.currency === undefined) {
    if (amountBearing) errors.push(`currency is required for ${mode} pricing`);
  } else if (!CURRENCIES.includes(record.currency as AlibabaCurrency)) {
    errors.push('currency must be CNY or USD');
  }

  // Per-mode field matrix (R1): absent fields are required-absent.
  const forbid = (key: string) => {
    if (record[key] !== undefined) errors.push(`${key} must be absent for ${mode} pricing`);
  };
  switch (mode) {
    case 'fixed': {
      if (!isValidMinorUnits(record.amountMinor)) {
        errors.push('amountMinor must be a non-negative safe integer for fixed pricing');
      }
      forbid('minAmountMinor');
      forbid('maxAmountMinor');
      forbid('tiers');
      break;
    }
    case 'range': {
      const min = record.minAmountMinor;
      const max = record.maxAmountMinor;
      if (!isValidMinorUnits(min))
        errors.push('minAmountMinor must be a non-negative safe integer for range pricing');
      if (!isValidMinorUnits(max))
        errors.push('maxAmountMinor must be a non-negative safe integer for range pricing');
      if (isValidMinorUnits(min) && isValidMinorUnits(max) && min > max) {
        errors.push('range pricing requires minAmountMinor <= maxAmountMinor');
      }
      forbid('amountMinor');
      forbid('tiers');
      break;
    }
    case 'tiered': {
      forbid('amountMinor');
      forbid('minAmountMinor');
      forbid('maxAmountMinor');
      if (validateTiers(record.tiers, errors)) {
        const tiers = record.tiers as AlibabaPriceTier[];
        const first = tiers[0];
        if (
          first &&
          record.sourceMoq !== undefined &&
          isPositiveInteger(record.sourceMoq) &&
          first.minQuantity > record.sourceMoq
        ) {
          errors.push('first tier minQuantity must not exceed sourceMoq');
        }
      }
      break;
    }
    case 'negotiable':
    case 'unavailable': {
      forbid('amountMinor');
      forbid('minAmountMinor');
      forbid('maxAmountMinor');
      forbid('tiers');
      break;
    }
  }

  if (record.sourceMoq !== undefined && !isPositiveInteger(record.sourceMoq)) {
    errors.push('sourceMoq must be a positive integer when present');
  }
  for (const key of ['sourceOfferKey', 'sourceProductId', 'sourceSkuId'] as const) {
    const v = record[key];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      errors.push(`${key} must be a non-empty string when present`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: record as unknown as AlibabaCatalogPricing };
}
