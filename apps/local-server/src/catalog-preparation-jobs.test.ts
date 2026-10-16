import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manageCatalogPreparationJob, setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { JsonFileAdapter } from './json-adapter.ts';
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-preparation-jobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [{ _id: 'p', name: 'Clock', published: false, productFamily: 'misc' }],
    }),
  );
  let now = 1792080000000;
  const authority = createCatalogPreparationAuthority({
    secret: 'local-test-secret',
    environmentId: 'local',
    now: () => now,
  });
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    manageCatalogPreparationJob(authority, command, now);
  async function start() {
    const r = await run({ action: 'start', actorId: 'admin', productId: 'p' });
    assert.ok(r.ok && 'progress' in r);
    return r.progress;
  }
  async function call(jobId: string) {
    const r = await run({ action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(r.ok && 'call' in r);
    return r.call;
  }
  return {
    directory,
    file,
    adapter,
    authority,
    run,
    start,
    call,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}
test('actual file adapter persists one deterministic job through reopen and lost ACK retry', async (t) => {
  const f = fixture(t);
  const before = await f.adapter.get('products', 'p');
  const p = await f.start();
  const reopened = new JsonFileAdapter(f.file);
  const r = await reopened.manageCatalogPreparationJob(
    f.authority,
    { action: 'start', actorId: 'admin', productId: 'p' },
    f.now,
  );
  assert.ok(r.ok && 'progress' in r);
  assert.deepEqual(r.progress, p);
  assert.deepEqual(await reopened.get('products', 'p'), before);
  assert.equal(
    Object.keys(r.progress).some((x) => /nonce|signature|secret/.test(x)),
    false,
  );
});
test('two actual adapter instances race claim: exactly one succeeds, one is busy', async (t) => {
  const f = fixture(t);
  const p = await f.start();
  const call = await f.call(p.jobId);
  const second = new JsonFileAdapter(f.file);
  const results = await Promise.allSettled([
    f.adapter.manageCatalogPreparationJob(
      f.authority,
      { action: 'claim', call, owner: 'one' },
      f.now,
    ),
    second.manageCatalogPreparationJob(f.authority, { action: 'claim', call, owner: 'two' }, f.now),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.ok).length, 1);
  assert.equal(
    results.filter((r) => r.status === 'fulfilled' && !r.value.ok && r.value.code === 'BUSY')
      .length,
    1,
  );
  const saved = await second.get('catalogPreparationJobs', p.jobId);
  assert.equal(saved?.leaseVersion, 1);
  assert.equal(saved?.attempt, 1);
});
test('STALE failure still persists stale state without changing product lifecycle', async (t) => {
  const f = fixture(t);
  const p = await f.start();
  const claim = await f.run({ action: 'claim', call: await f.call(p.jobId), owner: 'worker' });
  assert.ok(claim.ok && 'lease' in claim);
  await f.adapter.update('products', 'p', { name: 'New clock' });
  assert.deepEqual(await f.run({ action: 'renew', jobId: p.jobId, lease: claim.lease }), {
    ok: false,
    code: 'STALE',
  });
  const reopened = new JsonFileAdapter(f.file);
  assert.equal((await reopened.get('catalogPreparationJobs', p.jobId))?.state, 'stale');
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
test('disk failure rolls back staged memory and leaves exact original file', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  Object.defineProperty(f.adapter, 'persist', {
    value: () => {
      throw new Error('preparation-disk-fault');
    },
    configurable: true,
  });
  await assert.rejects(f.start(), /preparation-disk-fault/);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const store: unknown = Reflect.get(f.adapter, 'store');
  assert.ok(store && typeof store === 'object');
  assert.equal(Object.hasOwn(store, 'catalogPreparationJobs'), false);
  Reflect.deleteProperty(f.adapter, 'persist');
});

test('process authority replacement resumes expired durable job and fences old grant', async (t) => {
  const f = fixture(t);
  const p = await f.start();
  const old = await f.run({ action: 'claim', call: await f.call(p.jobId), owner: 'old' });
  assert.ok(old.ok && 'lease' in old);
  f.now += 120001;
  const fresh = createCatalogPreparationAuthority({
    secret: 'local-test-secret',
    environmentId: 'local',
    now: () => f.now,
  });
  const reopened = new JsonFileAdapter(f.file);
  const call = await reopened.manageCatalogPreparationJob(
    fresh,
    { action: 'dispatch', actorId: 'admin', jobId: p.jobId },
    f.now,
  );
  assert.ok(call.ok && 'call' in call);
  const r = await reopened.manageCatalogPreparationJob(
    fresh,
    { action: 'claim', call: call.call, owner: 'replacement' },
    f.now,
  );
  assert.ok(r.ok && 'lease' in r);
  assert.equal(r.progress.leaseVersion, 2);
  assert.deepEqual(await f.run({ action: 'release', jobId: p.jobId, lease: old.lease }), {
    ok: false,
    code: 'CONFLICT',
  });
});
for (const cancelFirst of [true, false])
  test(`expired claim and old cancel race stays fenced, cancelFirst=${cancelFirst}`, async (t) => {
    const f = fixture(t);
    const p = await f.start();
    await f.run({ action: 'claim', call: await f.call(p.jobId), owner: 'old' });
    f.now += 120001;
    const call = await f.call(p.jobId);
    const cancel = () =>
      f.run({ action: 'cancel', actorId: 'admin', jobId: p.jobId, expectedLeaseVersion: 1 });
    const claim = () => f.run({ action: 'claim', call, owner: 'replacement' });
    const operations = cancelFirst ? [cancel, claim] : [claim, cancel];
    const results = await Promise.allSettled(operations.map((fn) => fn()));
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.ok).length, 1);
    assert.equal(
      results.filter((r) => r.status === 'fulfilled' && !r.value.ok && r.value.code === 'CONFLICT')
        .length,
      1,
    );
    const saved = await f.adapter.get('catalogPreparationJobs', p.jobId);
    assert.equal(saved?.state, cancelFirst ? 'cancelled' : 'running');
    assert.equal(saved?.leaseVersion, cancelFirst ? 1 : 2);
  });

test('default job clock starts after the actual mutation queue is acquired', async (t) => {
  const f = fixture(t);
  let clock = f.now;
  t.mock.method(Date, 'now', () => clock);
  const pending = f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  clock += 6000;
  const result = await pending;
  assert.ok(result.ok && 'progress' in result);
  assert.equal(result.progress.createdAt, new Date(clock).toISOString());
});
