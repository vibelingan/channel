import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { runStagedApproval } from './catalog-detail-staging.ts';
import { approvedVariantDocumentId } from './catalog-detail-storage.ts';
import {
  type PriceSummaryBackfillReader,
  planPriceSummaryBackfill,
} from './catalog-price-summary-backfill.ts';

const header = {
  schemaVersion: 'catalog-product-detail-v1',
  _id: 'p1',
  name: 'Headset',
  images: [],
  facts: [],
  offers: [],
};
const fixed = (amountMinor: number) => [
  {
    kind: 'supplier',
    basis: 'source-quote',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor },
  },
];
const variant = (id: string, offers: unknown[], position = 0) => ({
  _id: approvedVariantDocumentId('p1', 'r1', id),
  variantId: id,
  catalogDetailPosition: position,
  catalogDetailApproved: {
    id,
    options: [],
    images: [],
    inventory: { state: 'unknown' },
    offers,
  },
});
const product = (overrides: Record<string, unknown> = {}): CollectionDoc => ({
  _id: 'p1',
  name: 'Headset',
  published: true,
  catalogDetailPublication: {
    state: 'approved',
    revision: 'r1',
    header,
    variantCount: 2,
    variantStorage: 'immutable-v1',
  },
  ...overrides,
});
const reader = (
  products: CollectionDoc[],
  variants: CollectionDoc[],
  seen: string[] = [],
): PriceSummaryBackfillReader => ({
  listProducts: async () => products,
  listApprovedVariants: async (productId, revision, storage) => {
    seen.push(`${productId}:${revision}:${storage}`);
    return variants;
  },
});

test('plan proposes the cheapest approved SKU for an approved version without a summary', async () => {
  const seen: string[] = [];
  const plan = await planPriceSummaryBackfill(
    reader([product()], [variant('a', fixed(500), 0), variant('b', fixed(120), 1)], seen),
    { pageSize: 20 },
  );
  assert.deepEqual(plan.rows, [
    {
      productId: 'p1',
      revision: 'r1',
      outcome: 'ready',
      priceSummary: {
        source: 'sku',
        variantId: 'b',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor: 120 },
      },
    },
  ]);
  assert.deepEqual(seen, ['p1:r1:immutable-v1']);
  assert.equal(plan.nextAfterId, 'p1');
});

test('legacy storage, existing summaries, unapproved, unpriced and inconsistent rows are classified, not written', async () => {
  const legacy = product({
    catalogDetailPublication: { state: 'approved', revision: 'r1', header, variantCount: 1 },
  });
  const seen: string[] = [];
  const legacyRow = { ...variant('a', fixed(300)), _id: 'a' };
  const legacyPlan = await planPriceSummaryBackfill(reader([legacy], [legacyRow], seen), {
    pageSize: 20,
  });
  assert.equal(legacyPlan.rows[0]?.outcome, 'ready');
  assert.deepEqual(seen, ['p1:r1:legacy']);
  const present = product({
    catalogDetailPublication: {
      ...(product().catalogDetailPublication as object),
      priceSummary: {
        source: 'product',
        pricing: { mode: 'fixed', currency: 'USD', amountMinor: 1 },
      },
    },
  });
  const unapproved = product({ _id: 'p2', catalogDetailPublication: undefined });
  const outcomes = async (rows: CollectionDoc[], variants: CollectionDoc[]) =>
    (await planPriceSummaryBackfill(reader(rows, variants), { pageSize: 20 })).rows.map(
      (row) => row.outcome,
    );
  assert.deepEqual(await outcomes([present, unapproved], []), ['already-present', 'not-approved']);
  assert.deepEqual(
    await outcomes([product()], [variant('a', [])]),
    ['invalid-variant-rows'],
    'variant count mismatch',
  );
  assert.deepEqual(await outcomes([product()], [variant('a', [], 0), variant('b', [], 1)]), [
    'no-price',
  ]);
  assert.deepEqual(
    await outcomes(
      [product()],
      [variant('a', fixed(1), 0), { ...variant('b', fixed(1), 1), _id: 'forged' }],
    ),
    ['invalid-variant-rows'],
    'row id must match the approved storage key',
  );
  assert.deepEqual(
    await outcomes([product()], [variant('a', fixed(1), 0), variant('b', fixed(1), 5)]),
    ['invalid-variant-rows'],
    'positions must be contiguous',
  );
  const mismatched = product({
    catalogDetailPublication: {
      ...(product().catalogDetailPublication as object),
      header: { ...header, _id: 'someone-else' },
    },
  });
  assert.deepEqual(await outcomes([mismatched], []), ['not-approved']);
});

function store(initial: Record<string, Record<string, CollectionDoc>>) {
  let data = structuredClone(initial);
  const run = <T>(
    action: Parameters<typeof runStagedApproval>[0] extends infer Tx
      ? (tx: Tx) => Promise<T>
      : never,
  ) => {
    const copy = structuredClone(data);
    return action({
      get: async (collection: string, id: string) =>
        structuredClone(copy[collection]?.[id] ?? null),
      set: async (collection: string, row: CollectionDoc) => {
        copy[collection] ??= {};
        copy[collection][row._id] = structuredClone(row);
      },
    } as never).then((result) => {
      data = copy;
      return result;
    });
  };
  return { run, data: () => data };
}

const summary = {
  source: 'sku',
  variantId: 'b',
  pricing: { mode: 'fixed', currency: 'USD', amountMinor: 120 },
} as const;

test('apply writes only the summary, idempotently, and skips a changed revision', async () => {
  const before = product({ updatedAt: '2026-01-01T00:00:00.000Z' });
  const s = store({
    products: { p1: before },
    users: {
      admin: { _id: 'admin', role: 'admin' },
      editor: { _id: 'editor', role: 'contributor' },
    },
  });
  const command = {
    action: 'price-summary-backfill',
    productId: 'p1',
    revision: 'r1',
    priceSummary: summary,
  } as const;
  assert.deepEqual(await s.run((tx) => runStagedApproval(tx, 'admin', command)), {
    ok: true,
    backfill: 'applied',
  });
  const after = structuredClone(s.data().products?.p1) as CollectionDoc;
  const { priceSummary: added, ...publicationWithout } = after.catalogDetailPublication as Record<
    string,
    unknown
  >;
  assert.deepEqual(added, summary);
  assert.deepEqual(
    { ...after, catalogDetailPublication: publicationWithout },
    before,
    'nothing else on the row changes',
  );
  assert.deepEqual(await s.run((tx) => runStagedApproval(tx, 'admin', command)), {
    ok: true,
    backfill: 'skipped',
    reason: 'already-present',
  });
  assert.deepEqual(
    await s.run((tx) => runStagedApproval(tx, 'admin', { ...command, revision: 'r0' })),
    { ok: true, backfill: 'skipped', reason: 'revision-changed' },
  );
  assert.deepEqual(await s.run((tx) => runStagedApproval(tx, 'editor', command)), {
    ok: false,
    code: 'FORBIDDEN',
  });
});
