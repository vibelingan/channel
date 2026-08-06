import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type OfferForSelection,
  buildPromotionCandidate,
  computeCandidateHash,
  minimumUnitAmount,
  priceMoveExceedsThreshold,
  selectPrimaryOffer,
} from './alibaba-merge-policy.ts';
import type { AlibabaCatalogPricing } from './alibaba-pricing.ts';

const NOW = '2026-08-06T12:00:00.000Z';

// Overrides may pass explicit `undefined` to REMOVE a base field; stripped
// before the cast so exactOptionalPropertyTypes stays satisfied.
const pricing = (
  over: { [K in keyof AlibabaCatalogPricing]?: AlibabaCatalogPricing[K] | undefined },
): AlibabaCatalogPricing => {
  const merged: Record<string, unknown> = {
    schemaVersion: 'alibaba-catalog-pricing-v1',
    source: 'alibaba',
    mode: 'fixed',
    currency: 'USD',
    amountMinor: 100,
    syncedAt: NOW,
    ...over,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as AlibabaCatalogPricing;
};

const offer = (
  key: string,
  sku: string,
  p: { [K in keyof AlibabaCatalogPricing]?: AlibabaCatalogPricing[K] | undefined },
  active = true,
): OfferForSelection => ({
  offerKey: key,
  sourceKey: 'sk',
  sourceSkuId: sku,
  active,
  pricing: pricing(p),
});

// --- selection ---------------------------------------------------------------

test('minimum unit amount per mode', () => {
  assert.equal(minimumUnitAmount(pricing({ mode: 'fixed', amountMinor: 250 })), 250);
  assert.equal(
    minimumUnitAmount(
      pricing({ mode: 'range', amountMinor: undefined, minAmountMinor: 150, maxAmountMinor: 300 }),
    ),
    150,
  );
  assert.equal(
    minimumUnitAmount(
      pricing({
        mode: 'tiered',
        amountMinor: undefined,
        tiers: [
          { minQuantity: 10, maxQuantity: 99, unitAmountMinor: 500 },
          { minQuantity: 100, unitAmountMinor: 400 },
        ],
      }),
    ),
    400,
  );
  assert.equal(
    minimumUnitAmount(pricing({ mode: 'negotiable', amountMinor: undefined, currency: undefined })),
    undefined,
  );
});

test('selection picks the lowest minimum in the highest-priority currency', () => {
  const cheapCny = offer('o-cny', 'sku-a', { currency: 'CNY', amountMinor: 10 });
  const usd = offer('o-usd', 'sku-b', { currency: 'USD', amountMinor: 900 });
  // USD outranks CNY even when CNY is numerically lower — never cross-compared.
  assert.equal(selectPrimaryOffer([cheapCny, usd])?.offerKey, 'o-usd');
  const cheaperUsd = offer('o-usd2', 'sku-c', { currency: 'USD', amountMinor: 800 });
  assert.equal(selectPrimaryOffer([cheapCny, usd, cheaperUsd])?.offerKey, 'o-usd2');
});

test('operator pin wins while valid; a stale pin falls back to automatic', () => {
  const a = offer('o-a', 'sku-a', { amountMinor: 100 });
  const b = offer('o-b', 'sku-b', { amountMinor: 200 });
  assert.equal(selectPrimaryOffer([a, b], 'o-b')?.offerKey, 'o-b');
  assert.equal(selectPrimaryOffer([a, b], 'o-gone')?.offerKey, 'o-a');
  const inactivePinned = offer('o-b', 'sku-b', { amountMinor: 200 }, false);
  assert.equal(selectPrimaryOffer([a, inactivePinned], 'o-b')?.offerKey, 'o-a');
});

test('negotiable outranks unavailable; all-negotiable selects the lexical winner', () => {
  const negotiable = offer('o-n', 'sku-b', {
    mode: 'negotiable',
    amountMinor: undefined,
    currency: undefined,
  });
  const unavailable = offer('o-u', 'sku-a', {
    mode: 'unavailable',
    amountMinor: undefined,
    currency: undefined,
  });
  assert.equal(selectPrimaryOffer([unavailable, negotiable])?.offerKey, 'o-n');
  const negotiable2 = offer('o-n2', 'sku-a', {
    mode: 'negotiable',
    amountMinor: undefined,
    currency: undefined,
  });
  assert.equal(selectPrimaryOffer([negotiable, negotiable2])?.offerKey, 'o-n2', 'sku-a < sku-b');
});

test('selection is deterministic under permutation and ignores inactive offers', () => {
  const offers = [
    offer('o-1', 'sku-1', { amountMinor: 300 }),
    offer('o-2', 'sku-2', { amountMinor: 100 }, false),
    offer('o-3', 'sku-3', { amountMinor: 200 }),
  ];
  const pick = selectPrimaryOffer(offers)?.offerKey;
  assert.equal(pick, 'o-3', 'inactive cheapest is skipped');
  assert.equal(selectPrimaryOffer([...offers].reverse())?.offerKey, pick);
  assert.equal(selectPrimaryOffer([]), undefined);
});

// --- promotion candidate -----------------------------------------------------

test('active source with an amount-bearing offer promotes available pricing', () => {
  const candidate = buildPromotionCandidate({
    sourceKey: 'sk',
    offers: [offer('o-1', 'sku-1', { amountMinor: 250 })],
    source: { active: true },
    now: NOW,
  });
  assert.equal(candidate.patch.alibabaPrimaryOfferKey, 'o-1');
  assert.equal(candidate.patch.alibabaSourceStatus, 'available');
  assert.equal(candidate.patch.alibabaCatalogPricing?.amountMinor, 250);
  assert.equal(candidate.patch.alibabaCatalogPricing?.syncedAt, NOW);
});

test('source deletion keeps the canonical unavailable object with provenance', () => {
  const candidate = buildPromotionCandidate({
    sourceKey: 'sk',
    offers: [
      offer('o-1', 'sku-1', { amountMinor: 250, sourceProductId: '987', sourceSkuId: 'sku-1' }),
    ],
    source: { active: false },
    now: NOW,
  });
  assert.equal(candidate.patch.alibabaSourceStatus, 'removed');
  const p = candidate.patch.alibabaCatalogPricing;
  assert.equal(p?.mode, 'unavailable');
  assert.equal(p?.amountMinor, undefined, 'numeric fields required-absent');
  assert.equal(p?.currency, undefined);
  assert.equal(p?.sourceProductId, '987', 'provenance survives');
  assert.equal(p?.syncedAt, NOW);
});

test('no active offers yields unavailable status and null pricing', () => {
  const candidate = buildPromotionCandidate({
    sourceKey: 'sk',
    offers: [offer('o-1', 'sku-1', { amountMinor: 100 }, false)],
    source: { active: true },
    now: NOW,
  });
  assert.equal(candidate.patch.alibabaPrimaryOfferKey, null);
  assert.equal(candidate.patch.alibabaCatalogPricing, null);
  assert.equal(candidate.patch.alibabaSourceStatus, 'unavailable');
});

// --- price move + candidate hash --------------------------------------------

test('price moves above 30% trip the alert; currency changes never compare', () => {
  const before = pricing({ amountMinor: 100 });
  assert.equal(priceMoveExceedsThreshold(before, pricing({ amountMinor: 129 })), false);
  assert.equal(priceMoveExceedsThreshold(before, pricing({ amountMinor: 131 })), true);
  assert.equal(priceMoveExceedsThreshold(before, pricing({ amountMinor: 65 })), true);
  assert.equal(
    priceMoveExceedsThreshold(before, pricing({ currency: 'CNY', amountMinor: 900 })),
    false,
    'cross-currency is incomparable, not a move',
  );
  assert.equal(priceMoveExceedsThreshold(null, pricing({ amountMinor: 500 })), false);
  assert.equal(
    priceMoveExceedsThreshold(
      before,
      pricing({ mode: 'unavailable', amountMinor: undefined, currency: undefined }),
    ),
    false,
  );
});

test('candidate hash is canonical: key order and undefined never matter', () => {
  const a = computeCandidateHash({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
  const b = computeCandidateHash({ z: { a: 1, b: 2 }, y: [1, 2], x: 1, w: undefined });
  assert.equal(a, b);
  assert.notEqual(a, computeCandidateHash({ x: 1, y: [2, 1], z: { a: 1, b: 2 } }));
});
