import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogOfferView } from './catalog-offer-view.ts';
const tiered = {
  mode: 'tiered',
  currency: 'USD',
  minimumOrderQuantity: 2,
  tiers: [
    { minimumQuantity: 2, maximumQuantity: 499, unitAmountMinor: 570 },
    { minimumQuantity: 500, maximumQuantity: 999, unitAmountMinor: 500 },
    { minimumQuantity: 1000, unitAmountMinor: 380 },
  ],
};
test('exact boundaries select the applicable source tier while MOQ and gaps never borrow a price', () => {
  assert.deepEqual(catalogOfferView(tiered, 1), { status: 'below-moq', minimum: 2 });
  for (const [quantity, amountMinor, tierIndex] of [
    [2, 570, 0],
    [499, 570, 0],
    [500, 500, 1],
    [999, 500, 1],
    [1000, 380, 2],
  ])
    assert.deepEqual(catalogOfferView(tiered, quantity), {
      status: 'amount',
      currency: 'USD',
      amountMinor,
      tierIndex,
    });
  assert.deepEqual(
    catalogOfferView(
      {
        ...tiered,
        tiers: [
          { minimumQuantity: 2, maximumQuantity: 10, unitAmountMinor: 570 },
          { minimumQuantity: 20, unitAmountMinor: 500 },
        ],
      },
      15,
    ),
    { status: 'no-tier' },
  );
});
test('all pricing modes remain distinct and invalid quantity or schema never produces an amount', () => {
  assert.deepEqual(catalogOfferView({ mode: 'fixed', currency: 'JPY', amountMinor: 0 }, 1), {
    status: 'amount',
    currency: 'JPY',
    amountMinor: 0,
  });
  assert.deepEqual(
    catalogOfferView(
      { mode: 'range', currency: 'EUR', minimumAmountMinor: 120, maximumAmountMinor: 300 },
      5,
    ),
    { status: 'range', currency: 'EUR', minimumAmountMinor: 120, maximumAmountMinor: 300 },
  );
  assert.deepEqual(catalogOfferView({ mode: 'negotiable' }, 2), { status: 'negotiable' });
  assert.deepEqual(catalogOfferView({ mode: 'unavailable' }, 2), { status: 'unavailable' });
  for (const q of [undefined, null, 0, -1, 1.5, Number.POSITIVE_INFINITY, '2'])
    assert.deepEqual(catalogOfferView(tiered, q), { status: 'quantity-required' });
  for (const pricing of [
    null,
    {},
    {
      ...tiered,
      tiers: [
        { minimumQuantity: 2, maximumQuantity: 10, unitAmountMinor: 1 },
        { minimumQuantity: 5, unitAmountMinor: 2 },
      ],
    },
  ])
    assert.deepEqual(catalogOfferView(pricing, 2), { status: 'unavailable' });
});
