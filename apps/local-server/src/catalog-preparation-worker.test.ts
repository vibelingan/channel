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
import { sourceDigest } from '@vibelingan-channel/db/catalog-source-staging';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import { inspectCatalogPreparationJob } from '../../functions/admin/src/catalog-preparation-job-inspect.ts';
import {
  runCatalogPreparationMediaWorker,
  runCatalogPreparationWorker,
} from '../../functions/admin/src/catalog-preparation-worker.ts';
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
  const first = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  const second = await runCatalogPreparationMediaWorker(fresh, await f.dispatch(reopened, fresh));
  assert.ok(second.ok);
  assert.equal(second.media?.checked, 8);
  const third = await runCatalogPreparationMediaWorker(fresh, await f.dispatch(reopened, fresh));
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
    assert.deepEqual(await runCatalogPreparationMediaWorker(f.authority, bad), {
      ok: false,
      code: 'FORBIDDEN',
    });
    assert.equal(calls, 0);
  });
test('cancel during default native image check fences the observation and keeps product unpublished', async (t) => {
  const f = await fixture(t, 2);
  let checks = 0;
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
    await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), { checkImage }),
    { ok: false, code: 'UNAVAILABLE' },
  );
  const next = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
    checkImage,
  });
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
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  assert.deepEqual(await runCatalogPreparationMediaWorker(f.authority, call), {
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
  assert.deepEqual(await runCatalogPreparationMediaWorker(f.authority, call), {
    ok: false,
    code: 'UNAVAILABLE',
  });
  const job = JSON.parse(readFileSync(f.file, 'utf8')).catalogPreparationJobs[0];
  assert.equal(job.state, 'running');
  assert.equal(job.media.cursor, 1);
});
test('product edit during a check marks the old job stale and cannot publish old data', async (t) => {
  const f = await fixture(t, 2);
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
      result.kind === 'catalog-preparation-step' &&
      'media' in result &&
      result.media &&
      typeof result.media === 'object' &&
      'checked' in result.media,
  );
  assert.equal(result.media.checked, 1);
  assert.ok('outcome' in result && result.outcome === 'ready');
  const product = await f.adapter.get('products', 'p');
  assert.ok(product);
  assert.equal(readCurrentCatalogPreparation(product)?.state, 'ready');
  assert.equal((await f.adapter.get('catalogPreparationJobs', f.jobId))?.state, 'completed');
  assert.equal(product.published, false);
});

test('zero-image candidate performs no pixel checks and remains unsealed', async (t) => {
  const f = await fixture(t, 0);
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const r = await runCatalogPreparationMediaWorker(f.authority, call);
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
  assert.deepEqual(await runCatalogPreparationMediaWorker(f.authority, call), {
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
  const r = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  const failed = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const recovered = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  assert.equal((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok, true);
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
  const result = await runCatalogPreparationMediaWorker(f.authority, shared.call);
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
  assert.equal((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok, true);
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
  const result = await runCatalogPreparationMediaWorker(f.authority, shared.call);
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
  assert.equal((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok, true);
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
  const result = await runCatalogPreparationMediaWorker(f.authority, shared.call);
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
  assert.equal((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok, true);
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
  const result = await runCatalogPreparationMediaWorker(f.authority, shared.call);
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
  const first = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const second = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const result = await runCatalogPreparationMediaWorker(
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
  const result = await runCatalogPreparationMediaWorker(
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
  const result = await runCatalogPreparationMediaWorker(
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
    const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), opts);
    assert.ok(result.ok);
    assert.equal(result.outcome, 'blocked');
    assert.ok(result.issues.some((issue) => issue.remedy === 'edit'));
  }
  assert.equal(fetches, 1);
});
test('source work respects the existing step budget before starting any fetch', async (t) => {
  const f = await unboundSourceWorkspace(t);
  let clock = 0;
  const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  const result = await runCatalogPreparationMediaWorker(
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
    const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch(), {
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
  assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
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
    await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
    const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  const finish = await seal.run(await currentFinishCommand(f.authority, seal.scope));
  assert.ok(finish.ok && 'report' in finish, JSON.stringify(finish));
  const product = await f.adapter.get('products', f.productId);
  assert.ok(product);
  const report = readCurrentCatalogPreparation(product);
  assert.ok(report?.state === 'ready');
  assert.equal(report.seal.imageCount, 105);
  assert.equal(product.published, false);
});

test('an attestation ACK lost after commit replays the same proof without another mutation', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
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

async function currentFinishCommand(
  authority: ReturnType<typeof createCatalogPreparationAuthority>,
  scope: { jobId: string; lease: object },
) {
  const c = await inspectCatalogPreparationJob(authority, scope.jobId, scope.lease, {
    mediaMode: 'defer',
  });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.previewReady, true);
  assert.ok(!c.issues.some((i) => i.severity === 'error'));
  return {
    action: 'finish-preparation' as const,
    ...scope,
    inputDigest: c.inputDigest,
    contentGeneration: c.contentGeneration,
    planDigest: sourceDigest([
      CATALOG_PREPARATION_POLICY,
      c.inputDigest,
      c.contentGeneration,
      c.imageIds,
    ]),
    imageIdsDigest: catalogSealedImageIdsDigest(c.imageIds),
    imageCount: c.imageIds.length,
    previewReady: true as const,
    issues: c.issues,
  };
}
test('real three-photo preparation finishes current ready, retains missing category and survives reopen', async (t) => {
  const f = await fixture(t, 3, true);
  const before = await f.adapter.get('products', 'p');
  assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  for (const [i, image] of f.images.entries()) assert.ok((await seal.attest(i, image._id)).ok);
  f.storage.getObjectAsBase64 = async () => {
    throw Error('finish must not fetch bytes');
  };
  f.storage.putObject = async () => {
    throw Error('finish must not copy bytes');
  };
  const command = await currentFinishCommand(f.authority, seal.scope);
  const result = await seal.run(command);
  assert.ok(result.ok && 'report' in result, JSON.stringify(result));
  const adapter = new JsonFileAdapter(f.file);
  const product = await adapter.get('products', 'p');
  assert.ok(product);
  const report = readCurrentCatalogPreparation(product);
  assert.ok(report?.state === 'ready');
  assert.equal(report.seal.imageCount, 3);
  assert.equal(Object.hasOwn(product, 'productFamily'), false);
  assert.equal(product.published, false);
  assert.deepEqual(product, {
    ...before,
    catalogPreparationState: 'ready',
    catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
    catalogPreparationReport: report,
  });
  assert.equal((await adapter.get('catalogPreparationJobs', f.jobId))?.state, 'completed');
  const bytes = readFileSync(f.file, 'utf8');
  assert.ok((await seal.run(command)).ok);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
});
test('ready response lost after actual file commit recovers without duplicate writes', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  assert.ok((await seal.attest(0, f.images[0]?._id ?? '')).ok);
  const command = await currentFinishCommand(f.authority, seal.scope);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'finish-preparation' && !lost) {
      lost = true;
      throw Error('final ACK lost');
    }
    return r;
  };
  await assert.rejects(seal.run(command), /ACK lost/);
  const bytes = readFileSync(f.file, 'utf8');
  const r = await seal.run(command);
  assert.ok(r.ok && 'preparation' in r);
  assert.equal(r.preparation, 'unchanged');
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
});

test('default signed worker automatically seals and commits a current ready report', async (t) => {
  const f = await fixture(t, 3, true);
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'ready');
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  const report = readCurrentCatalogPreparation(p);
  assert.ok(report?.state === 'ready');
  assert.equal(report.seal.imageCount, 3);
  assert.equal(p.published, false);
  assert.equal(Object.hasOwn(p, 'productFamily'), false);
});

test('default worker seals at most four images per invocation and resumes across a new database and authority', async (t) => {
  const f = await fixture(t, 9);
  let lastSealed = 0;
  let reads = 0;
  const get = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    reads++;
    return get(...args);
  };
  let authority = f.authority;
  let adapter = f.adapter;
  let result: Awaited<ReturnType<typeof runCatalogPreparationWorker>> | undefined;
  const checked: number[] = [];
  const sealed: number[] = [];
  for (let n = 0; n < 5; n++) {
    const d = await adapter.manageCatalogPreparationJob(authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: f.jobId,
    });
    assert.ok(d.ok && 'call' in d);
    const r = await runCatalogPreparationWorker(authority, d.call);
    assert.ok(r.ok, JSON.stringify(r));
    result = r;
    checked.push(r.media.checked);
    const job = readCatalogPreparationJob(
      await adapter.get('catalogPreparationJobs', f.jobId),
      f.jobId,
      Date.now(),
    );
    assert.ok(job);
    const cursor = job.mediaSeal?.cursor ?? 0;
    assert.ok(cursor - lastSealed <= 4);
    sealed.push(cursor);
    lastSealed = cursor;
    if (n === 2) {
      const pixelsReads = reads;
      adapter = new JsonFileAdapter(f.file);
      setAdapter(adapter);
      authority = createCatalogPreparationAuthority({
        secret: 'worker-local-test',
        environmentId: 'local-worker-env',
      });
      f.storage.getObjectAsBase64 = async () => {
        assert.equal(reads, pixelsReads);
        throw Error('sealed stage must not read bytes');
      };
      f.storage.putObject = async () => {
        throw Error('sealed stage must not PUT');
      };
    }
  }
  assert.deepEqual(checked, [4, 8, 9, 9, 9]);
  assert.deepEqual(sealed, [0, 0, 4, 8, 9]);
  assert.ok(result?.ok);
  assert.equal(result.outcome, 'ready');
  const p = await adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'ready');
  assert.equal(p.published, false);
});
test('default worker metadata budget leaves an exact durable prefix and later finishes without object IO', async (t) => {
  const f = await fixture(t, 3);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let clock = Date.now();
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'attest-media-image') clock += 20000;
    return r;
  };
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    now: () => clock,
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'partial');
  assert.equal(first.attestation?.checked, 1);
  assert.equal((await f.adapter.get('products', 'p'))?.catalogPreparationState, undefined);
  f.adapter.manageCatalogPreparationJob = manage;
  f.storage.getObjectAsBase64 = async () => {
    throw Error('no repeated bytes');
  };
  f.storage.putObject = async () => {
    throw Error('no repeated copy');
  };
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.outcome, 'ready');
  assert.equal(next.attestation?.checked, 3);
});
test('default worker resumes a committed attestation whose response was lost without decoding again', async (t) => {
  const f = await fixture(t, 3);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'attest-media-image' && !lost) {
      lost = true;
      throw Error('attestation ACK lost');
    }
    return r;
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, await f.dispatch()), {
    ok: false,
    code: 'UNAVAILABLE',
  });
  f.storage.getObjectAsBase64 = async () => {
    throw Error('resume must use checked pixels');
  };
  f.storage.putObject = async () => {
    throw Error('resume must use existing target');
  };
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.outcome, 'ready');
  assert.equal(next.attestation?.checked, 3);
});
test('default worker confirms a lost final ACK using the original grant and never releases a completed job', async (t) => {
  const f = await fixture(t, 1);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let finishes = 0;
  let releases = 0;
  let committed = '';
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'release') releases++;
    if (args[1].action === 'finish-preparation') {
      finishes++;
      if (finishes === 1) {
        committed = readFileSync(f.file, 'utf8');
        throw Error('ready ACK lost');
      }
    }
    return r;
  };
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'ready');
  assert.equal(finishes, 2);
  assert.equal(releases, 0);
  assert.equal(readFileSync(f.file, 'utf8'), committed);
});
for (const phase of [
  'before-attest',
  'after-attest',
  'before-finish',
  'edit-before-finish',
] as const)
  test(`default worker ${phase} cannot race cancellation or edit into ready`, async (t) => {
    const f = await fixture(t, 1);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let injected = false;
    async function change() {
      if (injected) return;
      injected = true;
      if (phase === 'edit-before-finish') {
        await f.adapter.update('products', 'p', { name: 'User edited' });
        return;
      }
      const job = readCatalogPreparationJob(
        await f.adapter.get('catalogPreparationJobs', f.jobId),
        f.jobId,
        Date.now(),
      );
      assert.ok(job);
      assert.ok(
        (
          await manage(f.authority, {
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: job.leaseVersion,
          })
        ).ok,
      );
    }
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      if (
        (phase === 'before-attest' && args[1].action === 'attest-media-image') ||
        ((phase === 'before-finish' || phase === 'edit-before-finish') &&
          args[1].action === 'finish-preparation')
      )
        await change();
      const r = await manage(...args);
      if (phase === 'after-attest' && args[1].action === 'attest-media-image') await change();
      return r;
    };
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(injected, true);
    const p = await f.adapter.get('products', 'p');
    assert.ok(p);
    assert.equal(readCurrentCatalogPreparation(p), null);
    assert.equal(p.published, false);
    if (phase === 'edit-before-finish') assert.equal(p.name, 'User edited');
  });
test('full candidate reread catches adopted source binding changes after attestation and explicit retry recovers', async (t) => {
  const f = await sourceWorkspace(t, 2);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let changed = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'attest-media-image' && args[1].index === 1 && !changed) {
      changed = true;
      const data = JSON.parse(readFileSync(f.file, 'utf8'));
      data.catalogSourceLinks[0].imageId = f.images[1]?._id;
      writeFileSync(f.file, JSON.stringify(data));
    }
    return r;
  };
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.deepEqual(result, { ok: false, code: 'CONFLICT' });
  assert.equal(changed, true);
  const p = await f.adapter.get('products', f.productId);
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p), null);
  assert.equal(p.published, false);
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.ok(job);
  assert.ok(
    (
      await manage(f.authority, {
        action: 'retry',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: job.leaseVersion,
      })
    ).ok,
  );
  const recovered = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.outcome, 'ready');
  assert.equal(recovered.media.total, 1);
});
test('default worker checks and seals all 105 independent configuration photos without changing publication or classification', async (t) => {
  const f = await sourceWorkspace(t, 105);
  const before = await f.adapter.get('products', f.productId);
  let complete = false;
  let steps = 0;
  let previous = 0;
  for (; steps < 54; steps++) {
    const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.ok(r.ok, JSON.stringify(r));
    const job = readCatalogPreparationJob(
      await f.adapter.get('catalogPreparationJobs', f.jobId),
      f.jobId,
      Date.now(),
    );
    assert.ok(job);
    const sealed = job.mediaSeal?.cursor ?? 0;
    assert.ok(sealed - previous <= 4);
    previous = sealed;
    if (r.media.checked === 105) {
      f.storage.getObjectAsBase64 = async () => {
        throw Error('attestation reuses protected bytes');
      };
      f.storage.putObject = async () => {
        throw Error('attestation must not copy');
      };
    }
    if (r.outcome === 'ready') {
      complete = true;
      steps++;
      break;
    }
  }
  assert.equal(complete, true);
  assert.equal(steps, 53);
  const p = await f.adapter.get('products', f.productId);
  assert.ok(p);
  const report = readCurrentCatalogPreparation(p);
  assert.ok(report?.state === 'ready');
  assert.equal(report.seal.imageCount, 105);
  assert.deepEqual(p, {
    ...before,
    catalogPreparationState: 'ready',
    catalogPreparationPolicy: CATALOG_PREPARATION_POLICY,
    catalogPreparationReport: report,
  });
});
test('default worker zero-image preview can finish without a pixel check while an unprotected injected check cannot grant ready', async (t) => {
  const zero = await fixture(t, 0);
  const result = await runCatalogPreparationWorker(zero.authority, await zero.dispatch(), {
    checkImage: async () => {
      throw Error('zero must not decode');
    },
  });
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  const f = await fixture(t, 1);
  const unprotected = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: readStoredCatalogImageHealth,
  });
  assert.deepEqual(unprotected, { ok: false, code: 'CONFLICT' });
  assert.equal((await f.adapter.get('products', 'p'))?.catalogPreparationState, undefined);
});

test('duplicate signed default call after database and authority restart reads current ready without writes or IO', async (t) => {
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  const first = await runCatalogPreparationWorker(f.authority, call);
  assert.ok(first.ok && first.outcome === 'ready');
  const saved = readFileSync(f.file, 'utf8');
  const adapter = new JsonFileAdapter(f.file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
  });
  f.storage.getObjectAsBase64 = async () => {
    throw Error('completed call must not read objects');
  };
  f.storage.putObject = async () => {
    throw Error('completed call must not copy');
  };
  const result = await runCatalogPreparationWorker(authority, call, {
    checkImage: async () => {
      throw Error('completed call must not check');
    },
  });
  assert.deepEqual(result, first);
  assert.equal(readFileSync(f.file, 'utf8'), saved);
});

test('completed default retry preserves later lifecycle changes and refuses later user content edits', async (t) => {
  const f = await fixture(t, 1);
  const call = await f.dispatch();
  assert.ok((await runCatalogPreparationWorker(f.authority, call)).ok);
  await f.adapter.update('products', 'p', { archived: true, subcategoryIds: ['latest'] });
  const before = readFileSync(f.file, 'utf8');
  const replay = await runCatalogPreparationWorker(f.authority, call);
  assert.ok(replay.ok && replay.outcome === 'ready');
  assert.equal(readFileSync(f.file, 'utf8'), before);
  await f.adapter.update('products', 'p', { name: 'User edited after ready' });
  const edited = readFileSync(f.file, 'utf8');
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, call), {
    ok: false,
    code: 'STALE',
  });
  assert.equal(readFileSync(f.file, 'utf8'), edited);
  assert.equal((await f.adapter.get('products', 'p'))?.name, 'User edited after ready');
});

test('nonready repository checkpoint persists readable diagnostics after real image checking and file reopen', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const before = await f.adapter.get('products', 'p');
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  f.storage.getObjectAsBase64 = async () => {
    throw Error('checkpoint must not read pixels');
  };
  f.storage.putObject = async () => {
    throw Error('checkpoint must not copy');
  };
  const r = await seal.run({
    action: 'checkpoint-preparation',
    ...seal.scope,
    previewReady: false,
    issues: [
      {
        code: 'INVALID_VALUE',
        stage: 'effective-content',
        path: 'name',
        severity: 'error',
        remedy: 'edit',
      },
    ],
  });
  assert.ok(r.ok && 'report' in r, JSON.stringify(r));
  assert.equal(r.report.state, 'blocked');
  const adapter = new JsonFileAdapter(f.file);
  const p = await adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'blocked');
  assert.deepEqual(p, {
    ...before,
    catalogPreparationState: 'blocked',
    catalogPreparationPolicy: r.report.policyVersion,
    catalogPreparationReport: r.report,
  });
  assert.equal(p.published, false);
});
test('actual checkpoint disk persistence failure leaves the product and same-job fence unchanged', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const before = readFileSync(f.file, 'utf8');
  const persist = Reflect.get(f.adapter, 'persist');
  Reflect.set(f.adapter, 'persist', () => {
    throw Error('checkpoint disk failure');
  });
  try {
    await assert.rejects(
      seal.run({ action: 'checkpoint-preparation', ...seal.scope, previewReady: true, issues: [] }),
      /disk failure/,
    );
    assert.equal(readFileSync(f.file, 'utf8'), before);
  } finally {
    Reflect.set(f.adapter, 'persist', persist);
  }
});
