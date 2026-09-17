import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth';
import {
  ALIBABA_SYNC_LEASE_COLLECTION,
  type AlibabaProductMutationInput,
  acquireAlibabaSyncLease,
  setAdapter,
} from '@vibelingan-channel/db';
import {
  createAlibabaPricingAdapter,
  resolveCatalogPricing,
} from '@vibelingan-channel/shared/catalog';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { publicDoc } from '../../public-api/src/handler.ts';
import { materializeAlibabaDraftPage } from './draft-materialization.ts';
import { handleAlibabaSyncRequest } from './handler.ts';
import { planProductPricingRepair, repairMissingSourcePricing } from './pricing-repair.ts';

async function linked(db: JsonFileAdapter, extra: Record<string, unknown> = {}) {
  const product = await db.create('products', {
    _id: 'g2-product',
    name: 'Same name',
    published: true,
    archived: false,
    alibabaPrimarySourceKey: 'source-g2',
    ...extra,
  });
  await db.create('alibabaProductLinks', {
    _id: 'source-g2',
    sourceKey: 'source-g2',
    sourceProductId: 'g2',
    connectionId: 'primary',
    productId: product._id,
    linkedAt: '2026-09-03T00:00:00.000Z',
  });
  return product;
}

async function applyPage() {
  const dry = await repairMissingSourcePricing({ mode: 'dry-run' });
  return repairMissingSourcePricing({ mode: 'apply', expectedPageHash: dry.pageHash });
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-pricing-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new JsonFileAdapter(join(dir, 'db.json'));
  setAdapter(db);
  await db.create('alibabaSyncRuns', { _id: 'completed-run', status: 'completed' });
  await db.create('alibabaSourceProducts', {
    _id: 'source-g2',
    sourceKey: 'source-g2',
    connectionId: 'primary',
    sourceProductId: 'g2',
    active: true,
    lastSeenRunId: 'completed-run',
    lastChangedRunId: 'completed-run',
    sourceTitle: 'G2',
    sourceCategoryId: 'source-category',
  });
  await db.create('alibabaSupplierOffers', {
    _id: 'offer-g2',
    sourceKey: 'source-g2',
    sourceProductId: 'g2',
    sourceSkuId: '@product',
    active: true,
    lastSeenRunId: 'completed-run',
    pricing: {
      schemaVersion: 'alibaba-catalog-pricing-v1',
      source: 'alibaba',
      mode: 'fixed',
      currency: 'USD',
      amountMinor: 290,
      sourceProductId: 'g2',
      sourceOfferKey: 'offer-g2',
      syncedAt: '2026-09-03T00:00:00.000Z',
    },
  });
  return db;
}

test('repair preserves every field outside price and internal revision/timestamp', async (t) => {
  const db = await fixture(t);
  const product = await db.create('products', {
    _id: 'g2-product',
    name: 'G2',
    published: true,
    archived: false,
    alibabaPrimarySourceKey: 'source-g2',
    alibabaSourceCategoryId: 'reviewed-category',
    alibabaSourceImageUrls: ['https://example.invalid/reviewed.jpg'],
    alibabaDescriptionImageUrls: ['https://example.invalid/description.jpg'],
    alibabaSourceReview: { reviewed: true },
    catalogDetailPublication: { revision: 'approved', header: { offers: [{ amountMinor: 290 }] } },
    alibabaSourceLastSyncedAt: '2026-09-03T00:00:00.000Z',
  });
  await db.create('alibabaProductLinks', {
    _id: 'source-g2',
    sourceKey: 'source-g2',
    sourceProductId: 'g2',
    connectionId: 'primary',
    productId: product._id,
    linkedAt: '2026-09-03T00:00:00.000Z',
  });
  const dry = await repairMissingSourcePricing({});
  assert.equal(dry.eligible, 1, JSON.stringify(dry.outcomes));
  const applied = await repairMissingSourcePricing({
    mode: 'apply',
    expectedPageHash: dry.pageHash,
  });
  assert.equal(applied.repaired, 1, JSON.stringify(applied));
  const after = await db.get('products', product._id);
  assert.ok(after);
  assert.equal((after.alibabaCatalogPricing as { amountMinor: number })?.amountMinor, 290);
  const protectedFields = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          ![
            'alibabaCatalogPricing',
            'alibabaPrimaryOfferKey',
            'alibabaLinkRevision',
            'updatedAt',
          ].includes(key),
      ),
    );
  assert.deepEqual(protectedFields(after), protectedFields(product));
});

test('catch-up draft materialization includes its own completed source quote', async (t) => {
  const db = await fixture(t);
  const result = await materializeAlibabaDraftPage({});
  assert.equal(result.created, 1);
  const link = await db.get('alibabaProductLinks', 'source-g2');
  const product = await db.get('products', String(link?.productId));
  assert.equal(product?.published, false);
  assert.equal((product?.alibabaCatalogPricing as { amountMinor: number })?.amountMinor, 290);
});

test('absent, null, malformed and unavailable summaries are audited and repaired without changing source quotes', async (t) => {
  for (const summary of [undefined, null, { mode: 'bogus' }, { mode: 'unavailable' }]) {
    await t.test(JSON.stringify(summary) ?? 'absent', async (t) => {
      const db = await fixture(t);
      await linked(db, summary === undefined ? {} : { alibabaCatalogPricing: summary });
      const before = await db.get('alibabaSupplierOffers', 'offer-g2');
      assert.equal((await applyPage()).repaired, 1);
      assert.deepEqual(await db.get('alibabaSupplierOffers', 'offer-g2'), before);
      assert.equal((await applyPage()).repaired, 0);
    });
  }
});

test('manual controls, archived, unlinked, invalid pins and incomplete runs have explicit no-write outcomes', async (t) => {
  const cases = [
    { product: { unitPrice: 0 }, status: 'manual' },
    { product: { catalogPricingMode: 'manual' }, status: 'invalid-manual' },
    { product: { manualCatalogPricing: { invalid: true } }, status: 'invalid-manual' },
    { product: { archived: true }, status: 'archived' },
    { product: { alibabaPrimarySourceKey: null }, status: 'unlinked' },
    { product: { alibabaPinnedOfferKey: 'missing' }, status: 'invalid-pin' },
    { product: {}, run: 'quarantined', status: 'incomplete-run' },
    { product: {}, run: 'running', status: 'incomplete-run' },
  ];
  for (const c of cases)
    await t.test(c.status, async (t) => {
      const db = await fixture(t);
      const product = await linked(db, c.product);
      if (c.run) await db.update('alibabaSyncRuns', 'completed-run', { status: c.run });
      const result = await applyPage();
      assert.equal(result.outcomes[0]?.status, c.status);
      assert.equal(result.repaired, 0);
      assert.deepEqual(await db.get('products', product._id), product);
    });
});

test('fixed zero, range and tiers survive public projection; quote-only remains a quote', async (t) => {
  const modes = [
    { mode: 'fixed', currency: 'USD', amountMinor: 0 },
    { mode: 'range', currency: 'CNY', minAmountMinor: 1200, maxAmountMinor: 1500 },
    {
      mode: 'tiered',
      currency: 'USD',
      sourceMoq: 10,
      tiers: [
        { minQuantity: 10, maxQuantity: 99, unitAmountMinor: 570 },
        { minQuantity: 100, unitAmountMinor: 380 },
      ],
    },
    { mode: 'negotiable' },
    { mode: 'unavailable' },
  ];
  for (const pricing of modes)
    await t.test(pricing.mode, async (t) => {
      const db = await fixture(t);
      await linked(db);
      const quote = {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        sourceOfferKey: 'offer-g2',
        sourceProductId: 'g2',
        syncedAt: '2026-09-03T00:00:00.000Z',
        ...pricing,
      };
      await db.update('alibabaSupplierOffers', 'offer-g2', { pricing: quote });
      const result = await applyPage();
      const numeric = ['fixed', 'range', 'tiered'].includes(pricing.mode);
      assert.equal(result.repaired, numeric ? 1 : 0);
      assert.equal(result.outcomes[0]?.status, numeric ? 'repaired' : 'quote-only');
      if (numeric) {
        const saved = await db.get('products', 'g2-product');
        assert.ok(saved);
        assert.deepEqual(saved.alibabaCatalogPricing, quote);
        const projected = publicDoc('products', saved, {});
        const publicPrice = projected.alibabaCatalogPricing as Record<string, unknown>;
        for (const field of ['sourceOfferKey', 'sourceProductId', 'sourceSkuId'])
          assert.equal(Object.hasOwn(publicPrice, field), false);
        const decision = resolveCatalogPricing(
          {
            ...projected,
            alibabaPrimarySourceKey: projected.alibabaPrimarySourceKey,
          },
          createAlibabaPricingAdapter(),
        );
        assert.equal(decision.source, 'alibaba');
        if (decision.source === 'alibaba') assert.equal(decision.pricing.state, 'available');
      }
    });
});

test('dry-run is read-only; apply rejects changed manual, source, run, offer, and link plans', async (t) => {
  for (const change of ['manual', 'source', 'run', 'offer', 'link', 'link-aba'] as const)
    await t.test(change, async (t) => {
      const db = await fixture(t);
      const original = await linked(db);
      const dry = await repairMissingSourcePricing({});
      assert.equal(dry.eligible, 1);
      assert.deepEqual(await db.get('products', original._id), original);
      assert.equal(await db.get(ALIBABA_SYNC_LEASE_COLLECTION, 'primary'), null);
      if (change === 'manual') await db.update('products', original._id, { unitPrice: 45 });
      if (change === 'source')
        await db.update('alibabaSourceProducts', 'source-g2', { payloadId: 'changed' });
      if (change === 'run')
        await db.update('alibabaSyncRuns', 'completed-run', { status: 'quarantined' });
      if (change === 'offer')
        await db.update('alibabaSupplierOffers', 'offer-g2', { active: false });
      if (change === 'link')
        await db.update('alibabaProductLinks', 'source-g2', { productId: 'other-product' });
      if (change === 'link-aba')
        await db.update('alibabaProductLinks', 'source-g2', {
          linkedAt: '2026-09-04T00:00:00.000Z',
        });
      const result = await repairMissingSourcePricing({
        mode: 'apply',
        expectedPageHash: dry.pageHash,
      });
      assert.equal(result.stopped, 'page-changed');
      assert.equal(result.repaired, 0);
      assert.equal((await db.get('products', original._id))?.alibabaCatalogPricing, undefined);
    });
});

test('transaction rejects changes after apply planning, including manual edits, relink ABA and expired leases', async (t) => {
  for (const change of ['manual', 'link', 'lease', 'offer', 'run'] as const)
    await t.test(change, async (t) => {
      const db = await fixture(t);
      const original = await linked(db);
      const mutation = db.mutateAlibabaProduct.bind(db);
      t.mock.method(db, 'mutateAlibabaProduct', async (input: AlibabaProductMutationInput) => {
        if (change === 'manual') await db.update('products', original._id, { unitPrice: 12 });
        if (change === 'link')
          await db.update('alibabaProductLinks', 'source-g2', {
            linkedAt: '2026-09-04T00:00:00.000Z',
          });
        if (change === 'lease')
          await db.update(ALIBABA_SYNC_LEASE_COLLECTION, 'primary', {
            expiresAt: '2020-01-01T00:00:00.000Z',
          });
        if (change === 'offer')
          await db.update('alibabaSupplierOffers', 'offer-g2', { active: false });
        if (change === 'run')
          await db.update('alibabaSyncRuns', 'completed-run', { status: 'quarantined' });
        return mutation(input);
      });
      const result = await applyPage();
      assert.equal(result.repaired, 0);
      assert.ok(result.stopped);
      assert.equal((await db.get('products', original._id))?.alibabaCatalogPricing, undefined);
    });
});

test('price-only transaction refuses injected non-price fields even with a valid plan and lease', async (t) => {
  const db = await fixture(t);
  const product = await linked(db);
  const plan = await planProductPricingRepair(product);
  assert.ok(plan.write);
  const at = new Date().toISOString();
  const lease = await acquireAlibabaSyncLease('primary', 'test-holder', at, 60000);
  assert.equal(lease.result, 'granted');
  if (lease.result !== 'granted') return;
  const result = await db.mutateAlibabaProduct({
    ...plan.write,
    now: at,
    guard: { connectionId: 'primary', holder: 'test-holder', fence: lease.fence, now: at },
    patch: { ...plan.write.patch, alibabaDescriptionImageUrls: [] },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid-patch' });
  assert.deepEqual(await db.get('products', product._id), product);
});

test('whole-catalog traversal accounts for more than 100 records, drafts, empty final page and repeat execution', async (t) => {
  const db = await fixture(t);
  await linked(db);
  for (let i = 0; i < 119; i++)
    await db.create('products', {
      _id: `other-${String(i).padStart(3, '0')}`,
      name: 'Same name',
      published: i % 2 === 0,
    });
  let afterId: string | undefined;
  const seen: string[] = [];
  let repaired = 0;
  let pages = 0;
  do {
    const dry = await repairMissingSourcePricing(afterId ? { afterId } : {});
    const page = await repairMissingSourcePricing({
      ...(afterId ? { afterId } : {}),
      mode: 'apply',
      expectedPageHash: dry.pageHash,
    });
    assert.equal(page.stopped, null);
    seen.push(...page.outcomes.map((row) => row.productId));
    repaired += page.repaired;
    afterId = page.nextId ?? undefined;
    pages++;
  } while (afterId);
  assert.equal(pages, 7);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(repaired, 1);
  assert.equal((await applyPage()).repaired, 0);
});

test('initial admin link materializes the own completed quote through the real action', async (t) => {
  const db = await fixture(t);
  await db.create('products', { _id: 'g2-product', name: 'Same name', published: false });
  await db.create('users', { _id: 'operator', role: 'admin', status: 'active' });
  const config = { jwtSecret: 'test-secret', corsAllowedOrigins: [], siteUrl: 'http://localhost' };
  const token = await signSession(config.jwtSecret, {
    sub: 'operator',
    role: 'admin',
    email: 'admin@example.invalid',
    name: 'operator',
  });
  const response = await handleAlibabaSyncRequest(
    { action: 'linkProduct', token, data: { productId: 'g2-product', sourceKey: 'source-g2' } },
    config,
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  const product = await db.get('products', 'g2-product');
  assert.equal(product?.published, false);
  assert.equal((product?.alibabaCatalogPricing as { amountMinor: number })?.amountMinor, 290);
});

test('automatic selection keeps USD preference, respects a valid CNY pin, and never compares amounts across currencies', async (t) => {
  for (const pinned of [false, true])
    await t.test(String(pinned), async (t) => {
      const db = await fixture(t);
      await linked(db, pinned ? { alibabaPinnedOfferKey: 'offer-cny' } : {});
      const usd = await db.get('alibabaSupplierOffers', 'offer-g2');
      assert.ok(usd);
      await db.create('alibabaSupplierOffers', {
        ...usd,
        _id: 'offer-cny',
        sourceSkuId: 'cny-sku',
        pricing: {
          ...(usd.pricing as object),
          sourceOfferKey: 'offer-cny',
          sourceSkuId: 'cny-sku',
          currency: 'CNY',
          amountMinor: 1,
        },
      });
      const applied = await applyPage();
      assert.equal(applied.repaired, 1);
      assert.equal(
        (await db.get('products', 'g2-product'))?.alibabaPrimaryOfferKey,
        pinned ? 'offer-cny' : 'offer-g2',
      );
    });
});
