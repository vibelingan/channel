/** Manual products get the same approved version as synced ones (MIU-27, DEC-4/16). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planCatalogDetailApproval } from './detail-approval.ts';
import { manualDetailCandidate, manualFacts } from './manual-detail.ts';

const manual = (extra: Record<string, unknown> = {}) => {
  const product = {
    _id: 'm1',
    name: 'Kids headset',
    description: 'Soft ear pads',
    imageIds: ['img-1'],
    productFamily: 'headphones',
    skuCode: 'KH-01',
    series: '  S1 ',
    modName: '',
    modType: 'Over-ear',
    ...extra,
  };
  return {
    ...product,
    detailSourceReady: true,
    detailSourceOwner: 'manual:m1',
    detailSourceCandidate: manualDetailCandidate(product),
  };
};
const plan = (product: Record<string, unknown>) =>
  planCatalogDetailApproval({ product, variants: [], revision: 'r1' }).publication;

test('manual facts: SKU, Series, Model, Type, trimmed, empty values dropped', () => {
  assert.deepEqual(manualFacts(manual()), [
    { name: 'SKU', value: 'KH-01' },
    { name: 'Series', value: 'S1' },
    { name: 'Type', value: 'Over-ear' },
  ]);
  assert.deepEqual(manualFacts({ _id: 'x', name: 'x' }), []);
});

test('the manual candidate is an empty header the planner fills from the row', () => {
  assert.deepEqual(manualDetailCandidate({ _id: 'm1', name: 'Kids headset' }), {
    schemaVersion: 'catalog-product-detail-v1',
    _id: 'm1',
    name: 'Kids headset',
    images: [],
    facts: [],
    offers: [],
  });
  const header = plan(manual()).header;
  assert.equal(header.name, 'Kids headset');
  assert.deepEqual(header.images, ['/api/images/img-1']);
  assert.equal(header.descriptionText, 'Soft ear pads');
  assert.deepEqual(header.facts, manualFacts(manual()));
});

test('manual tiered pricing becomes the website price and the card summary', () => {
  const publication = plan(
    manual({
      catalogPricingMode: 'manual',
      manualCatalogPricing: {
        schemaVersion: 'manual-catalog-pricing-v1',
        currency: 'USD',
        tiers: [
          { minQuantity: 1, maxQuantity: 12, unitAmountMinor: 13_418 },
          { minQuantity: 13, unitAmountMinor: 11_831 },
        ],
      },
    }),
  );
  assert.equal(publication.header.websitePricing?.pricing.mode, 'tiered');
  assert.equal(publication.priceSummary?.source, 'website');
});

test('a scalar price keeps its MOQ; no price but an MOQ is "request a quote" with the MOQ (DEC-16)', () => {
  assert.deepEqual(plan(manual({ unitPrice: 9.5, moq: 2 })).header.websitePricing, {
    basis: 'website-manual',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 950, minimumOrderQuantity: 2 },
  });
  const moqOnly = plan(manual({ moq: 50 }));
  assert.deepEqual(moqOnly.header.websitePricing, {
    basis: 'website-manual',
    pricing: { mode: 'unavailable', minimumOrderQuantity: 50 },
  });
  assert.deepEqual(moqOnly.priceSummary, {
    source: 'website',
    pricing: { mode: 'unavailable', minimumOrderQuantity: 50 },
  });
  assert.equal(plan(manual()).header.websitePricing, undefined);
});

test('a linked product keeps the facts from its source candidate', () => {
  const linked = manual({ modName: 'M-1' });
  const sourceFacts = [{ name: 'Material', value: 'ABS' }];
  const publication = plan({
    ...linked,
    detailSourceOwner: 'alibaba:source-a',
    detailSourceCandidate: { ...linked.detailSourceCandidate, facts: sourceFacts },
  });
  assert.deepEqual(publication.header.facts, sourceFacts);
});
