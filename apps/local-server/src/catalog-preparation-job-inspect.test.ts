import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import {
  readCatalogPreparationLease,
  get as registeredGet,
  setAdapter,
} from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { inspectCatalogPreparationJob } from '@vibelingan-channel/fn-admin/catalog-preparation-job-inspect';
import { CatalogPreparationReportSchema } from '@vibelingan-channel/shared/catalog-preparation';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { JsonFileAdapter } from './json-adapter.ts';
async function fixture(t: { after(fn: () => void): void }, manual = false, count = 0) {
  const h = sourceFixture(count);
  const directory = mkdtempSync(join(tmpdir(), 'channel-leased-candidate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (manual) Reflect.deleteProperty(h.product, 'alibabaPrimarySourceKey');
  const id = (i: number) => `image-${String(i).padStart(4, '0')}`;
  const url = (i: number) => `https://sc04.alicdn.com/inspection-${i}.png`;
  for (const [i, v] of h.observation.variants.entries())
    v.media = [{ sourceUrl: url(i), position: 0, role: 'variant' }];
  const observation = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(observation);
  observation.observation = h.observation;
  h.adapter.rows.catalogSourceLinks = Array.from({ length: count }, (_, i) => ({
    _id: sourceMediaLinkId('alibaba', url(i)),
    provider: 'alibaba',
    sourceUrl: url(i),
    imageId: id(i),
  }));
  h.adapter.rows.images = Array.from({ length: count }, (_, i) => ({
    _id: id(i),
    status: 'active',
    storageProvider: 'cloudbase-storage',
    publishedRefCount: 0,
  }));
  const file = join(directory, 'db.json');
  writeFileSync(file, JSON.stringify(h.adapter.rows));
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'leased-candidate-test',
    environmentId: 'local',
    now: () => now,
  });
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command, now);
  const start = await run({ action: 'start', actorId: 'admin', productId: h.product._id });
  assert.ok(start.ok && 'progress' in start);
  const call = await run({ action: 'dispatch', actorId: 'admin', jobId: start.progress.jobId });
  assert.ok(call.ok && 'call' in call);
  const claim = await run({ action: 'claim', call: call.call, owner: 'worker' });
  assert.ok(claim.ok && 'lease' in claim);
  const inspect = () =>
    inspectCatalogPreparationJob(authority, start.progress.jobId, claim.lease, { now: () => now });
  return {
    file,
    adapter,
    authority,
    jobId: start.progress.jobId,
    lease: claim.lease,
    product: h.product,
    run,
    inspect,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
for (const manual of [false, true])
  test(`actual leased candidate needs no administrator account, manual=${manual}`, async (t) => {
    const f = await fixture(t, manual);
    const before = await f.adapter.get('products', f.product._id);
    await f.adapter.remove('users', 'admin');
    const get = f.adapter.get.bind(f.adapter);
    let userReads = 0;
    f.adapter.get = async (c, id) => {
      if (c === 'users') userReads++;
      return get(c, id);
    };
    const result = await f.inspect();
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.kind, 'unsealed-inspection');
    assert.equal(result.previewReady, true);
    assert.equal(CatalogPreparationReportSchema.safeParse(result).success, false);
    assert.equal(userReads, 0);
    assert.deepEqual(await f.adapter.get('products', f.product._id), before);
    assert.equal((await f.adapter.get('catalogPreparationJobs', f.jobId))?.state, 'running');
  });
test('actual leased source candidate includes every adopted image beyond the first page', async (t) => {
  const f = await fixture(t, false, 105);
  const before = await f.adapter.get('products', f.product._id);
  const result = await f.inspect();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.imageIds.length, 105);
  assert.deepEqual(result.imageIds, [...new Set(result.imageIds)].sort());
  assert.equal(result.imageIds.at(-1), 'image-0104');
  assert.deepEqual(result.media, { scanned: 105, total: 105 });
  assert.deepEqual(await f.adapter.get('products', f.product._id), before);
});
for (const reason of ['forged', 'serialized', 'expired', 'cancelled'] as const)
  test(`actual task rejects ${reason} access without reading candidate inputs`, async (t) => {
    const f = await fixture(t);
    let lease: unknown = f.lease;
    if (reason === 'forged') lease = {};
    if (reason === 'serialized') lease = JSON.parse(JSON.stringify(f.lease));
    if (reason === 'expired') f.now += 120000;
    if (reason === 'cancelled')
      assert.ok(
        (
          await f.run({
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: 1,
          })
        ).ok,
      );
    let reads = 0;
    const get = f.adapter.get.bind(f.adapter);
    f.adapter.get = async (c, id) => {
      reads++;
      return get(c, id);
    };
    const result = await inspectCatalogPreparationJob(f.authority, f.jobId, lease, {
      now: () => f.now,
    });
    assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
    assert.equal(reads, 0);
  });
for (const action of ['cancel', 'edit'] as const)
  test(`actual leased candidate rejects ${action} during source reads`, async (t) => {
    const f = await fixture(t);
    let changed = false;
    const get = f.adapter.get.bind(f.adapter);
    f.adapter.get = async (c, id) => {
      if (c === 'catalogSourceObservations' && !changed) {
        changed = true;
        if (action === 'cancel')
          await f.run({
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: 1,
          });
        else
          await f.adapter.update('products', f.product._id, { name: 'Edited during inspection' });
      }
      return get(c, id);
    };
    const result = await f.inspect();
    assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
    assert.equal(changed, true);
    const reopened = new JsonFileAdapter(f.file);
    assert.equal(
      (await reopened.get('catalogPreparationJobs', f.jobId))?.state,
      action === 'cancel' ? 'cancelled' : 'stale',
    );
    assert.equal((await reopened.get('products', f.product._id))?.published, false);
    const file: unknown = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.ok(file && typeof file === 'object');
  });

test('service inspection projects adapter failure fields and keeps private diagnostics inside the backend', async (t) => {
  const f = await fixture(t);
  Object.defineProperty(f.adapter, 'manageCatalogPreparationJob', {
    value: async () => ({ ok: false, code: 'CONFLICT', privateTrace: 'private-only' }),
  });
  assert.deepEqual(await f.inspect(), { ok: false, code: 'CONFLICT' });
});

for (const manual of [false, true])
  test(`one leased inspection has one heartbeat and immutable business rows, manual=${manual}`, async (t) => {
    const f = await fixture(t, manual);
    const before = JSON.parse(readFileSync(f.file, 'utf8'));
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let renewals = 0;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      if (args[1].action === 'renew') renewals++;
      return manage(...args);
    };
    f.now += 5000;
    const result = await f.inspect();
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(renewals, 1);
    const after = JSON.parse(readFileSync(f.file, 'utf8'));
    const oldJob = before.catalogPreparationJobs[0];
    const newJob = after.catalogPreparationJobs[0];
    assert.equal(newJob.mutationRevision, oldJob.mutationRevision + 1);
    assert.equal(newJob.leaseExpiresAt, f.now + 120000);
    Reflect.deleteProperty(before, 'catalogPreparationJobs');
    Reflect.deleteProperty(after, 'catalogPreparationJobs');
    assert.deepEqual(after, before);
  });

for (const change of ['name', 'description', 'nonce', 'shape'] as const)
  test(`inspection rejects raw ${change} replacement after initial renewal without relying on a generation edit`, async (t) => {
    const f = await fixture(t, false, 1);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let replaced = false;
    let generation: unknown;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const result = await manage(...args);
      if (args[1].action === 'renew' && result.ok && !replaced) {
        replaced = true;
        const rows = JSON.parse(readFileSync(f.file, 'utf8'));
        generation = rows.products[0].catalogContentGeneration;
        if (change === 'name') rows.products[0].name = 'Valid independent name';
        if (change === 'description')
          rows.products[0].description = 'Valid independent description';
        if (change === 'nonce') rows.catalogPreparationJobs[0].nonce = 'f'.repeat(64);
        if (change === 'shape') rows.catalogPreparationJobs[0].unexpected = true;
        writeFileSync(f.file, JSON.stringify(rows));
      }
      return result;
    };
    const result = await inspectCatalogPreparationJob(f.authority, f.jobId, f.lease, {
      now: () => f.now,
      mediaMode: 'defer',
    });
    assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
    assert.equal(replaced, true);
    const product = await f.adapter.get('products', f.product._id);
    assert.equal(product?.catalogContentGeneration, generation);
    assert.equal(product?.published, false);
    assert.notEqual(product?.catalogPreparationState, 'ready');
  });
for (const change of ['expire', 'takeover'] as const)
  test(`inspection rejects a lease ${change} during source reads`, async (t) => {
    const f = await fixture(t);
    let changed = false;
    const get = f.adapter.get.bind(f.adapter);
    f.adapter.get = async (collection, id) => {
      if (collection === 'catalogSourceObservations' && !changed) {
        changed = true;
        f.now += 120001;
        if (change === 'takeover') {
          const d = await f.run({ action: 'dispatch', actorId: 'admin', jobId: f.jobId });
          assert.ok(d.ok && 'call' in d);
          assert.ok(
            (await f.run({ action: 'claim', call: d.call, owner: 'new-independent-worker' })).ok,
          );
        }
      }
      return get(collection, id);
    };
    assert.deepEqual(await f.inspect(), { ok: false, code: 'CONFLICT' });
    assert.equal(changed, true);
    assert.equal((await f.adapter.get('products', f.product._id))?.published, false);
  });

test('a newly adopted source image before binding a media plan remains a valid unsealed candidate', async (t) => {
  const f = await fixture(t, false, 1);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let replaced = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'renew' && result.ok && !replaced) {
      replaced = true;
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.catalogSourceLinks[0].imageId = 'replacement-image';
      rows.images.push({ ...rows.images[0], _id: 'replacement-image' });
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return result;
  };
  const result = await inspectCatalogPreparationJob(f.authority, f.jobId, f.lease, {
    now: () => f.now,
    mediaMode: 'defer',
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.kind, 'unsealed-inspection');
  assert.deepEqual(result.imageIds, ['replacement-image']);
  assert.equal(CatalogPreparationReportSchema.safeParse(result).success, false);
  assert.equal((await f.adapter.get('products', f.product._id))?.published, false);
});

for (const invalid of ['forged', 'serialized', 'wrong-job'] as const)
  test(`private lease read refuses ${invalid} before touching storage`, async (t) => {
    const f = await fixture(t);
    let reads = 0;
    const get = f.adapter.get.bind(f.adapter);
    f.adapter.get = async (...args) => {
      reads++;
      return get(...args);
    };
    const lease =
      invalid === 'serialized'
        ? JSON.parse(JSON.stringify(f.lease))
        : invalid === 'forged'
          ? {}
          : f.lease;
    const jobId = invalid === 'wrong-job' ? 'f'.repeat(64) : f.jobId;
    assert.equal(await readCatalogPreparationLease(f.authority, jobId, lease, f.now), null);
    assert.equal(reads, 0);
  });
test('private lease point read never registers technical jobs for generic CRUD', async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => registeredGet('catalogPreparationJobs', f.jobId), {
    name: 'UnknownCollectionError',
  });
  const scope = await readCatalogPreparationLease(f.authority, f.jobId, f.lease, f.now);
  assert.ok(scope);
  assert.equal(scope.jobId, f.jobId);
  assert.equal(scope.productId, f.product._id);
  assert.equal(Reflect.has(scope, 'nonce'), false);
  assert.equal(Reflect.has(scope, 'schemaVersion'), false);
  assert.equal(Reflect.has(scope, 'mediaSeal'), false);
});

test('failed conflict settlement stays unavailable and cannot claim ready or cancel another task', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let renewals = 0;
  const actions: string[] = [];
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    actions.push(args[1].action);
    if (args[1].action === 'renew' && ++renewals > 1) throw Error('temporary storage failure');
    const result = await manage(...args);
    if (args[1].action === 'renew' && result.ok) {
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.products[0].name = 'Valid independent change';
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return result;
  };
  assert.deepEqual(await f.inspect(), { ok: false, code: 'UNAVAILABLE' });
  assert.deepEqual(actions, ['renew', 'renew']);
  assert.equal((await f.adapter.get('products', f.product._id))?.published, false);
});
