import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { readCatalogPreparationJob } from '@vibelingan-channel/db/catalog-preparation-jobs';
import { catalogSealedImageIdsDigest } from '@vibelingan-channel/db/catalog-preparation-media-seal';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import { runCatalogPreparationWorker } from '../../functions/admin/src/catalog-preparation-worker.ts';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { importCandidateImage } from '../../functions/alibaba-catalog-sync/src/media-import.ts';
import { JsonFileAdapter } from './json-adapter.ts';
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
async function fixture(t: { after(fn: () => void): void }, count = 9, missingCategory = false) {
  const dir = mkdtempSync(join(tmpdir(), 'channel-preparation-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(dir, 'media'));
  setMediaStorage(storage);
  const images = [];
  for (let i = 0; i < count; i++) {
    const id = `image-${String(i).padStart(4, '0')}`;
    const target = await storage.putObject({
      namespace: 'catalog',
      logicalId: id,
      fileName: 'sample.png',
      mimeType: 'image/png',
      content: bytes,
    });
    images.push({
      _id: id,
      ...target,
      status: 'active',
      mimeType: 'image/png',
      byteSize: bytes.length,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      publishedRefCount: 0,
    });
  }
  const file = join(dir, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        {
          _id: 'p',
          name: 'Clock',
          ...(missingCategory ? {} : { productFamily: 'misc' }),
          published: false,
          imageIds: images.map((i) => i._id),
        },
      ],
      images,
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
  });
  const start = await adapter.manageCatalogPreparationJob(authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  assert.ok(start.ok && 'progress' in start);
  const jobId = start.progress.jobId;
  async function dispatch(a = adapter, auth = authority) {
    const r = await a.manageCatalogPreparationJob(auth, {
      action: 'dispatch',
      actorId: 'admin',
      jobId,
    });
    assert.ok(r.ok && 'call' in r);
    return r.call;
  }
  return { adapter, file, authority, jobId, dispatch, storage, images };
}
test('default file storage/native pixels check9 images across bounded steps and database reopen', async (t) => {
  const f = await fixture(t);
  const before = await f.adapter.get('products', 'p');
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.kind, 'unsealed-worker-step');
  assert.equal(first.media?.checked, 4);
  assert.equal(first.media?.total, 9);
  assert.equal(first.outcome, 'partial');
  const reopened = new JsonFileAdapter(f.file);
  setAdapter(reopened);
  const fresh = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
  });
  const second = await runCatalogPreparationWorker(fresh, await f.dispatch(reopened, fresh));
  assert.ok(second.ok);
  assert.equal(second.media?.checked, 8);
  const third = await runCatalogPreparationWorker(fresh, await f.dispatch(reopened, fresh));
  assert.ok(third.ok);
  assert.equal(third.media?.checked, 9);
  assert.equal(third.media?.verified, 9);
  assert.equal(third.outcome, 'checked');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  const observations = rows.catalogImageObservations.filter(
    (row: { kind: string }) => row.kind === 'unsealed-image-observation-v1',
  );
  assert.equal(observations.length, 9);
  assert.equal(
    rows.catalogImageObservations.filter(
      (row: { kind: string }) => row.kind === 'catalog-image-protection-intent-v1',
    ).length,
    9,
  );
  for (const image of rows.images) {
    assert.ok(image.storagePath.startsWith('catalog/sealed/'));
    assert.equal(image.catalogStorageProtection.kind, 'catalog-protected-target-v1');
  }
  for (const row of observations) {
    assert.equal(row.health.width, 24);
    assert.equal(row.health.height, 16);
    assert.equal(row.health.checksumSha256, createHash('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(await reopened.get('products', 'p'), before);
  assert.equal(rows.catalogPreparationJobs[0].state, 'queued');
});
for (const fault of ['signature', 'extra-timer', 'expired'] as const)
  test(`worker rejects ${fault} before any database operation`, async (t) => {
    const f = await fixture(t, 1);
    const call = await f.dispatch();
    let calls = 0;
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      calls++;
      return manage(...args);
    };
    const bad =
      fault === 'signature'
        ? { ...call, signature: 'a'.repeat(64) }
        : fault === 'extra-timer'
          ? { ...call, Type: 'Timer' }
          : { ...call, issuedAt: call.issuedAt - 60000, expiresAt: call.expiresAt - 60000 };
    assert.deepEqual(await runCatalogPreparationWorker(f.authority, bad), {
      ok: false,
      code: 'FORBIDDEN',
    });
    assert.equal(calls, 0);
  });
test('cancel during default native image check fences the observation and keeps product unpublished', async (t) => {
  const f = await fixture(t, 2);
  let checks = 0;
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async (id) => {
      checks++;
      const health = await readStoredCatalogImageHealth(id);
      assert.ok(
        (
          await f.adapter.manageCatalogPreparationJob(f.authority, {
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: 1,
          })
        ).ok,
      );
      return health;
    },
  });
  assert.deepEqual(r, { ok: false, code: 'CONFLICT' });
  assert.equal(checks, 1);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    rows.catalogImageObservations.filter(
      (row: { kind: string }) => row.kind === 'unsealed-image-observation-v1',
    ).length,
    0,
  );
  assert.equal(
    rows.catalogImageObservations.filter(
      (row: { kind: string }) => row.kind === 'catalog-preparation-image-hold-v1',
    ).length,
    1,
  );
  assert.equal(rows.catalogPreparationJobs[0].state, 'cancelled');
  assert.equal(rows.products[0].published, false);
});
test('lost step ACK resumes after the committed cursor without repeating its pixel check', async (t) => {
  const f = await fixture(t, 2);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lose = true;
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    const r = await manage(a, cmd, now);
    if (cmd.action === 'advance-media-check' && lose) {
      lose = false;
      throw Error('lost-worker-ack');
    }
    return r;
  };
  const seen: string[] = [];
  const checkImage = async (id: string) => {
    seen.push(id);
    return readStoredCatalogImageHealth(id);
  };
  assert.deepEqual(
    await runCatalogPreparationWorker(f.authority, await f.dispatch(), { checkImage }),
    { ok: false, code: 'UNAVAILABLE' },
  );
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch(), { checkImage });
  assert.ok(next.ok);
  assert.equal(next.media?.checked, 2);
  assert.deepEqual(seen, ['image-0000', 'image-0001']);
  assert.equal(next.outcome, 'checked');
});
test('bad current image is an explicit blocked observation, never checked-as-verified', async (t) => {
  const f = await fixture(t, 1);
  const data = JSON.parse(readFileSync(f.file, 'utf8'));
  data.images[0].checksumSha256 = 'b'.repeat(64);
  writeFileSync(f.file, JSON.stringify(data));
  setAdapter(new JsonFileAdapter(f.file));
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok);
  assert.equal(r.media?.checked, 1);
  assert.equal(r.media?.invalid, 1);
  assert.equal(r.media?.verified, 0);
  assert.equal(r.outcome, 'blocked');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).products[0].published, false);
});
test('soft budget leaves a durable resumable prefix and no image check concurrency', async (t) => {
  const f = await fixture(t, 9);
  let time = Date.now();
  let active = 0;
  let max = 0;
  let checks = 0;
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    now: () => time,
    checkImage: async (id) => {
      active++;
      max = Math.max(max, active);
      checks++;
      const health = await readStoredCatalogImageHealth(id);
      active--;
      time += 20000;
      return health;
    },
  });
  assert.ok(r.ok);
  assert.equal(r.media?.checked, 1);
  assert.equal(r.outcome, 'partial');
  assert.equal(checks, 1);
  assert.equal(max, 1);
});

test('claim transport failure is projected without leaking an exception or inventing a lease', async (t) => {
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    if (cmd.action === 'claim') throw Error('private-cloud-endpoint');
    return manage(a, cmd, now);
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, call), {
    ok: false,
    code: 'UNAVAILABLE',
  });
});
test('release failure never reports a successful completed step', async (t) => {
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    if (cmd.action === 'release') throw Error('private-release-endpoint');
    return manage(a, cmd, now);
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, call), {
    ok: false,
    code: 'UNAVAILABLE',
  });
  const job = JSON.parse(readFileSync(f.file, 'utf8')).catalogPreparationJobs[0];
  assert.equal(job.state, 'running');
  assert.equal(job.media.cursor, 1);
});
test('product edit during a check marks the old job stale and cannot publish old data', async (t) => {
  const f = await fixture(t, 2);
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async (id) => {
      const health = await readStoredCatalogImageHealth(id);
      const row = await f.adapter.get('products', 'p');
      assert.ok(row);
      await f.adapter.update('products', 'p', { name: 'New title' });
      return health;
    },
  });
  assert.deepEqual(r, { ok: false, code: 'STALE' });
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogPreparationJobs[0].state, 'stale');
  assert.equal(rows.products[0].published, false);
  assert.equal(
    rows.catalogImageObservations.filter(
      (row: { kind: string }) => row.kind === 'unsealed-image-observation-v1',
    ).length,
    0,
  );
  assert.equal(
    rows.catalogImageObservations.filter(
      (row: { kind: string }) => row.kind === 'catalog-preparation-image-hold-v1',
    ).length,
    1,
  );
});

async function sourceWorkspace(t: { after(fn: () => void): void }, count = 105) {
  const f = await fixture(t, count);
  const h = sourceFixture(count);
  const url = (i: number) => `https://sc04.alicdn.com/worker-${i}.png`;
  for (const [i, v] of h.observation.variants.entries())
    v.media = [{ sourceUrl: url(i), position: 0, role: 'variant' }];
  const observation = h.adapter.rows.catalogSourceObservations?.[0];
  assert.ok(observation);
  observation.observation = h.observation;
  h.adapter.rows.catalogSourceLinks = f.images.map((image, i) => ({
    _id: sourceMediaLinkId('alibaba', url(i)),
    provider: 'alibaba',
    sourceUrl: url(i),
    imageId: image._id,
  }));
  h.adapter.rows.images = f.images;
  writeFileSync(f.file, JSON.stringify(h.adapter.rows));
  const adapter = new JsonFileAdapter(f.file);
  setAdapter(adapter);
  const s = await adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId: h.product._id,
  });
  assert.ok(s.ok && 'progress' in s);
  const dispatch = async () => {
    const r = await adapter.manageCatalogPreparationJob(f.authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: s.progress.jobId,
    });
    assert.ok(r.ok && 'call' in r);
    return r.call;
  };
  return { ...f, adapter, dispatch, jobId: s.progress.jobId, productId: h.product._id, url };
}
test('105 source configurations retain the full plan with metadata reads only for four processed images', async (t) => {
  const f = await sourceWorkspace(t);
  let imageReads = 0;
  const readIds = new Set<string>();
  let batches = 0;
  const get = f.adapter.get.bind(f.adapter);
  const list = f.adapter.list.bind(f.adapter);
  f.adapter.get = async (c, id) => {
    if (c === 'images') {
      imageReads++;
      readIds.add(id);
    }
    return get(c, id);
  };
  f.adapter.list = async (q) => {
    if (q.collection === 'catalogSourceLinks') batches++;
    return list(q);
  };
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.media.total, 105);
  assert.equal(r.media.checked, 4);
  assert.equal(r.media.verified, 4);
  assert.equal(imageReads, 28);
  assert.deepEqual(
    [...readIds].sort(),
    f.images.slice(0, 4).map((image) => image._id),
  );
  assert.equal(batches, 2);
  assert.equal((await f.adapter.get('products', f.productId))?.published, false);
});
test('source photo binding replacement during the last check cannot report the old adopted set checked', async (t) => {
  const f = await sourceWorkspace(t, 1);
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async (id) => {
      const health = await readStoredCatalogImageHealth(id);
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.catalogSourceLinks[0].imageId = 'replacement-image';
      writeFileSync(f.file, JSON.stringify(rows));
      return health;
    },
  });
  assert.deepEqual(r, { ok: false, code: 'CONFLICT' });
  assert.equal((await f.adapter.get('products', f.productId))?.published, false);
});
test('actual alibaba function main handles signed worker messages before timer-shaped extras', async (t) => {
  const oldEnv = process.env.TCB_ENV;
  const oldSecret = process.env.JWT_SECRET;
  process.env.TCB_ENV = 'local-worker-env';
  process.env.JWT_SECRET = 'worker-local-test';
  t.after(() => {
    if (oldEnv === undefined) Reflect.deleteProperty(process.env, 'TCB_ENV');
    else process.env.TCB_ENV = oldEnv;
    if (oldSecret === undefined) Reflect.deleteProperty(process.env, 'JWT_SECRET');
    else process.env.JWT_SECRET = oldSecret;
  });
  const { main } = await import('../../functions/alibaba-catalog-sync/src/index.ts');
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  assert.deepEqual(await main({ ...call, Type: 'Timer' }), { ok: false, code: 'FORBIDDEN' });
  const result = await main(call);
  assert.ok(
    result &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok === true &&
      'kind' in result &&
      result.kind === 'unsealed-worker-step' &&
      'media' in result &&
      result.media &&
      typeof result.media === 'object' &&
      'checked' in result.media,
  );
  assert.equal(result.media.checked, 1);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

test('zero-image candidate performs no pixel checks and remains unsealed', async (t) => {
  const f = await fixture(t, 0);
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async () => {
      throw Error('zero plan must not decode');
    },
  });
  assert.ok(r.ok);
  assert.equal(r.kind, 'unsealed-worker-step');
  assert.equal(r.media.checked, 0);
  assert.equal(r.media.total, 0);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('service worker needs no manufactured human account and does not fill missing classification', async (t) => {
  const f = await fixture(t, 1, true);
  const before = await f.adapter.get('products', 'p');
  assert.ok(before);
  assert.equal(Object.hasOwn(before, 'productFamily'), false);
  const call = await f.dispatch();
  await f.adapter.remove('users', 'admin');
  const r = await runCatalogPreparationWorker(f.authority, call);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(await f.adapter.get('products', 'p'), before);
  assert.equal(await f.adapter.get('users', 'admin'), null);
});

test('cancel after the last plan read but before lease release refuses success', async (t) => {
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, cmd, now) => {
    if (cmd.action === 'release')
      assert.ok(
        (
          await manage(
            a,
            { action: 'cancel', actorId: 'admin', jobId: f.jobId, expectedLeaseVersion: 1 },
            now,
          )
        ).ok,
      );
    return manage(a, cmd, now);
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, call), {
    ok: false,
    code: 'CONFLICT',
  });
  assert.equal(
    JSON.parse(readFileSync(f.file, 'utf8')).catalogPreparationJobs[0].state,
    'cancelled',
  );
});

test('default worker rejects corrupt pixels even when stored length and SHA are accurate', async (t) => {
  const f = await fixture(t, 1);
  const corrupt = Uint8Array.from(bytes);
  corrupt[corrupt.length - 20] = (corrupt[corrupt.length - 20] ?? 0) ^ 0xff;
  const target = await f.storage.putObject({
    namespace: 'catalog',
    logicalId: 'image-0000',
    fileName: 'bad.png',
    mimeType: 'image/png',
    content: corrupt,
  });
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  Object.assign(rows.images[0], target, {
    byteSize: corrupt.length,
    checksumSha256: createHash('sha256').update(corrupt).digest('hex'),
  });
  writeFileSync(f.file, JSON.stringify(rows));
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok);
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.media.invalid, 1);
  assert.equal(r.media.verified, 0);
  const stored = JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations.find(
    (row: { kind: string }) => row.kind === 'unsealed-image-observation-v1',
  );
  assert.equal(stored.health.status, 'invalid');
  assert.equal(stored.health.reason, 'content');
});
test('transient image failure persists as retry, and explicit retry can rerun the actual default path', async (t) => {
  const f = await fixture(t, 1);
  const failed = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async () => ({ status: 'retry', reason: 'timeout' }),
  });
  assert.ok(failed.ok);
  assert.equal(failed.outcome, 'retryable');
  assert.equal(failed.media.retry, 1);
  assert.equal(failed.media.verified, 0);
  assert.ok(
    (
      await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'retry',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: 1,
      })
    ).ok,
  );
  const recovered = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(recovered.ok);
  assert.equal(recovered.outcome, 'checked');
  assert.equal(recovered.media.retry, 0);
  assert.equal(recovered.media.verified, 1);
});

async function sharedProduct(f: Awaited<ReturnType<typeof fixture>>) {
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.products.push({
    _id: 'second',
    name: 'Second clock',
    published: false,
    productFamily: 'misc',
    imageIds: [f.images[0]?._id],
  });
  writeFileSync(f.file, JSON.stringify(rows));
  const started = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'second',
  });
  assert.ok(started.ok && 'progress' in started);
  const call = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: started.progress.jobId,
  });
  assert.ok(call.ok && 'call' in call);
  return { call: call.call, jobId: started.progress.jobId };
}
test('another product reuses protected pixel evidence with zero object reads, copies or shared cache writes', async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok, true);
  const first = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    first.catalogImageObservations.filter(
      (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
    ).length,
    1,
  );
  const shared = await sharedProduct(f);
  f.storage.getObjectAsBase64 = async () => {
    throw Error('cached protected pixels must not read object');
  };
  f.storage.putObject = async () => {
    throw Error('cached target must not copy');
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'checked');
  assert.equal(result.media.verified, 1);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    rows.catalogImageObservations.filter(
      (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
    ).length,
    1,
  );
  assert.deepEqual(
    rows.catalogImageObservations.find(
      (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
    ),
    first.catalogImageObservations.find(
      (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
    ),
  );
  assert.ok(rows.products.every((p: { published: boolean }) => p.published === false));
});
test('old pixel policy rereads the same protected object and replaces the stale receipt without another PUT', async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok, true);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  const cached = rows.catalogImageObservations.find(
    (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
  );
  assert.ok(cached);
  cached.policyVersion = 'old';
  writeFileSync(f.file, JSON.stringify(rows));
  const shared = await sharedProduct(f);
  let reads = 0;
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    reads++;
    return read(...args);
  };
  f.storage.putObject = async () => {
    throw Error('policy change must not recopy immutable bytes');
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.media.verified, 1);
  assert.equal(reads, 1);
  const current = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.notEqual(
    current.catalogImageObservations.find(
      (r: { kind: string }) => r.kind === 'catalog-protected-image-health-v1',
    ).policyVersion,
    'old',
  );
  assert.equal(current.images[0].storageFileId, rows.images[0].storageFileId);
});

test('editing a product after a cached pixel read makes the worker stale instead of advancing the old plan', async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok, true);
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (c.action === 'get-protected-image-health') {
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.products.find((p: { _id: string }) => p._id === 'second').name = 'Concurrent edit';
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return r;
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.deepEqual(result, { ok: false, code: 'STALE' });
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    rows.products.find((p: { _id: string }) => p._id === 'second').name,
    'Concurrent edit',
  );
  assert.equal(
    rows.catalogPreparationJobs.find((j: { _id: string }) => j._id === shared.jobId).media.cursor,
    0,
  );
});
test('a transient pixel cache read failure falls back to actual object health without a false retry', async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok, true);
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let fail = true;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    if (c.action === 'get-protected-image-health' && fail) {
      fail = false;
      throw Error('cache transport failed');
    }
    return manage(a, c, n);
  };
  let reads = 0;
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    reads++;
    return read(...args);
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'checked');
  assert.equal(result.media.verified, 1);
  assert.equal(reads, 1);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
});

async function unboundSourceWorkspace(t: { after(fn: () => void): void }, count = 1) {
  const f = await sourceWorkspace(t, count);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.catalogSourceLinks = [];
  rows.images = [];
  writeFileSync(f.file, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(f.file);
  setAdapter(adapter);
  const dispatch = async () => {
    const r = await adapter.manageCatalogPreparationJob(f.authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: f.jobId,
    });
    assert.ok(r.ok && 'call' in r);
    return r.call;
  };
  return { ...f, adapter, dispatch };
}
test('actual source fetch/copy binds every adopted URL before the pixel plan and survives reopen', async (t) => {
  const f = await unboundSourceWorkspace(t, 5);
  const before = await f.adapter.get('products', f.productId);
  const fetched: string[] = [];
  const source = (
    sourceUrl: string,
    persistImport: NonNullable<
      NonNullable<Parameters<typeof importCandidateImage>[1]>['persistImport']
    >,
  ) =>
    importCandidateImage(sourceUrl, {
      persistImport,
      resolveDns: async () => ['104.16.1.1'],
      fetchImpl: async (input) => {
        fetched.push(String(input));
        return new Response(new Uint8Array(bytes));
      },
    });
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: source,
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'partial');
  assert.equal(fetched.length, 4);
  let rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogSourceLinks.filter((l: { imageId?: string }) => l.imageId).length, 4);
  assert.equal(
    rows.catalogPreparationJobs.find((j: { _id: string }) => j._id === f.jobId).media,
    null,
  );
  const reopened = new JsonFileAdapter(f.file);
  setAdapter(reopened);
  const second = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: source,
  });
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.outcome, 'checked');
  assert.equal(fetched.length, 5);
  assert.deepEqual(second.media, { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 });
  rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.images.filter((i: { status: string }) => i.status === 'active').length, 1);
  assert.deepEqual(await reopened.get('products', f.productId), before);
});
test('source producer failure cannot bind an incomplete image plan or report checked', async (t) => {
  const f = await unboundSourceWorkspace(t);
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: (url, persistImport) =>
      importCandidateImage(url, {
        persistImport,
        resolveDns: async () => ['104.16.1.1'],
        fetchImpl: async () => new Response('', { status: 503 }),
      }),
  });
  assert.ok(result.ok);
  assert.equal(result.outcome, 'retryable');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    rows.catalogPreparationJobs.find((j: { _id: string }) => j._id === f.jobId).media,
    null,
  );
  assert.equal(rows.products[0].published, false);
});

async function cancelPreparation(f: Awaited<ReturnType<typeof unboundSourceWorkspace>>) {
  const current = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'get',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(current.ok && 'progress' in current);
  return f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'cancel',
    actorId: 'admin',
    jobId: f.jobId,
    expectedLeaseVersion: current.progress.leaseVersion,
  });
}
const sourceOptions = (
  fetchImpl: typeof fetch = async () => new Response(new Uint8Array(bytes)),
) => ({
  importSourceImage: (
    url: string,
    persistImport: NonNullable<
      NonNullable<Parameters<typeof importCandidateImage>[1]>['persistImport']
    >,
  ) =>
    importCandidateImage(url, { persistImport, resolveDns: async () => ['104.16.1.1'], fetchImpl }),
});
test('completed source dedup cleanup failure recovers its exact adopted URL before pixels in the same worker', async (t) => {
  const f = await unboundSourceWorkspace(t, 2);
  f.adapter.releaseImageMutation = async () => {
    throw Error('release unavailable');
  };
  let fetches = 0;
  let injected = false;
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: async (url, persistImport) => {
      const imported = await importCandidateImage(url, {
        persistImport,
        resolveDns: async () => ['104.16.1.1'],
        fetchImpl: async () => {
          fetches++;
          return new Response(new Uint8Array(bytes));
        },
      });
      if (imported.ok && url === f.url(1) && !injected) {
        injected = true;
        const link = await f.adapter.get('catalogSourceLinks', sourceMediaLinkId('alibaba', url));
        const receipt = link?.mediaImportReceipt;
        assert.ok(receipt && typeof receipt === 'object');
        assert.equal(
          await f.adapter.acquireImageMutation(
            imported.imageId,
            String(Reflect.get(receipt, 'operationId')),
            new Date().toISOString(),
          ),
          'acquired',
        );
      }
      return imported;
    },
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'checked');
  assert.equal(result.media.verified, 1);
  assert.equal(fetches, 2);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.images.length, 1);
  assert.equal(rows.images[0].imageMutationOwner, '');
  assert.equal(rows.products[0].published, false);
});
test('source phase cancellation before claim never fetches or writes an image', async (t) => {
  const f = await unboundSourceWorkspace(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let canceled = false;
  f.adapter.manageCatalogPreparationJob = async (authority, command, now) => {
    if (command.action === 'manage-source-media' && !canceled) {
      canceled = true;
      assert.ok((await cancelPreparation(f)).ok);
    }
    return manage(authority, command, now);
  };
  let fetches = 0;
  const result = await runCatalogPreparationWorker(
    f.authority,
    await f.dispatch(),
    sourceOptions(async () => {
      fetches++;
      return new Response(new Uint8Array(bytes));
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(fetches, 0);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.images.length, 0);
  assert.equal(rows.catalogSourceLinks.length, 0);
  assert.equal(rows.products[0].published, false);
});
test('source cancellation after bytes retains tracked pending target and cannot activate or publish', async (t) => {
  const f = await unboundSourceWorkspace(t);
  const put = f.storage.putObject.bind(f.storage);
  let written = false;
  f.storage.putObject = async (input, options) => {
    const stored = await put(input, options);
    written = true;
    assert.ok((await cancelPreparation(f)).ok);
    return stored;
  };
  const result = await runCatalogPreparationWorker(
    f.authority,
    await f.dispatch(),
    sourceOptions(),
  );
  assert.equal(result.ok, false);
  assert.ok(written);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.images.length, 1);
  assert.equal(rows.images[0].status, 'pending');
  assert.equal(typeof rows.images[0].storageFileId, 'string');
  assert.equal(rows.catalogSourceLinks[0].imageId, undefined);
  assert.equal(rows.products[0].published, false);
});
test('lost scoped source activation ACK does not fetch or put twice and continues actual pixels', async (t) => {
  const f = await unboundSourceWorkspace(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (authority, command, now) => {
    const result = await manage(authority, command, now);
    if (
      command.action === 'manage-source-media' &&
      command.command.action === 'activate' &&
      !lost
    ) {
      lost = true;
      throw Error('committed activation ACK lost');
    }
    return result;
  };
  let fetches = 0;
  const result = await runCatalogPreparationWorker(
    f.authority,
    await f.dispatch(),
    sourceOptions(async () => {
      fetches++;
      return new Response(new Uint8Array(bytes));
    }),
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'checked');
  assert.ok(lost);
  assert.equal(fetches, 1);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).images.length, 1);
});
test('a permanent source failure is blocked with edit fallback and never repeatedly downloaded', async (t) => {
  const f = await unboundSourceWorkspace(t);
  let fetches = 0;
  const opts = sourceOptions(async () => {
    fetches++;
    return new Response('', { status: 404 });
  });
  for (let i = 0; i < 2; i++) {
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatch(), opts);
    assert.ok(result.ok);
    assert.equal(result.outcome, 'blocked');
    assert.ok(result.issues.some((issue) => issue.remedy === 'edit'));
  }
  assert.equal(fetches, 1);
});
test('source work respects the existing step budget before starting any fetch', async (t) => {
  const f = await unboundSourceWorkspace(t);
  let clock = 0;
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    ...sourceOptions(async () => {
      throw Error('over-budget fetch');
    }),
    now: () => {
      clock += 13000;
      return clock;
    },
  });
  assert.ok(result.ok);
  assert.equal(result.outcome, 'partial');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.images.length, 0);
  assert.equal(
    rows.catalogPreparationJobs.find((j: { _id: string }) => j._id === f.jobId).media,
    null,
  );
});

test('source phase product edit during download refuses the old checkpoint and preserves the new edit', async (t) => {
  const f = await unboundSourceWorkspace(t);
  let edited = false;
  const result = await runCatalogPreparationWorker(
    f.authority,
    await f.dispatch(),
    sourceOptions(async () => {
      edited = true;
      await f.adapter.update('products', f.productId, { name: 'Concurrent admin edit' });
      return new Response(new Uint8Array(bytes));
    }),
  );
  assert.ok(edited);
  assert.equal(result.ok, false);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.products[0].name, 'Concurrent admin edit');
  assert.equal(rows.products[0].published, false);
  assert.equal(rows.images.length, 1);
  assert.equal(rows.images[0].status, 'pending');
  assert.equal(rows.images[0].storageFileId, undefined);
  assert.equal(rows.catalogSourceLinks[0].imageId, undefined);
});

test('source callback rejects a different URL and retirement before any source writes', async (t) => {
  for (const action of ['claim', 'retire'] as const) {
    const f = await unboundSourceWorkspace(t);
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
      importSourceImage: async (_url, persist) => {
        await persist(
          action === 'retire'
            ? { action, imageId: 'unowned', owner: 'unowned', now: new Date().toISOString() }
            : {
                action,
                imageId: 'unowned',
                operationId: 'unowned',
                sourceUrl: 'https://sc04.alicdn.com/unselected.png',
                now: new Date().toISOString(),
              },
        );
        return { ok: true };
      },
    });
    assert.deepEqual(result, { ok: false, code: 'UNAVAILABLE' });
    const rows = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(rows.images.length, 0);
    assert.equal(rows.catalogSourceLinks.length, 0);
    assert.equal(rows.products[0].published, false);
  }
});

async function sealScope(
  adapter: JsonFileAdapter,
  authority: ReturnType<typeof createCatalogPreparationAuthority>,
  jobId: string,
) {
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command);
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'seal-worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId, lease: c.lease };
  const job = readCatalogPreparationJob(
    await adapter.get('catalogPreparationJobs', jobId),
    jobId,
    Date.now(),
  );
  assert.ok(job?.media);
  const planDigest = job.media.planDigest;
  const bind = await run({ action: 'bind-media-seal', ...scope, planDigest });
  assert.ok(bind.ok && 'mediaSeal' in bind, JSON.stringify(bind));
  return {
    run,
    scope,
    planDigest,
    bind,
    attest: (index: number, imageId: string) =>
      run({ action: 'attest-media-image', ...scope, planDigest, index, imageId }),
  };
}
test('actual protected media attestation resumes after database reopen without object IO or product mutation', async (t) => {
  const f = await fixture(t, 3);
  const product = await f.adapter.get('products', 'p');
  assert.ok((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok);
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const one = await seal.attest(0, f.images[0]?._id ?? '');
  assert.ok(one.ok && 'mediaSeal' in one);
  assert.equal(one.mediaSeal.cursor, 1);
  assert.deepEqual(await seal.attest(0, f.images[0]?._id ?? ''), one);
  assert.ok((await seal.run({ action: 'release', ...seal.scope })).ok);
  const adapter = new JsonFileAdapter(f.file);
  setAdapter(adapter);
  f.storage.getObjectAsBase64 = async () => {
    throw Error('attestation must reuse current protected pixels');
  };
  f.storage.putObject = async () => {
    throw Error('attestation must not PUT');
  };
  const fresh = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
  });
  const next = await sealScope(adapter, fresh, f.jobId);
  assert.equal(next.bind.mediaSeal.cursor, 1);
  for (let i = 1; i < 3; i++) assert.ok((await next.attest(i, f.images[i]?._id ?? '')).ok);
  const job = readCatalogPreparationJob(
    await adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.equal(job?.mediaSeal?.cursor, 3);
  assert.equal(
    job.mediaSeal.imageIdsDigest,
    catalogSealedImageIdsDigest(f.images.map((i) => i._id)),
  );
  assert.deepEqual(await adapter.get('products', 'p'), product);
});
for (const fault of [
  'hold',
  'pixels',
  'intent',
  'target',
  'lock',
  'pixel-policy',
  'cancel',
  'edit',
] as const)
  test(`final media attestation rejects ${fault} after the initial cursor was checked`, async (t) => {
    const f = await fixture(t, 1);
    await runCatalogPreparationWorker(f.authority, await f.dispatch());
    const seal = await sealScope(f.adapter, f.authority, f.jobId);
    const rows = JSON.parse(readFileSync(f.file, 'utf8'));
    if (fault === 'hold')
      rows.catalogImageObservations = rows.catalogImageObservations.filter(
        (r: { kind: string }) => r.kind !== 'catalog-preparation-image-hold-v1',
      );
    if (fault === 'pixels')
      rows.catalogImageObservations = rows.catalogImageObservations.filter(
        (r: { kind: string }) => r.kind !== 'catalog-protected-image-health-v1',
      );
    if (fault === 'intent')
      rows.catalogImageObservations = rows.catalogImageObservations.filter(
        (r: { kind: string }) => r.kind !== 'catalog-image-protection-intent-v1',
      );
    if (fault === 'target') rows.images[0].storageFileId = 'other';
    if (fault === 'lock')
      Object.assign(rows.images[0], {
        imageMutationOwner: 'deleter',
        imageMutationStartedAt: new Date().toISOString(),
      });
    if (fault === 'pixel-policy')
      rows.catalogPreparationJobs[0].mediaSeal.pixelPolicyVersion = 'old-pixels';
    if (fault === 'edit') rows.products[0].name = 'New name';
    writeFileSync(f.file, JSON.stringify(rows));
    if (fault === 'cancel')
      assert.ok(
        (
          await seal.run({
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: 2,
          })
        ).ok,
      );
    const result = await seal.attest(0, f.images[0]?._id ?? '');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((await f.adapter.get('products', 'p'))?.published, false);
    assert.equal((await f.adapter.get('products', 'p'))?.catalogPreparationState, undefined);
  });
test('shared image counter/name edits survive attestation and do not force bytes or shared writes', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  Object.assign(rows.images[0], { name: 'Other editor name', publishedRefCount: 7 });
  writeFileSync(f.file, JSON.stringify(rows));
  const before = structuredClone(rows.images);
  assert.ok((await seal.attest(0, f.images[0]?._id ?? '')).ok);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).images, before);
});

test('105 adopted configuration images are all checked and attested across independent bounded commands', async (t) => {
  const f = await sourceWorkspace(t, 105);
  const before = await f.adapter.get('products', f.productId);
  let complete = false;
  let steps = 0;
  for (; steps < 27; steps++) {
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.ok(result.ok, JSON.stringify(result));
    if (result.outcome === 'checked') {
      complete = true;
      steps++;
      break;
    }
  }
  assert.equal(complete, true);
  assert.equal(steps, 27);
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  for (const [index, image] of f.images.entries()) {
    const r = await seal.attest(index, image._id);
    assert.ok(r.ok && 'mediaSeal' in r, JSON.stringify(r));
    assert.equal(r.mediaSeal.cursor, index + 1);
  }
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.equal(job?.mediaSeal?.cursor, 105);
  assert.equal(
    job.mediaSeal.imageIdsDigest,
    catalogSealedImageIdsDigest(f.images.map((i) => i._id)),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(job.mediaSeal)) < 1024);
  assert.deepEqual(await f.adapter.get('products', f.productId), before);
});

test('an attestation ACK lost after commit replays the same proof without another mutation', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'attest-media-image' && !lost) {
      lost = true;
      throw Error('response lost after file commit');
    }
    return result;
  };
  await assert.rejects(seal.attest(0, f.images[0]?._id ?? ''), /response lost/);
  const committed = readFileSync(f.file, 'utf8');
  const result = await seal.attest(0, f.images[0]?._id ?? '');
  assert.ok(result.ok && 'mediaSeal' in result);
  assert.equal(result.mediaSeal.cursor, 1);
  assert.equal(readFileSync(f.file, 'utf8'), committed);
});
test('older pixel-policy attestation can be cancelled and explicitly retried instead of corrupting the job', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.catalogPreparationJobs[0].mediaSeal.pixelPolicyVersion = 'old-pixels';
  writeFileSync(f.file, JSON.stringify(rows));
  assert.equal((await seal.attest(0, f.images[0]?._id ?? '')).ok, false);
  assert.ok(
    (
      await seal.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: 2,
      })
    ).ok,
  );
  assert.ok(
    (await seal.run({ action: 'retry', actorId: 'admin', jobId: f.jobId, expectedLeaseVersion: 2 }))
      .ok,
  );
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.equal(job?.mediaSeal, null);
  assert.equal(job?.media, null);
});
