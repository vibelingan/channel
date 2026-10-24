import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CatalogPreparationPlanLimitError,
  planCatalogPreparationTransaction,
} from './catalog-preparation-transaction-plan.ts';

test('a preparation plan that exceeds its operation budget cannot later flush a partial prefix', async () => {
  let nativeWrites = 0;
  const plan = planCatalogPreparationTransaction(
    {
      get: async (_collection, id) => ({ _id: id }),
      set: async () => {
        nativeWrites++;
      },
    },
    { _id: 'job' },
  );
  for (let i = 0; i < 60; i++) await plan.tx.get('images', String(i));
  await assert.rejects(async () => {
    for (let i = 0; i < 40; i++) await plan.tx.set('catalogImageObservations', { _id: String(i) });
  }, CatalogPreparationPlanLimitError);
  await assert.rejects(
    plan.flush(() => true),
    CatalogPreparationPlanLimitError,
  );
  assert.equal(nativeWrites, 0);
});

test('an oversized preparation read aborts the entire plan and preserves the original native failure', async () => {
  let nativeWrites = 0;
  const failure = Error('native read failed');
  for (const oversized of [true, false]) {
    const plan = planCatalogPreparationTransaction(
      {
        get: async (_collection, id) => {
          if (!oversized) throw failure;
          return { _id: id, unused: 'x'.repeat(512 * 1024) };
        },
        set: async () => {
          nativeWrites++;
        },
      },
      { _id: 'job' },
    );
    await plan.tx.set('catalogPreparationJobs', { _id: 'job', marker: 'pending' });
    const expected = oversized
      ? (error: unknown) => error instanceof CatalogPreparationPlanLimitError
      : (error: unknown) => error === failure;
    await assert.rejects(plan.tx.get('alibabaSourceProducts', 'large'), expected);
    await assert.rejects(
      plan.flush(() => true),
      expected,
    );
  }
  assert.equal(nativeWrites, 0);
});
