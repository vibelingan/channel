/** One-time "changed since approval" audit (MIU-38, runbook R6). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCatalogDetailCandidate } from '@vibelingan-channel/catalog-import/detail-candidate';
import { runStagedApproval } from '@vibelingan-channel/db/catalog-detail-staging';
import { approvedVariantDocumentId } from '@vibelingan-channel/db/catalog-detail-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { publicSourceDigest } from '@vibelingan-channel/shared/catalog-source-digest';
import {
  type ChangeAuditReader,
  applyChangeAudit,
  planChangeAudit,
} from './catalog-change-audit.ts';
import { catalogCategoryLabel, sourceVariantIds } from './catalog-detail-source.ts';

const SOURCE = 'source-a';
type Pricing = Record<string, unknown>;
const UNPRICED: Pricing = { mode: 'unavailable', minimumOrderQuantity: 10 };
const TIERS: Pricing = {
  mode: 'tiered',
  currency: 'USD',
  minimumOrderQuantity: 10,
  tiers: [
    { minimumQuantity: 10, maximumQuantity: 99, unitAmountMinor: 130 },
    { minimumQuantity: 100, maximumQuantity: 499, unitAmountMinor: 122 },
    { minimumQuantity: 500, unitAmountMinor: 120 },
  ],
};

const observation = (pricing: Pricing, description = 'Comfortable headset') => ({
  schemaVersion: 'catalog-source-observation-v1',
  source: {
    provider: 'alibaba',
    sourceProductKey: SOURCE,
    externalProductId: '987',
    observedAt: '2026-10-01T00:00:00.000Z',
    captureMode: 'full',
    completeness: 'full-product',
  },
  identity: {
    title: 'Supplier title',
    matchHints: {},
    attributes: [{ sourceName: 'Material', value: 'ABS' }],
  },
  content: {
    description: {
      text: description,
      placeholder: false,
      sanitized: true,
      provenance: 'provider-description',
    },
    media: [],
  },
  lifecycle: { sourceListingStatus: 'published' },
  variants: [
    {
      sourceVariantKey: 'black',
      options: [{ sourceName: 'Color', value: 'Black' }],
      inventory: [],
      media: [],
    },
  ],
  offers: [{ sourceOfferKey: 'o-black', sourceVariantKey: 'black', kind: 'supplier', pricing }],
  evidence: [{ kind: 'raw-payload', evidenceId: 'a'.repeat(64) }],
  warnings: [],
});

/** A product approved from `approvedFrom`, exactly as the approval builder would store it. */
function approvedStore(approvedFrom: ReturnType<typeof observation>, extra: object = {}) {
  const productId = 'p1';
  const revision = 'r1';
  const built = buildCatalogDetailCandidate(
    approvedFrom,
    {
      productId,
      variants: sourceVariantIds(productId, SOURCE, approvedFrom as never),
      images: new Map(),
      ...catalogCategoryLabel('headphones'),
    },
    1,
    50,
  );
  assert.ok(built.ok);
  if (!built.ok) throw new Error('fixture');
  const { variants, revision: _revision, ...header } = built.value;
  const rows: CollectionDoc[] = variants.items.map((variant, position) => ({
    _id: approvedVariantDocumentId(productId, revision, variant.id),
    productId,
    variantId: variant.id,
    catalogDetailRevision: revision,
    catalogDetailPosition: position,
    catalogDetailApproved: variant,
  }));
  const product: CollectionDoc = {
    _id: productId,
    name: 'Headset',
    published: true,
    productFamily: 'headphones',
    alibabaPrimarySourceKey: SOURCE,
    catalogDetailPublication: {
      state: 'approved',
      revision,
      header,
      variantCount: rows.length,
      variantStorage: 'immutable-v1',
    },
    catalogDetailApprovalReceipt: { revision, operationId: 'op', variantCount: rows.length },
    ...extra,
  };
  return {
    products: [product],
    rows,
    observation: approvedFrom as unknown,
    writes: [] as string[],
  };
}

type Store = ReturnType<typeof approvedStore>;
const reader = (store: Store): ChangeAuditReader => ({
  listProducts: async (afterId, pageSize) =>
    store.products.filter((row) => !afterId || row._id > afterId).slice(0, pageSize),
  getProduct: async (id) => structuredClone(store.products.find((row) => row._id === id) ?? null),
  listApprovedVariants: async (productId, revision) =>
    store.rows.filter(
      (row) => row.productId === productId && row.catalogDetailRevision === revision,
    ),
  getObservation: async () => structuredClone(store.observation),
});
/** The real persistence command over the same in-memory store. */
const persist =
  (store: Store, actor = 'admin') =>
  (command: unknown) =>
    runStagedApproval(
      {
        get: async (collection, id) =>
          collection === 'users'
            ? { _id: actor, role: actor === 'admin' ? 'admin' : 'contributor' }
            : structuredClone(store.products.find((row) => row._id === id) ?? null),
        set: async (_collection, row) => {
          store.writes.push(row._id);
          store.products = store.products.map((existing) =>
            existing._id === row._id ? structuredClone(row) : existing,
          );
        },
      },
      actor,
      command as Parameters<typeof runStagedApproval>[2],
    );

test('approved unpriced, source now tiered → changed, naming the configuration and the price', async () => {
  const store = approvedStore(observation(UNPRICED));
  store.observation = observation(TIERS);
  const plan = await planChangeAudit(reader(store), { pageSize: 20 });
  assert.equal(plan.rows.length, 1);
  const row = plan.rows[0];
  assert.equal(row?.outcome, 'changed');
  assert.ok(row?.outcome === 'changed');
  assert.ok(
    row.differences.some((text) => text.includes('Black') && text.includes('price')),
    row.differences.join('; '),
  );
});

test('identical source → unchanged; apply records only the baseline digest', async () => {
  const store = approvedStore(observation(TIERS));
  const before = structuredClone(store.products[0]) as CollectionDoc;
  const plan = await planChangeAudit(reader(store), { pageSize: 20 });
  const row = plan.rows[0];
  assert.deepEqual(row, {
    productId: 'p1',
    revision: 'r1',
    outcome: 'unchanged',
    sourceDigest: publicSourceDigest(observation(TIERS) as never),
  });
  const results = await applyChangeAudit(reader(store), persist(store), [
    { productId: 'p1', revision: 'r1', outcome: 'unchanged' },
  ]);
  assert.deepEqual(results, [{ productId: 'p1', result: { ok: true, backfill: 'applied' } }]);
  assert.deepEqual(store.products[0], {
    ...before,
    catalogDetailApprovalReceipt: {
      ...(before.catalogDetailApprovalReceipt as object),
      sourceDigest: publicSourceDigest(observation(TIERS) as never),
    },
  });
});

test('a product-level price change is changed; a description difference is not compared', async () => {
  // The approved description is the admin's own text (the planner takes it from
  // the row), and the audit has no record of the supplier's text at approval.
  const described = approvedStore(observation(TIERS));
  described.observation = observation(TIERS, 'A different description');
  const unchanged = (await planChangeAudit(reader(described), { pageSize: 20 })).rows[0];
  assert.equal(unchanged?.outcome, 'unchanged');

  const store = approvedStore(observation(TIERS));
  const withHeadline = observation(TIERS);
  withHeadline.offers.push({
    sourceOfferKey: 'o-product',
    kind: 'supplier',
    pricing: { mode: 'fixed', currency: 'USD', amountMinor: 390 },
  } as never);
  store.observation = withHeadline;
  const row = (await planChangeAudit(reader(store), { pageSize: 20 })).rows[0];
  assert.ok(row?.outcome === 'changed');
  assert.deepEqual(row.differences, ['product price']);
});

test('a plan that no longer matches at apply time is skipped without a write', async () => {
  const store = approvedStore(observation(TIERS));
  const results = await applyChangeAudit(reader(store), persist(store), [
    { productId: 'p1', revision: 'r0', outcome: 'unchanged' },
    { productId: 'p1', revision: 'r1', outcome: 'changed' },
  ]);
  assert.deepEqual(
    results.map((item) => item.result),
    [
      { ok: true, backfill: 'skipped', reason: 'plan-changed' },
      { ok: true, backfill: 'skipped', reason: 'plan-changed' },
    ],
  );
  assert.deepEqual(store.writes, []);
});

test('only an admin can apply', async () => {
  const store = approvedStore(observation(UNPRICED));
  store.observation = observation(TIERS);
  const results = await applyChangeAudit(reader(store), persist(store, 'contributor'), [
    { productId: 'p1', revision: 'r1', outcome: 'changed' },
  ]);
  assert.deepEqual(results[0]?.result, { ok: false, code: 'FORBIDDEN' });
  assert.deepEqual(store.writes, []);
});

test('products outside the audit are reported with a reason and never compared', async () => {
  const cases: Array<[object, unknown, string]> = [
    [{ archived: true }, undefined, 'archived'],
    [{ alibabaPrimarySourceKey: undefined }, undefined, 'unlinked'],
    [
      { catalogDetailApprovalReceipt: { revision: 'r1', sourceDigest: 'd'.repeat(64) } },
      undefined,
      'already-present',
    ],
    [{ catalogDetailPublication: undefined }, undefined, 'not-approved'],
    [{}, null, 'no-observation'],
  ];
  for (const [extra, stored, reason] of cases) {
    const store = approvedStore(observation(TIERS), extra);
    if (stored !== undefined) store.observation = stored;
    const row = (await planChangeAudit(reader(store), { pageSize: 20 })).rows[0];
    assert.deepEqual(row, { productId: 'p1', outcome: 'skipped', reason }, reason);
  }
});
