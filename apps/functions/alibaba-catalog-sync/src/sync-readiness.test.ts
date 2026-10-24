import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manageCatalogPreparationJob, setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { fixture as sourceFixture } from '../../admin/src/testing/catalog-source-plan-fixture.ts';
import { runCatalogPreparationCall } from './catalog-preparation.ts';
import { prepareSyncedCatalogSource } from './sync-readiness.ts';

function fixture(t: { after(fn: () => void): void }, options?: { family: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-sync-readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = sourceFixture(0);
  if (options) {
    if (options.family === undefined) Reflect.deleteProperty(h.product, 'productFamily');
    else h.product.productFamily = options.family;
  }
  const source = h.adapter.rows.alibabaSourceProducts?.[0];
  assert.ok(source);
  source.lastSeenRunId = 'run';
  source.active = true;
  h.adapter.rows.alibabaSyncRuns = [{ _id: 'run', status: 'completed' }];
  const file = join(dir, 'db.json');
  writeFileSync(file, JSON.stringify(h.adapter.rows));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'sync-readiness-test',
    environmentId: 'sync-readiness-test',
  });
  return {
    adapter,
    authority,
    productId: h.product._id,
    input: { actorId: 'admin', runId: 'run', sourceKey: source._id, retries: 0 },
  };
}
for (const family of ['misc', '', null, undefined])
  test(`sync checks a saved draft to ready without publishing or assigning a category: family=${String(family)}`, async (t) => {
    const h = fixture(t, { family });
    const before = await h.adapter.get('products', h.productId);
    const result = await prepareSyncedCatalogSource(h.authority, h.input);
    assert.equal(
      result.outcome,
      'complete',
      JSON.stringify({
        result,
        report: (await h.adapter.get('products', h.productId))?.catalogPreparationReport,
      }),
    );
    assert.equal(result.checked, true);
    const product = await h.adapter.get('products', h.productId);
    assert.equal(readCurrentCatalogPreparation(product ?? {})?.state, 'ready');
    assert.equal(product?.published, false);
    for (const key of [
      'name',
      'description',
      'productFamily',
      'imageIds',
      'alibabaPrimarySourceKey',
    ])
      assert.deepEqual(product?.[key], before?.[key]);
    const repeated = await prepareSyncedCatalogSource(h.authority, h.input);
    assert.equal(repeated.outcome, 'complete');
    assert.deepEqual(await h.adapter.get('products', h.productId), product);
  });
for (const field of ['published', 'archived'] as const)
  test(`sync leaves existing ${field} products byte-for-byte unchanged`, async (t) => {
    const h = fixture(t);
    await h.adapter.update('products', h.productId, { [field]: true });
    const before = await h.adapter.get('products', h.productId);
    const result = await prepareSyncedCatalogSource(h.authority, h.input);
    assert.equal(result.outcome, 'complete');
    assert.equal(result.checked, false);
    assert.deepEqual(await h.adapter.get('products', h.productId), before);
    assert.equal(
      (
        await h.adapter.list({
          collection: 'catalogPreparationJobs',
          page: 1,
          pageSize: 100,
          search: '',
        })
      ).items.length,
      0,
    );
  });
for (const fault of ['revoked', 'wrong-run', 'wrong-primary', 'unfinished-run'] as const)
  test(`sync cannot prepare data outside its original authorized scope: ${fault}`, async (t) => {
    const h = fixture(t);
    if (fault === 'revoked') await h.adapter.update('users', 'admin', { role: 'member' });
    if (fault === 'wrong-run')
      await h.adapter.update('alibabaSourceProducts', h.input.sourceKey, {
        lastSeenRunId: 'later-run',
      });
    if (fault === 'wrong-primary')
      await h.adapter.update('products', h.productId, {
        alibabaPrimarySourceKey: 'another-source',
      });
    if (fault === 'unfinished-run')
      await h.adapter.update('alibabaSyncRuns', 'run', { status: 'continuing' });
    const before = await h.adapter.get('products', h.productId);
    const result = await prepareSyncedCatalogSource(h.authority, h.input);
    assert.notEqual(result.checked, true);
    assert.deepEqual(await h.adapter.get('products', h.productId), before);
    assert.equal(
      (
        await h.adapter.list({
          collection: 'catalogPreparationJobs',
          page: 1,
          pageSize: 100,
          search: '',
        })
      ).items.length,
      0,
    );
  });

for (const family of ['unknown-family', 42, {}])
  test(`unknown nonempty classification remains a data issue: ${JSON.stringify(family)}`, async (t) => {
    const h = fixture(t, { family });
    const result = await prepareSyncedCatalogSource(h.authority, h.input);
    assert.equal(result.outcome, 'issue');
    const product = await h.adapter.get('products', h.productId);
    assert.deepEqual(product?.productFamily, family);
    assert.equal(product?.published, false);
    assert.notEqual(readCurrentCatalogPreparation(product ?? {})?.state, 'ready');
  });

test('lost completed worker reply is confirmed from the same durable job without creating another', async (t) => {
  const h = fixture(t);
  const result = await prepareSyncedCatalogSource(h.authority, h.input, {
    execute: async (...args) => {
      await runCatalogPreparationCall(...args);
      throw Error('Injected lost reply after completion');
    },
  });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.checked, true);
  assert.equal(
    (
      await h.adapter.list({
        collection: 'catalogPreparationJobs',
        page: 1,
        pageSize: 100,
        search: '',
      })
    ).items.length,
    1,
  );
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
});

test('an edit after worker completion prevents background confirmation of the old version', async (t) => {
  const h = fixture(t);
  const result = await prepareSyncedCatalogSource(h.authority, h.input, {
    execute: async (...args) => {
      const done = await runCatalogPreparationCall(...args);
      await h.adapter.update('products', h.productId, { name: 'Independent edit during readback' });
      return done;
    },
  });
  assert.equal(result.checked, false);
  const product = await h.adapter.get('products', h.productId);
  assert.equal(product?.name, 'Independent edit during readback');
  assert.equal(product?.published, false);
  assert.notEqual(readCurrentCatalogPreparation(product ?? {})?.state, 'ready');
});

test('an explicitly cancelled preparation becomes actionable instead of silently blocking the sync queue', async (t) => {
  const h = fixture(t);
  const result = await prepareSyncedCatalogSource(h.authority, h.input, {
    execute: async (authority, call) => {
      assert.ok(
        call && typeof call === 'object' && 'jobId' in call && typeof call.jobId === 'string',
      );
      const status = await manageCatalogPreparationJob(authority, {
        action: 'status',
        actorId: 'admin',
        jobId: call.jobId,
      });
      assert.ok(status.ok && 'status' in status);
      const cancelled = await manageCatalogPreparationJob(authority, {
        action: 'cancel',
        actorId: 'admin',
        jobId: call.jobId,
        expectedLeaseVersion: status.status.progress.leaseVersion,
      });
      assert.ok(cancelled.ok);
      return runCatalogPreparationCall(authority, call);
    },
  });
  assert.equal(result.outcome, 'issue');
  assert.equal(result.checked, false);
  assert.equal((await h.adapter.get('products', h.productId))?.published, false);
});

test('a transient preparation reservation BUSY stays retryable and cannot become a data issue', async (t) => {
  const h = fixture(t);
  const manage = h.adapter.manageCatalogPreparationJob.bind(h.adapter);
  h.adapter.manageCatalogPreparationJob = async (...args) =>
    args[1].action === 'start' ? { ok: false, code: 'BUSY' } : manage(...args);
  const first = await prepareSyncedCatalogSource(h.authority, h.input);
  assert.equal(first.outcome, 'waiting');
  assert.equal(first.checked, false);
  h.adapter.manageCatalogPreparationJob = manage;
  assert.equal((await prepareSyncedCatalogSource(h.authority, h.input)).outcome, 'complete');
});
