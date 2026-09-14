import { strict as assert } from 'node:assert';
import test from 'node:test';
import { planCatalogProductSave } from './adapter.ts';

test('an unrelated update clears stale non-Headphones subcategory in the atomic save plan', () => {
  const now = '2026-08-21T00:00:00.000Z';
  const plan = planCatalogProductSave(
    {
      _id: 'toy-1',
      name: 'Legacy toy',
      productFamily: 'toys',
      category: 'wired',
      published: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      mode: 'update',
      productId: 'toy-1',
      data: {
        manualCatalogPricing: {
          schemaVersion: 'manual-catalog-pricing-v1',
          currency: 'USD',
          tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
        },
      },
    },
    '2026-08-21T01:00:00.000Z',
  );
  assert.equal(plan.result, 'ready');
  if (plan.result !== 'ready') return;
  assert.equal(plan.doc.category, '');
  assert.deepEqual(plan.doc.manualCatalogPricing, {
    schemaVersion: 'manual-catalog-pricing-v1',
    currency: 'USD',
    tiers: [{ minQuantity: 1, unitAmountMinor: 100 }],
  });
});
