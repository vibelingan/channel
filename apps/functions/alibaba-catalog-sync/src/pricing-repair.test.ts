import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth';
import { setAdapter } from '@vibelingan-channel/db';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { publicDoc } from '../../public-api/src/handler.ts';
import { handleAlibabaSyncRequest } from './handler.ts';
import { repairMissingSourcePricing } from './pricing-repair.ts';

test('pricing repair uses completed mirror evidence, skips existing prices/quarantine, and preserves all curated data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-price-repair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new JsonFileAdapter(join(dir, 'db.json'));
  setAdapter(db);
  const config = { jwtSecret: 'local-repair-test-secret' };
  const anonymous = await handleAlibabaSyncRequest(
    { action: 'repairSourcePricing', data: {} },
    config,
  );
  assert.equal(anonymous.ok, false);
  if (!anonymous.ok) assert.equal(anonymous.error.code, 'UNAUTHORIZED');
  await db.create('users', { _id: 'operator', role: 'admin', status: 'active' });
  const token = await signSession(config.jwtSecret, {
    sub: 'operator',
    role: 'admin',
    name: 'Operator',
    email: 'operator@local.invalid',
  });
  await db.create('alibabaSyncRuns', { _id: 'clean', status: 'completed' });
  await db.create('alibabaSyncRuns', { _id: 'quarantine', status: 'quarantined' });
  for (const id of ['a', 'b', 'c']) {
    await db.create('products', {
      _id: id,
      name: id,
      published: id === 'a',
      productFamily: 'toys',
      imageIds: ['curated'],
      unitPrice: 99,
      alibabaPrimarySourceKey: `source-${id}`,
      ...(id === 'b' ? { alibabaCatalogPricing: { mode: 'unavailable' } } : {}),
    });
    await db.create('alibabaSourceProducts', {
      _id: `source-${id}`,
      active: true,
      lastSeenRunId: id === 'c' ? 'quarantine' : 'clean',
      sourceProductId: id,
    });
    await db.create('alibabaProductLinks', { _id: `source-${id}`, productId: id });
    await db.create('alibabaSupplierOffers', {
      _id: `offer-${id}`,
      sourceKey: `source-${id}`,
      sourceSkuId: id,
      active: true,
      pricing: {
        schemaVersion: 'alibaba-catalog-pricing-v1',
        source: 'alibaba',
        mode: 'tiered',
        currency: 'USD',
        sourceOfferKey: `offer-${id}`,
        sourceProductId: id,
        sourceSkuId: id,
        sourceMoq: 2,
        tiers: [
          { minQuantity: 2, maxQuantity: 499, unitAmountMinor: 570 },
          { minQuantity: 500, maxQuantity: 999, unitAmountMinor: 500 },
          { minQuantity: 1000, unitAmountMinor: 380 },
        ],
        syncedAt: '2026-09-08T00:00:00.000Z',
      },
    });
  }
  const result = await repairMissingSourcePricing({});
  assert.equal(result.repaired, 1);
  assert.equal(result.deferred.length, 1);
  const row = await new JsonFileAdapter(join(dir, 'db.json')).get('products', 'a');
  assert.deepEqual(
    [row?.published, row?.productFamily, row?.unitPrice, row?.imageIds],
    [true, 'toys', 99, ['curated']],
  );
  assert.ok(row);
  const projected = publicDoc('products', row, { apiBaseUrl: 'https://channel.local/api' });
  const pricing = projected.alibabaCatalogPricing as { tiers: { unitAmountMinor: number }[] };
  assert.deepEqual(
    pricing.tiers.map((tier) => tier.unitAmountMinor),
    [570, 500, 380],
  );
  for (const key of ['sourceOfferKey', 'sourceProductId', 'sourceSkuId'])
    assert.equal(Object.hasOwn(pricing, key), false);
  assert.deepEqual((await db.get('products', 'b'))?.alibabaCatalogPricing, { mode: 'unavailable' });
  assert.equal((await db.get('products', 'c'))?.alibabaCatalogPricing, undefined);
  assert.equal((await repairMissingSourcePricing({})).repaired, 0, 'retries are idempotent');
  const bad = await handleAlibabaSyncRequest(
    { action: 'repairSourcePricing', token, data: { published: true } },
    config,
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'VALIDATION_ERROR');
  await db.update('users', 'operator', { role: 'member' });
  const demoted = await handleAlibabaSyncRequest(
    { action: 'repairSourcePricing', token, data: {} },
    config,
  );
  assert.equal(demoted.ok, false);
  if (!demoted.ok) assert.equal(demoted.error.code, 'FORBIDDEN');
});
