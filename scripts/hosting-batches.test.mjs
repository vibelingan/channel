import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertHostingBatchMembers,
  assertHostingRemovals,
  hostingBatchBeforeHash,
  hostingBatchHash,
  hostingRemovalHash,
  mapHostingBounded,
  siteRemovalBatches,
  siteUploadBatches,
  withSiteUploadBatches,
} from './release/hosting-batches.mjs';
import { identity } from './release/input.mjs';
const entry = (path) => ({ path, bytes: 1, sha256: 'a'.repeat(64) });
const plan = (uploads) => {
  const body = {
    scope: { kind: 'site' },
    uploads,
    publicOutput: { discoveryPaths: ['extra.xml'] },
  };
  return { ...body, planSha256: identity(body) };
};
test('site batches bind every object and keep assets, leaf HTML, entry HTML and discovery in order', () => {
  const entries = [
    ...Array.from({ length: 13 }, (_, i) => entry(`_astro/${i}.js`)),
    entry('products/p-one/index.html'),
    entry('blog/index.html'),
    entry('index.html'),
    entry('sitemap-index.xml'),
  ];
  const batches = siteUploadBatches(withSiteUploadBatches(plan(entries)));
  assert.deepEqual(
    batches.map((x) => x.length),
    [12, 1, 1, 2, 1],
  );
  assert.deepEqual(batches.flat(), entries);
  assert.notEqual(hostingBatchHash(batches[0]), hostingBatchHash([...batches[0]].reverse()));
  assert.throws(() =>
    siteUploadBatches({ ...plan(entries), delivery: { batchSize: 100, parallel: 4 } }),
  );
  assert.throws(() => withSiteUploadBatches({ ...plan(entries), scope: { kind: 'canary' } }));
});
test('batch membership includes exact before states and refuses ambiguous or duplicated paths', () => {
  const m = [{ ...entry('index.html'), beforeHash: 'absent' }];
  assert.doesNotThrow(() => assertHostingBatchMembers(m));
  assert.notEqual(
    hostingBatchBeforeHash(m),
    hostingBatchBeforeHash([{ ...m[0], beforeHash: 'b'.repeat(64) }]),
  );
  for (const bad of [
    [],
    [...m, ...m],
    [{ ...m[0], beforeHash: 'unknown' }],
    Array.from({ length: 13 }, (_, i) => ({ ...m[0], path: `${i}.html` })),
  ])
    assert.throws(() => assertHostingBatchMembers(bad));
});
test('site removals preserve exact paths in bounded batches, while old plans stay sequential', () => {
  const raw = plan([]);
  const { planSha256, ...body } = raw;
  body.deletes = Array.from({ length: 25 }, (_, n) => `products/p-${n}/index.html`);
  const source = { ...body, planSha256: identity(body) };
  const next = withSiteUploadBatches(source);
  assert.deepEqual(
    siteRemovalBatches(next).map((batch) => batch.length),
    [12, 12, 1],
  );
  assert.deepEqual(siteRemovalBatches(next).flat(), body.deletes);
  assert.equal(siteRemovalBatches({ ...source, delivery: { batchSize: 12, parallel: 4 } }), null);
  assert.throws(() =>
    siteRemovalBatches({ ...next, delivery: { ...next.delivery, removeBatchSize: 100 } }),
  );
});
test('a removal intent binds unique exact paths and before states without inventing file hashes', () => {
  const rows = [{ path: 'blog/retired/index.html', beforeHash: 'a'.repeat(64) }];
  assert.doesNotThrow(() => assertHostingRemovals(rows));
  for (const bad of [
    [],
    [...rows, ...rows],
    [{ ...rows[0], beforeHash: 'unknown' }],
    Array.from({ length: 13 }, (_, n) => ({ ...rows[0], path: `blog/${n}/index.html` })),
  ])
    assert.throws(() => assertHostingRemovals(bad));
  assert.notEqual(
    hostingRemovalHash(rows.map((r) => r.path)),
    hostingRemovalHash(['blog/other/index.html']),
  );
});
test('bounded work waits for in-flight operations and schedules nothing further after failure', async () => {
  const started = [];
  const finished = [];
  let active = 0;
  let maximum = 0;
  await assert.rejects(
    mapHostingBounded([0, 1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      started.push(n);
      active++;
      maximum = Math.max(maximum, active);
      await delay(n === 0 ? 1 : 15);
      active--;
      finished.push(n);
      if (n === 0) throw Error('lost acknowledgement');
    }),
  );
  assert.equal(maximum, 4);
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(finished.length, 4);
  assert.equal(active, 0);
});
test('bounded successful checks preserve input order and check all objects', async () => {
  const result = await mapHostingBounded([0, 1, 2, 3, 4, 5], 4, async (n) => {
    await delay(6 - n);
    return n * 2;
  });
  assert.deepEqual(result, [0, 2, 4, 6, 8, 10]);
});

test('bounded checks reject invalid limits and retain even a non-Error failure', async () => {
  for (const limit of [0, 5, 1.5])
    await assert.rejects(mapHostingBounded([1], limit, async () => true));
  let calls = 0;
  try {
    await mapHostingBounded([1, 2], 1, async () => {
      calls++;
      throw null;
    });
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error, null);
  }
  assert.equal(calls, 1);
});
