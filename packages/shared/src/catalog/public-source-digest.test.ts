import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogOfferPricing } from './offer-pricing.ts';
import { publicSourceDigest } from './public-source-digest.ts';

// A real observation carries more than the digest reads; the index signatures
// let the fixture hold those extra fields like the stored rows do.
type Fact = { sourceName: string; value: string | number | boolean; [key: string]: unknown };
type Media = { sourceUrl: string; [key: string]: unknown };
interface Fixture {
  [key: string]: unknown;
  identity: { attributes: Fact[]; [key: string]: unknown };
  content: { description?: { text?: string; [key: string]: unknown }; media: Media[] };
  variants: { sourceVariantKey: string; options: Fact[]; media: Media[]; [key: string]: unknown }[];
  offers: {
    sourceOfferKey: string;
    sourceVariantKey?: string;
    kind: string;
    pricing: CatalogOfferPricing;
    [key: string]: unknown;
  }[];
}

const observation = (): Fixture => ({
  schemaVersion: 'catalog-source-observation-v1',
  source: { observedAt: '2026-10-01T00:00:00.000Z', captureMode: 'full' },
  identity: {
    title: 'Supplier title',
    attributes: [
      { sourceName: 'Material', value: 'ABS' },
      { sourceName: 'Driver', value: 40 },
    ],
  },
  content: {
    description: { text: '  Comfortable headset.  ', placeholder: false },
    media: [
      { sourceUrl: 'https://img.example/1.jpg', role: 'primary', position: 0 },
      { sourceUrl: 'https://img.example/2.jpg', role: 'gallery', position: 1 },
    ],
  },
  variants: [
    {
      sourceVariantKey: 'black',
      options: [{ sourceName: 'Color', value: 'Black' }],
      inventory: [{ quantity: 10 }],
      media: [{ sourceUrl: 'https://img.example/black.jpg', role: 'variant', position: 0 }],
    },
    {
      sourceVariantKey: 'white',
      options: [{ sourceName: 'Color', value: 'White' }],
      inventory: [{ quantity: 3 }],
      media: [],
    },
  ],
  offers: [
    {
      sourceOfferKey: 'o-black',
      sourceVariantKey: 'black',
      kind: 'supplier',
      pricing: {
        mode: 'tiered',
        currency: 'USD',
        tiers: [
          { minimumQuantity: 2, maximumQuantity: 99, unitAmountMinor: 661 },
          { minimumQuantity: 100, unitAmountMinor: 555 },
        ],
      },
    },
    {
      sourceOfferKey: 'o-white',
      sourceVariantKey: 'white',
      kind: 'supplier',
      pricing: { mode: 'fixed', currency: 'USD', amountMinor: 430, minimumOrderQuantity: 1000 },
    },
  ],
  evidence: [{ kind: 'raw-payload', evidenceId: 'payload-1' }],
});
type Mutable = Fixture;
const digestAfter = (change: (value: Mutable) => void) => {
  const value = observation();
  change(value);
  return publicSourceDigest(value);
};
const base = publicSourceDigest(observation());

test('a sha256 hex digest that ignores capture details, stock, evidence and the title', () => {
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(
    digestAfter((value) => {
      (value.source as Record<string, unknown>).observedAt = '2026-10-08T00:00:00.000Z';
      (value.source as Record<string, unknown>).captureMode = 'incremental';
      (value.variants[0] as Record<string, unknown>).inventory = [{ quantity: 0 }];
      value.evidence = [{ kind: 'raw-payload', evidenceId: 'payload-2' }];
      (value.identity as Record<string, unknown>).title = 'Renamed by the supplier';
      (value.content.description as Record<string, unknown>).text = 'Comfortable headset.';
    }),
    base,
  );
});

test('the order of offers inside the data does not matter, only their content', () => {
  assert.equal(
    digestAfter((value) => {
      value.offers.reverse();
      value.variants.reverse();
    }),
    base,
  );
});

test('every change a buyer would see changes the digest', () => {
  const changes: Array<[string, (value: Mutable) => void]> = [
    [
      'tier amount',
      (v) => {
        const pricing = v.offers[0]?.pricing;
        if (pricing?.mode === 'tiered' && pricing.tiers[1]) pricing.tiers[1].unitAmountMinor = 554;
      },
    ],
    [
      'minimum order',
      (v) => {
        const pricing = v.offers[1]?.pricing;
        if (pricing?.mode === 'fixed') pricing.minimumOrderQuantity = 500;
      },
    ],
    [
      'SKU added',
      (v) => {
        v.variants.push({
          sourceVariantKey: 'pink',
          options: [{ sourceName: 'Color', value: 'Pink' }],
          media: [],
        });
      },
    ],
    [
      'option value',
      (v) => {
        const option = v.variants[1]?.options[0];
        if (option) option.value = 'Ivory';
      },
    ],
    [
      'media order',
      (v) => {
        v.content.media.reverse();
      },
    ],
    [
      'SKU photo',
      (v) => {
        const media = v.variants[0]?.media[0];
        if (media) media.sourceUrl = 'https://img.example/black-2.jpg';
      },
    ],
    [
      'specification fact',
      (v) => {
        const fact = v.identity.attributes[1];
        if (fact) fact.value = 50;
      },
    ],
    [
      'description text',
      (v) => {
        if (v.content.description) v.content.description.text = 'A different description.';
      },
    ],
    [
      'product-level offer',
      (v) => {
        v.offers.push({
          sourceOfferKey: 'o-product',
          kind: 'supplier',
          pricing: { mode: 'fixed', currency: 'USD', amountMinor: 390 },
        });
      },
    ],
  ];
  for (const [name, change] of changes) assert.notEqual(digestAfter(change), base, name);
});

test('extra keys on any object never change the digest (fields are picked explicitly)', () => {
  assert.equal(
    digestAfter((value) => {
      (value.offers[0] as Record<string, unknown>).storeKey = 'store';
      (value.content.media[0] as Record<string, unknown>).variantSku = 'SKU-1';
      (value.identity.attributes[0] as Record<string, unknown>).canonicalKey = 'material';
    }),
    base,
  );
});

test('several offers on one configuration: their order does not matter, their content does', () => {
  const twoOffers = (amounts: number[]) =>
    digestAfter((value) => {
      value.offers = amounts.map((amountMinor, index) => ({
        sourceOfferKey: `o-${index}`,
        sourceVariantKey: 'black',
        kind: 'supplier',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor },
      }));
    });
  assert.equal(twoOffers([430, 500]), twoOffers([500, 430]));
  assert.notEqual(twoOffers([430, 500]), twoOffers([430, 501]));
});

test('whitespace around a fact is not a change', () => {
  assert.equal(
    digestAfter((value) => {
      const fact = value.identity.attributes[0];
      if (fact) fact.value = '  ABS ';
    }),
    base,
  );
});
