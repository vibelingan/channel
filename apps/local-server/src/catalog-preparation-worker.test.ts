import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import {
  readCatalogPreparationJob,
  runCatalogPreparationJob,
} from '@vibelingan-channel/db/catalog-preparation-jobs';
import { catalogSealedImageIdsDigest } from '@vibelingan-channel/db/catalog-preparation-media-seal';
import { sourceDigest } from '@vibelingan-channel/db/catalog-source-staging';
import { runCatalogPreparationCall } from '@vibelingan-channel/fn-alibaba-catalog-sync/catalog-preparation';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import {
  type CollectionDoc,
  productFamilyForDoc,
  validateProductPublication,
} from '@vibelingan-channel/shared';
import {
  CatalogPreparationRequestSchema,
  readCurrentCatalogPreparation,
  readCurrentCatalogPreparationRequest,
} from '@vibelingan-channel/shared/catalog-preparation';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import type { CatalogPreparationInvoker } from '../../functions/admin/src/catalog-preparation-invoker.ts';
import { inspectCatalogPreparationJob } from '../../functions/admin/src/catalog-preparation-job-inspect.ts';
import {
  runCatalogPreparationMediaWorker,
  runCatalogPreparationWorker,
} from '../../functions/admin/src/catalog-preparation-worker.ts';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../functions/admin/src/http-adapter.ts';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { importCandidateImage } from '../../functions/alibaba-catalog-sync/src/media-import.ts';
import { createLocalCatalogPreparationInvoker } from './catalog-preparation-invoker.ts';
import { JsonFileAdapter } from './json-adapter.ts';
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
function isMediaAttestation(command: { action: string }) {
  return command.action === 'attest-media-image' || command.action === 'attest-media-page';
}
async function fixture(
  t: { after(fn: () => void): void },
  count = 9,
  missingCategory = false,
  now?: () => number,
) {
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
          imageIds: images.slice(0, 9).map((i) => i._id),
          ...(count > 9 ? { descriptionImageIds: images.slice(9).map((i) => i._id) } : {}),
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
    ...(now ? { now } : {}),
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

async function sharedProduct(
  f: Awaited<ReturnType<typeof fixture>>,
  imageIds = f.images.slice(0, 1).map((image) => image._id),
  descriptionImageIds: string[] = [],
) {
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.products.push({
    _id: 'second',
    name: 'Second clock',
    published: false,
    productFamily: 'misc',
    imageIds,
    ...(descriptionImageIds.length ? { descriptionImageIds } : {}),
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
  let changed = false;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (
      c.action === 'get-protected-image-health' ||
      (c.action === 'reserve-image-check' && r.ok && 'reservation' in r && r.protectedHealth)
    ) {
      changed = true;
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.products.find((p: { _id: string }) => p._id === 'second').name = 'Concurrent edit';
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return r;
  };
  const result = await runCatalogPreparationMediaWorker(f.authority, shared.call);
  assert.equal(changed, true);
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
test('pixel cache receipt read failures fall back to actual object health without a false retry', async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok, true);
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let optionalFailed = false;
  let receiptFailed = false;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    if (c.action === 'reserve-image-check' && c.includeProtectedHealth && !optionalFailed) {
      optionalFailed = true;
      throw Error('optional cache transport failed');
    }
    if (c.action === 'get-protected-image-health' && !receiptFailed) {
      receiptFailed = true;
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
  assert.equal(optionalFailed, true);
  assert.equal(receiptFailed, true);
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
    const beforeAttestation = await f.adapter.get('products', 'p');
    const result = await seal.attest(0, f.images[0]?._id ?? '');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal((await f.adapter.get('products', 'p'))?.published, false);
    assert.deepEqual(await f.adapter.get('products', 'p'), beforeAttestation);
    assert.equal(
      readCurrentCatalogPreparation((await f.adapter.get('products', 'p')) ?? {})?.state ===
        'ready',
      false,
    );
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
    if (isMediaAttestation(args[1]) && !lost) {
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

test('default worker attests at most16 protected images per invocation and resumes without object IO after database and authority reopen', async (t) => {
  const f = await fixture(t, 27);
  for (let n = 0; n < 7; n++) {
    const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.media.checked, Math.min((n + 1) * 4, 27));
  }
  let authority = f.authority;
  let adapter = f.adapter;
  let lastSealed = 0;
  const sealed: number[] = [];
  f.storage.getObjectAsBase64 = async () => {
    throw Error('attestation must not read bytes');
  };
  f.storage.putObject = async () => {
    throw Error('attestation must not PUT');
  };
  for (let n = 0; n < 2; n++) {
    const d = await adapter.manageCatalogPreparationJob(authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: f.jobId,
    });
    assert.ok(d.ok && 'call' in d);
    const result = await runCatalogPreparationWorker(authority, d.call);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.media.checked, 27);
    assert.equal(result.outcome, n === 0 ? 'partial' : 'ready');
    const job = readCatalogPreparationJob(
      await adapter.get('catalogPreparationJobs', f.jobId),
      f.jobId,
      Date.now(),
    );
    assert.ok(job);
    const cursor = job.mediaSeal?.cursor ?? 0;
    assert.ok(cursor - lastSealed <= 16);
    sealed.push(cursor);
    lastSealed = cursor;
    if (n === 0) {
      adapter = new JsonFileAdapter(f.file);
      setAdapter(adapter);
      authority = createCatalogPreparationAuthority({
        secret: 'worker-local-test',
        environmentId: 'local-worker-env',
      });
    }
  }
  assert.deepEqual(sealed, [16, 27]);
  const product = await adapter.get('products', 'p');
  assert.ok(product);
  assert.equal(readCurrentCatalogPreparation(product)?.state, 'ready');
  assert.equal(product.published, false);
});
test('default worker metadata budget leaves an exact durable page and later finishes without object IO', async (t) => {
  const f = await fixture(t, 3);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let clock = Date.now();
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (isMediaAttestation(args[1])) clock += 20000;
    return r;
  };
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    now: () => clock,
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'partial');
  assert.equal(first.attestation?.checked, 3);
  const preparing = await f.adapter.get('products', 'p');
  assert.ok(preparing);
  assert.equal(readCurrentCatalogPreparation(preparing)?.state, 'preparing');
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
    if (isMediaAttestation(args[1]) && !lost) {
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
        (phase === 'before-attest' && isMediaAttestation(args[1])) ||
        ((phase === 'before-finish' || phase === 'edit-before-finish') &&
          args[1].action === 'finish-preparation')
      )
        await change();
      const r = await manage(...args);
      if (phase === 'after-attest' && isMediaAttestation(args[1])) await change();
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
    if (
      !changed &&
      ((args[1].action === 'attest-media-image' && args[1].index === 1) ||
        (args[1].action === 'attest-media-page' &&
          args[1].from.cursor <= 1 &&
          args[1].from.cursor + args[1].imageIds.length > 1))
    ) {
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
    assert.ok(sealed - previous <= 16);
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
  assert.equal(steps, 33);
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
  const beforeUnprotected = await f.adapter.get('products', 'p');
  const unprotected = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: readStoredCatalogImageHealth,
  });
  assert.deepEqual(unprotected, { ok: false, code: 'CONFLICT' });
  assert.deepEqual(await f.adapter.get('products', 'p'), beforeUnprotected);
  assert.equal(readCurrentCatalogPreparation((await f.adapter.get('products', 'p')) ?? {}), null);
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

test('default partial preparation saves a current preparing report before returning', async (t) => {
  const f = await fixture(t, 9);
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok && r.outcome === 'partial');
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'preparing');
  assert.equal(p.published, false);
});
test('cancel after a diagnostic checkpoint clears current preparation without changing user data', async (t) => {
  const f = await fixture(t, 1);
  await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  assert.ok(
    (
      await seal.run({
        action: 'checkpoint-preparation',
        ...seal.scope,
        previewReady: true,
        issues: [],
      })
    ).ok,
  );
  const before = await f.adapter.get('products', 'p');
  assert.ok(before);
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.ok(job);
  assert.ok(
    (
      await seal.run({
        action: 'cancel',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: job.leaseVersion,
      })
    ).ok,
  );
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p), null);
  assert.deepEqual(p, { ...before, catalogPreparationState: 'stale' });
});

async function currentWorkerCall(
  f: { adapter: JsonFileAdapter; authority: ReturnType<typeof createCatalogPreparationAuthority> },
  productId = 'p',
) {
  const s = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId,
  });
  assert.ok(s.ok && 'progress' in s);
  const d = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: s.progress.jobId,
  });
  assert.ok(d.ok && 'call' in d);
  return { jobId: s.progress.jobId, call: d.call };
}
test('default invalid preview remains diagnosable, then an edit prepares the new version successfully', async (t) => {
  const f = await fixture(t, 1);
  await f.adapter.update('products', 'p', { name: '' });
  const bad = await currentWorkerCall(f);
  const blocked = await runCatalogPreparationWorker(f.authority, bad.call);
  assert.ok(blocked.ok, JSON.stringify(blocked));
  assert.equal(blocked.outcome, 'blocked');
  assert.ok(blocked.issues.some((i) => i.severity === 'error'));
  let p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'blocked');
  assert.equal(p.name, '');
  assert.equal(p.published, false);
  await f.adapter.update('products', 'p', { name: 'Repaired clock' });
  const next = await currentWorkerCall(f);
  assert.notEqual(next.jobId, bad.jobId);
  const fixed = await runCatalogPreparationWorker(f.authority, next.call);
  assert.ok(fixed.ok, JSON.stringify(fixed));
  assert.equal(fixed.outcome, 'ready');
  p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'ready');
  assert.equal(p.name, 'Repaired clock');
  assert.equal(p.published, false);
});
test('default consumed pixel retry stores a remedy and explicit reset reaches ready', async (t) => {
  const f = await fixture(t, 1);
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    checkImage: async () => ({ status: 'retry', reason: 'timeout' }),
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'retryable');
  assert.ok(first.issues.some((i) => i.remedy === 'retry-media'));
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'preparing');
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.ok(job);
  assert.ok(
    (
      await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'retry',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: job.leaseVersion,
      })
    ).ok,
  );
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.outcome, 'ready');
  assert.equal(next.media.retry, 0);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('default source503 stores retry diagnostics and resumes the same queued job without a fabricated media plan', async (t) => {
  const f = await unboundSourceWorkspace(t, 1);
  let failed = true;
  let fetches = 0;
  const importer = (
    url: string,
    persistImport: NonNullable<
      NonNullable<Parameters<typeof importCandidateImage>[1]>['persistImport']
    >,
  ) =>
    importCandidateImage(url, {
      persistImport,
      resolveDns: async () => ['104.16.1.1'],
      fetchImpl: async () => {
        fetches++;
        return failed
          ? new Response('temporary', { status: 503 })
          : new Response(new Uint8Array(bytes));
      },
    });
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: importer,
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'retryable');
  assert.ok(first.issues.some((i) => i.remedy === 'retry-media'));
  const p = await f.adapter.get('products', f.productId);
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'preparing');
  assert.equal((await f.adapter.get('catalogPreparationJobs', f.jobId))?.media, null);
  const before = fetches;
  failed = false;
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: importer,
  });
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.outcome, 'ready');
  assert.equal(fetches, before + 1);
  assert.equal((await f.adapter.get('products', f.productId))?.published, false);
});
test('default permanent source404 stores blocked edit guidance and never repeats its download', async (t) => {
  const f = await unboundSourceWorkspace(t, 1);
  let fetches = 0;
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: (url, persistImport) =>
      importCandidateImage(url, {
        persistImport,
        resolveDns: async () => ['104.16.1.1'],
        fetchImpl: async () => {
          fetches++;
          return new Response('gone', { status: 404 });
        },
      }),
  });
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'blocked');
  assert.ok(first.issues.some((i) => i.severity === 'error' && i.remedy === 'edit'));
  const p = await f.adapter.get('products', f.productId);
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'blocked');
  const before = fetches;
  const next = await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
    importSourceImage: async () => {
      throw Error('permanent source must remain editable instead of downloading again');
    },
  });
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.outcome, 'blocked');
  assert.equal(fetches, before);
  assert.equal((await f.adapter.get('products', f.productId))?.published, false);
});
test('default lost diagnostic ACK retries the same grant and keeps one resumable job without public changes', async (t) => {
  const f = await fixture(t, 5);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let checkpoints = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const r = await manage(...args);
    if (args[1].action === 'checkpoint-preparation' && ++checkpoints === 1)
      throw Error('checkpoint ACK lost');
    return r;
  };
  const first = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.outcome, 'partial');
  assert.equal(checkpoints, 2);
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'preparing');
  assert.equal(p.published, false);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogPreparationJobs.length, 1);
  assert.equal(rows.catalogPreparationJobs[0].media.cursor, 4);
});
test('diagnostic transport failure keeps the checked prefix for a later default continuation', async (t) => {
  const f = await fixture(t, 5);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let attempts = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (args[1].action === 'checkpoint-preparation') {
      attempts++;
      throw Error('checkpoint unavailable');
    }
    return manage(...args);
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, await f.dispatch()), {
    ok: false,
    code: 'UNAVAILABLE',
  });
  assert.equal(attempts, 2);
  const job = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.ok(job);
  assert.equal(job.media?.cursor, 4);
  assert.equal(job.state, 'queued');
  f.adapter.manageCatalogPreparationJob = manage;
  const prefixFiles = new Set<string>();
  for (const image of f.images.slice(0, 4)) {
    prefixFiles.add(image.storageFileId);
    const current = await f.adapter.get('images', image._id);
    assert.equal(typeof current?.storageFileId, 'string');
    if (typeof current?.storageFileId === 'string') prefixFiles.add(current.storageFileId);
  }
  const get = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    assert.equal(prefixFiles.has(args[0]), false, 'Checked prefix must not be downloaded again');
    return get(...args);
  };
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(result.ok);
  assert.equal(result.outcome, 'ready');
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
for (const phase of ['before', 'after'] as const)
  test(`default cancellation ${phase} checkpoint cannot leave a current preparing report`, async (t) => {
    const f = await fixture(t, 5);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let cancelled = false;
    async function cancel() {
      if (cancelled) return;
      cancelled = true;
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
      if (phase === 'before' && args[1].action === 'checkpoint-preparation') await cancel();
      const r = await manage(...args);
      if (phase === 'after' && args[1].action === 'checkpoint-preparation') await cancel();
      return r;
    };
    const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.equal(r.ok, false);
    assert.equal(cancelled, true);
    const p = await f.adapter.get('products', 'p');
    assert.ok(p);
    assert.equal(readCurrentCatalogPreparation(p), null);
    assert.equal(p.published, false);
    assert.equal((await f.adapter.get('catalogPreparationJobs', f.jobId))?.state, 'cancelled');
  });
test('cancelling an old input leaves the newer input preparation snapshot intact', async (t) => {
  const f = await fixture(t, 9);
  assert.ok((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok);
  await f.adapter.update('products', 'p', { name: 'New user input' });
  const next = await currentWorkerCall(f);
  assert.notEqual(next.jobId, f.jobId);
  assert.ok((await runCatalogPreparationWorker(f.authority, next.call)).ok);
  const before = await f.adapter.get('products', 'p');
  assert.ok(before);
  assert.equal(readCurrentCatalogPreparation(before)?.state, 'preparing');
  const old = readCatalogPreparationJob(
    await f.adapter.get('catalogPreparationJobs', f.jobId),
    f.jobId,
    Date.now(),
  );
  assert.ok(old);
  assert.ok(
    (
      await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'cancel',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: old.leaseVersion,
      })
    ).ok,
  );
  assert.deepEqual(await f.adapter.get('products', 'p'), before);
});

test('a rejected diagnostic checkpoint cannot be reported as a successful default step', async (t) => {
  const f = await fixture(t, 5);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (...args) =>
    args[1].action === 'checkpoint-preparation' ? { ok: false, code: 'BUSY' } : manage(...args);
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, await f.dispatch()), {
    ok: false,
    code: 'BUSY',
  });
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p), null);
  assert.equal(p.published, false);
});
test('default invalid pixel prefix returns blocked diagnostics before checking the remaining photos', async (t) => {
  const f = await fixture(t, 5);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.images[0].checksumSha256 = 'b'.repeat(64);
  writeFileSync(f.file, JSON.stringify(rows));
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.media.checked, 4);
  assert.equal(r.media.invalid, 1);
  assert.ok(r.issues.some((i) => i.severity === 'error' && i.stage === 'media'));
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'blocked');
  assert.equal(p.published, false);
});

test('human status reopens actual partial worker progress after admission expiry then continues to ready', async (t) => {
  const f = await fixture(t, 5);
  const call = await f.dispatch();
  assert.ok((await runCatalogPreparationWorker(f.authority, call)).ok);
  const reopened = new JsonFileAdapter(f.file);
  setAdapter(reopened);
  const fresh = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
    now: () => Date.now() + 31000,
  });
  assert.equal(fresh.verifyCall(call), null);
  const before = readFileSync(f.file, 'utf8');
  const status = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'status',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(status.ok && 'status' in status, JSON.stringify(status));
  assert.equal(status.status.nextAction, 'continue');
  assert.equal(status.status.report?.state, 'preparing');
  assert.equal(status.status.progress.media?.checked, 4);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  let r = await runCatalogPreparationWorker(f.authority, await f.dispatch(reopened));
  assert.ok(r.ok);
  if (r.outcome === 'partial')
    r = await runCatalogPreparationWorker(f.authority, await f.dispatch(reopened));
  assert.ok(r.ok && r.outcome === 'ready');
  const ready = await reopened.manageCatalogPreparationJob(fresh, {
    action: 'status',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(ready.ok && 'status' in ready);
  assert.equal(ready.status.nextAction, 'ready');
  assert.equal((await reopened.get('products', 'p'))?.published, false);
});
test('actual default retry clears consumed diagnostic and human status offers continuation before ready', async (t) => {
  const f = await fixture(t, 1);
  assert.ok(
    (
      await runCatalogPreparationWorker(f.authority, await f.dispatch(), {
        checkImage: async () => ({ status: 'retry', reason: 'timeout' }),
      })
    ).ok,
  );
  const status = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'status',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(status.ok && 'status' in status);
  assert.equal(status.status.nextAction, 'retry');
  assert.ok(status.status.report?.issues.some((i) => i.remedy === 'retry-media'));
  const before = await f.adapter.get('products', 'p');
  assert.ok(
    (
      await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'retry',
        actorId: 'admin',
        jobId: f.jobId,
        expectedLeaseVersion: status.status.progress.leaseVersion,
      })
    ).ok,
  );
  const next = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'status',
    actorId: 'admin',
    jobId: f.jobId,
  });
  assert.ok(next.ok && 'status' in next);
  assert.equal(next.status.nextAction, 'continue');
  assert.equal(next.status.report, null);
  assert.deepEqual(await f.adapter.get('products', 'p'), {
    ...before,
    catalogPreparationState: 'checking',
    catalogPreparationRequest: {
      ...CatalogPreparationRequestSchema.parse(before?.catalogPreparationRequest),
      requestedAt: next.status.progress.updatedAt,
    },
  });
  assert.equal(
    readCurrentCatalogPreparationRequest((await f.adapter.get('products', 'p')) ?? {})?.jobId,
    f.jobId,
  );
  const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
  assert.ok(r.ok && r.outcome === 'ready');
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

test('authenticated HTTP preparation start/status/cancel/retry joins the actual worker and preserves categories/publication', async (t) => {
  const f = await fixture(t, 5);
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const command = (data: unknown) => ({ action: 'catalogPreparation', token, data });
  async function api(data: unknown) {
    const response = await handleAdminFunctionEvent(
      { httpMethod: 'POST', headers: {}, body: JSON.stringify(command(data)) },
      config,
      handleAdminRequest,
    );
    assert.ok('statusCode' in response);
    assert.equal(response.statusCode, 200, response.body);
    return z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(response.body))
      .data;
  }
  const started = z
    .object({ ok: z.literal(true), progress: z.object({ jobId: z.string() }) })
    .parse(await api({ action: 'start', productId: 'p' }));
  assert.equal(started.progress.jobId, f.jobId);
  assert.ok((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok);
  const Status = z.object({
    ok: z.literal(true),
    status: z.object({
      current: z.boolean(),
      nextAction: z.string(),
      report: z.object({ state: z.string() }).nullable(),
      progress: z.object({
        leaseVersion: z.number(),
        media: z.object({ checked: z.number() }).nullable(),
      }),
    }),
  });
  const beforeStatus = readFileSync(f.file, 'utf8');
  const partial = Status.parse(await api({ action: 'status', jobId: f.jobId }));
  assert.equal(partial.status.nextAction, 'continue');
  assert.equal(partial.status.report?.state, 'preparing');
  assert.equal(partial.status.progress.media?.checked, 4);
  assert.equal(readFileSync(f.file, 'utf8'), beforeStatus);
  const beforeCancel = await f.adapter.get('products', 'p');
  await api({
    action: 'cancel',
    jobId: f.jobId,
    expectedLeaseVersion: partial.status.progress.leaseVersion,
  });
  assert.deepEqual(await f.adapter.get('products', 'p'), {
    ...beforeCancel,
    catalogPreparationState: 'stale',
  });
  const cancelled = Status.parse(await api({ action: 'status', jobId: f.jobId }));
  assert.equal(cancelled.status.nextAction, 'retry');
  assert.equal(cancelled.status.report, null);
  await api({
    action: 'retry',
    jobId: f.jobId,
    expectedLeaseVersion: cancelled.status.progress.leaseVersion,
  });
  let ready = false;
  for (let step = 0; step < 4; step++) {
    const r = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.ok(r.ok, JSON.stringify(r));
    if (r.outcome === 'ready') {
      ready = true;
      break;
    }
    assert.equal(r.outcome, 'partial');
  }
  assert.equal(ready, true);
  const status = Status.parse(await api({ action: 'status', jobId: f.jobId }));
  assert.equal(status.status.nextAction, 'ready');
  assert.equal(status.status.report?.state, 'ready');
  const product = await f.adapter.get('products', 'p');
  assert.ok(product);
  assert.equal(product.published, false);
  assert.equal(product.productFamily, 'misc');
  for (const key of ['nonce', 'signature', 'leaseOwner', 'storageFileId'])
    assert.equal(JSON.stringify(status).includes(key), false);
  await f.adapter.update('products', 'p', { name: 'New user input' });
  const stale = Status.parse(await api({ action: 'status', jobId: f.jobId }));
  assert.equal(stale.status.current, false);
  assert.equal(stale.status.report, null);
  assert.equal(stale.status.nextAction, 'restart');
  const fresh = z
    .object({ ok: z.literal(true), progress: z.object({ jobId: z.string() }) })
    .parse(await api({ action: 'start', productId: 'p' }));
  assert.notEqual(fresh.progress.jobId, f.jobId);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('lost authenticated start response is confirmed without surfacing an error or duplicating a job', async (t) => {
  const f = await fixture(t, 1);
  t.mock.method(console, 'error', () => {});
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.products.push({
    _id: 'second',
    name: 'Other clock',
    published: false,
    productFamily: 'misc',
    imageIds: [],
  });
  writeFileSync(f.file, JSON.stringify(rows));
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'start' && args[1].productId === 'second' && !lost) {
      lost = true;
      throw Error('owned fixture committed start ACK lost');
    }
    return result;
  };
  const request = {
    action: 'catalogPreparation',
    token,
    data: { action: 'start', productId: 'second' },
  };
  const unknown = await handleAdminRequest(request, config);
  assert.ok(unknown.ok, JSON.stringify(unknown));
  const retry = await handleAdminRequest(request, config);
  assert.ok(retry.ok, JSON.stringify(retry));
  const progress = z
    .object({ ok: z.literal(true), progress: z.object({ jobId: z.string() }) })
    .parse(retry.data);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    saved.catalogPreparationJobs.filter((j: { productId: string }) => j.productId === 'second')
      .length,
    1,
  );
  const status = await handleAdminRequest(
    {
      action: 'catalogPreparation',
      token,
      data: { action: 'status', jobId: progress.progress.jobId },
    },
    config,
  );
  assert.ok(status.ok);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
});

for (const action of ['cancel', 'retry'] as const)
  test(`lost authenticated ${action} ACK returns observed current status without repeating the write`, async (t) => {
    const f = await fixture(t, 5);
    assert.ok((await runCatalogPreparationWorker(f.authority, await f.dispatch())).ok);
    const config = {
      jwtSecret: 'worker-local-test',
      enableDetailApproval: true,
      preparationAuthority: f.authority,
    };
    const token = await signSession(config.jwtSecret, {
      sub: 'admin',
      email: 'admin@example.test',
      name: 'Admin',
      role: 'admin',
    });
    const job = readCatalogPreparationJob(
      await f.adapter.get('catalogPreparationJobs', f.jobId),
      f.jobId,
      Date.now(),
    );
    assert.ok(job);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let attempts = 0;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const r = await manage(...args);
      if (args[1].action === action && ++attempts === 1)
        throw Error('owned fixture write ACK lost');
      return r;
    };
    t.mock.method(console, 'error', () => {});
    const r = await handleAdminRequest(
      {
        action: 'catalogPreparation',
        token,
        data: { action, jobId: f.jobId, expectedLeaseVersion: job.leaseVersion },
      },
      config,
    );
    assert.ok(r.ok, JSON.stringify(r));
    const recovered = z
      .object({
        ok: z.literal(true),
        recovery: z.literal('status'),
        status: z.object({
          nextAction: z.string(),
          report: z.unknown().nullable(),
          progress: z.object({ state: z.string(), leaseVersion: z.number() }),
        }),
      })
      .parse(r.data);
    assert.equal(attempts, 1);
    assert.equal(recovered.status.progress.state, action === 'cancel' ? 'cancelled' : 'queued');
    assert.equal(
      recovered.status.progress.leaseVersion,
      job.leaseVersion + (action === 'retry' ? 1 : 0),
    );
    assert.equal(recovered.status.nextAction, action === 'cancel' ? 'retry' : 'continue');
    assert.equal(recovered.status.report, null);
    assert.equal((await f.adapter.get('products', 'p'))?.published, false);
  });

test('unconfirmed cancel returns explicit observed state and never reports a cancelled job', async (t) => {
  const f = await fixture(t, 1);
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let writes = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (args[1].action === 'cancel') {
      writes++;
      throw Error('owned fixture transport failed before write');
    }
    return manage(...args);
  };
  const r = await handleAdminRequest(
    {
      action: 'catalogPreparation',
      token,
      data: { action: 'cancel', jobId: f.jobId, expectedLeaseVersion: 0 },
    },
    config,
  );
  assert.ok(r.ok);
  const observed = z
    .object({
      ok: z.literal(true),
      recovery: z.literal('status'),
      status: z.object({
        progress: z.object({ state: z.string(), leaseVersion: z.number() }),
        nextAction: z.string(),
      }),
    })
    .parse(r.data);
  assert.equal(observed.status.progress.state, 'queued');
  assert.equal(observed.status.progress.leaseVersion, 0);
  assert.equal(observed.status.nextAction, 'continue');
  assert.equal(writes, 1);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('two unavailable start acknowledgements stop bounded confirmation while retaining one queryable job', async (t) => {
  const f = await fixture(t, 1);
  t.mock.method(console, 'error', () => {});
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let attempts = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'start') {
      attempts++;
      throw Error('owned fixture ACK unavailable');
    }
    return result;
  };
  const request = {
    action: 'catalogPreparation',
    token,
    data: { action: 'start', productId: 'p' },
  };
  const failed = await handleAdminRequest(request, config);
  assert.ok(!failed.ok);
  assert.equal(failed.error.code, 'INTERNAL_ERROR');
  assert.equal(attempts, 2);
  f.adapter.manageCatalogPreparationJob = manage;
  const recovered = await handleAdminRequest(request, config);
  assert.ok(recovered.ok);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(
    rows.catalogPreparationJobs.filter((j: { productId: string }) => j.productId === 'p').length,
    1,
  );
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('human write confirmation rechecks revoked permission and never returns private progress', async (t) => {
  const f = await fixture(t, 1);
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'cancel') {
      await f.adapter.update('users', 'admin', { status: 'suspended' });
      throw Error('owned fixture ACK lost after revocation');
    }
    return result;
  };
  const r = await handleAdminRequest(
    {
      action: 'catalogPreparation',
      token,
      data: { action: 'cancel', jobId: f.jobId, expectedLeaseVersion: 0 },
    },
    config,
  );
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'FORBIDDEN');
  assert.equal(JSON.stringify(r).includes(f.jobId), false);
  assert.equal((await f.adapter.get('catalogPreparationJobs', f.jobId))?.state, 'cancelled');
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

test('authenticated continue brokers real bounded worker steps and reads current readiness', async (t) => {
  const f = await fixture(t, 5);
  let calls = 0;
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
    preparationInvoke: async (call: unknown) => {
      calls++;
      return { result: await runCatalogPreparationWorker(f.authority, call) };
    },
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const request = {
    action: 'catalogPreparation',
    token,
    data: { action: 'continue', jobId: f.jobId },
  };
  const first = await handleAdminRequest(request, config);
  assert.ok(first.ok, JSON.stringify(first));
  const Step = z.object({
    ok: z.literal(true),
    status: z.object({
      nextAction: z.string(),
      report: z.object({ state: z.string() }).nullable(),
    }),
    followUp: z.enum(['continue', 'poll', 'none']),
  });
  const partial = Step.parse(first.data);
  assert.equal(partial.status.report?.state, 'preparing');
  assert.equal(partial.followUp, 'continue');
  let ready = false;
  for (let n = 0; n < 4; n++) {
    const r = await handleAdminRequest(request, config);
    assert.ok(r.ok, JSON.stringify(r));
    const step = Step.parse(r.data);
    if (step.status.nextAction === 'ready') {
      assert.equal(step.followUp, 'none');
      ready = true;
      break;
    }
    assert.equal(step.followUp, 'continue');
  }
  assert.equal(ready, true);
  const before = calls;
  const same = await handleAdminRequest(request, config);
  assert.ok(same.ok);
  assert.equal(Step.parse(same.data).status.nextAction, 'ready');
  assert.equal(calls, before);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('authenticated continue never invokes a current blocked candidate', async (t) => {
  const f = await fixture(t, 1);
  await f.adapter.update('products', 'p', { name: '' });
  const current = await currentWorkerCall(f);
  assert.ok((await runCatalogPreparationWorker(f.authority, current.call)).ok);
  let calls = 0;
  const config = {
    jwtSecret: 'worker-local-test',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
    preparationInvoke: async () => {
      calls++;
      throw Error('must not invoke');
    },
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const r = await handleAdminRequest(
    { action: 'catalogPreparation', token, data: { action: 'continue', jobId: current.jobId } },
    config,
  );
  assert.ok(r.ok, JSON.stringify(r));
  const data = z
    .object({
      ok: z.literal(true),
      followUp: z.literal('none'),
      status: z.object({ nextAction: z.literal('edit') }),
    })
    .parse(r.data);
  assert.equal(data.status.nextAction, 'edit');
  assert.equal(calls, 0);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

async function humanContinue(
  f: Pick<Awaited<ReturnType<typeof fixture>>, 'authority' | 'jobId'>,
  invoke: CatalogPreparationInvoker = createLocalCatalogPreparationInvoker((call) =>
    runCatalogPreparationCall(f.authority, call),
  ),
) {
  const config = {
    jwtSecret: 'human-continue-session',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
    preparationInvoke: invoke,
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  return () =>
    handleAdminRequest(
      { action: 'catalogPreparation', token, data: { action: 'continue', jobId: f.jobId } },
      config,
    );
}
const ContinueView = z.object({
  ok: z.literal(true),
  followUp: z.enum(['continue', 'poll', 'none']),
  invocation: z.string(),
  status: z.object({
    current: z.boolean(),
    nextAction: z.string(),
    progress: z.object({ state: z.string() }),
    report: z.object({ state: z.string() }).nullable(),
  }),
});
test('authenticated continue cannot turn a forged SDK ready response into actual readiness', async (t) => {
  const f = await fixture(t, 1);
  const api = await humanContinue(f, async () => ({
    result: {
      ok: true,
      kind: 'catalog-preparation-step',
      jobId: f.jobId,
      productId: 'p',
      outcome: 'ready',
      media: { total: 1, checked: 1, verified: 1, invalid: 0, retry: 0 },
      attestation: { total: 1, checked: 1 },
      issues: [],
    },
  }));
  const before = readFileSync(f.file, 'utf8');
  const r = await api();
  assert.ok(r.ok);
  const result = ContinueView.parse(r.data);
  assert.equal(result.invocation, 'unconfirmed');
  assert.equal(result.followUp, 'poll');
  assert.equal(result.status.nextAction, 'continue');
  assert.equal(result.status.report, null);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('authenticated continue recovers actual completed proof after an invocation ACK is lost', async (t) => {
  const f = await fixture(t, 1);
  const api = await humanContinue(f, async (call) => {
    const r = await runCatalogPreparationCall(f.authority, call);
    assert.ok(r.ok && r.outcome === 'ready');
    throw Object.assign(Error('owned ACK timeout'), { code: 'ETIMEDOUT' });
  });
  const r = await api();
  assert.ok(r.ok);
  const result = ContinueView.parse(r.data);
  assert.equal(result.invocation, 'recovered');
  assert.equal(result.status.report?.state, 'ready');
  assert.equal(result.followUp, 'none');
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('authenticated continue times out its local wait then the same durable worker remains resumable', async (t) => {
  const f = await fixture(t, 5);
  let work: ReturnType<typeof runCatalogPreparationCall> | undefined;
  const api = await humanContinue(
    f,
    createLocalCatalogPreparationInvoker((call) => {
      work = runCatalogPreparationCall(f.authority, call);
      return work;
    }, 1),
  );
  try {
    const r = await api();
    assert.ok(r.ok);
    const result = ContinueView.parse(r.data);
    assert.equal(result.invocation, 'unconfirmed');
    assert.equal(result.followUp, 'poll');
    assert.ok(work);
    const completed = await work;
    assert.ok(completed.ok && completed.outcome === 'partial');
    const resume = await humanContinue(f);
    let ready = false;
    for (let step = 0; step < 4; step++) {
      const next = await resume();
      assert.ok(next.ok, JSON.stringify(next));
      const status = ContinueView.parse(next.data);
      if (status.status.nextAction === 'ready') {
        ready = true;
        break;
      }
      assert.equal(status.followUp, 'continue');
    }
    assert.equal(ready, true);
    assert.equal((await f.adapter.get('products', 'p'))?.published, false);
  } finally {
    if (work) await Promise.allSettled([work]);
  }
});
for (const change of ['edit', 'cancel', 'revoke'] as const)
  test(`authenticated continue reads a real concurrent ${change} after execution`, async (t) => {
    const f = await fixture(t, 5);
    const api = await humanContinue(f, async (call) => {
      const step = await runCatalogPreparationCall(f.authority, call);
      assert.ok(step.ok && step.outcome === 'partial');
      if (change === 'edit') await f.adapter.update('products', 'p', { name: 'Concurrent input' });
      if (change === 'revoke') await f.adapter.update('users', 'admin', { status: 'suspended' });
      if (change === 'cancel') {
        const job = readCatalogPreparationJob(
          await f.adapter.get('catalogPreparationJobs', f.jobId),
          f.jobId,
          Date.now(),
        );
        assert.ok(job);
        assert.ok(
          (
            await f.adapter.manageCatalogPreparationJob(f.authority, {
              action: 'cancel',
              actorId: 'admin',
              jobId: f.jobId,
              expectedLeaseVersion: job.leaseVersion,
            })
          ).ok,
        );
      }
      return { result: step };
    });
    const r = await api();
    if (change === 'revoke') {
      assert.ok(!r.ok);
      assert.equal(r.error.code, 'FORBIDDEN');
    } else {
      assert.ok(r.ok);
      const result = ContinueView.parse(r.data);
      assert.equal(result.followUp, 'none');
      assert.equal(result.status.nextAction, change === 'edit' ? 'restart' : 'retry');
      assert.equal(result.status.report, null);
    }
    assert.equal((await f.adapter.get('products', 'p'))?.published, false);
  });
test('authenticated continue preserves an unclassified product while current publication validation still rejects it', async (t) => {
  const f = await fixture(t, 1, true);
  const api = await humanContinue(f);
  const r = await api();
  assert.ok(r.ok, JSON.stringify(r));
  const result = ContinueView.parse(r.data);
  assert.equal(result.status.nextAction, 'ready');
  const p = await f.adapter.get('products', 'p');
  assert.ok(p);
  assert.equal(Object.hasOwn(p, 'productFamily'), false);
  assert.equal(p.published, false);
  assert.equal(readCurrentCatalogPreparation(p)?.state, 'ready');
  assert.equal(productFamilyForDoc(p), null);
  assert.ok(
    validateProductPublication({ ...p, published: true }).some(
      (issue) => issue.field === 'productFamily',
    ),
  );
});
test('authenticated source503 remains manual, then continuation of the same job reaches ready', async (t) => {
  const f = await unboundSourceWorkspace(t, 1);
  let failing = true;
  let fetches = 0;
  const api = await humanContinue(f, async (call) => ({
    result: await runCatalogPreparationWorker(f.authority, call, {
      importSourceImage: (url, persistImport) =>
        importCandidateImage(url, {
          persistImport,
          resolveDns: async () => ['104.16.1.1'],
          fetchImpl: async () => {
            fetches++;
            return failing
              ? new Response('owned temporary', { status: 503 })
              : new Response(new Uint8Array(bytes));
          },
        }),
    }),
  }));
  const first = await api();
  assert.ok(first.ok, JSON.stringify(first));
  const result = ContinueView.parse(first.data);
  assert.equal(result.invocation, 'acknowledged');
  assert.equal(result.followUp, 'none');
  assert.equal(result.status.nextAction, 'continue');
  assert.equal(result.status.report?.state, 'preparing');
  const before = fetches;
  failing = false;
  const second = await api();
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(ContinueView.parse(second.data).status.nextAction, 'ready');
  assert.equal(fetches, before + 1);
  assert.equal((await f.adapter.get('products', f.productId))?.published, false);
});

for (const missingCategory of [false, true])
  test(`actual prepare/edit/blocked/repair chain moves native list scopes without publication, missingCategory=${missingCategory}`, async (t) => {
    const f = await fixture(t, 1, missingCategory);
    const ids = async (catalogReadiness: 'normal' | 'issues' | 'preparing' | 'unchecked') =>
      (
        await f.adapter.list({
          collection: 'products',
          catalogReadiness,
          page: 1,
          pageSize: 20,
          search: '',
        })
      ).items.map((p) => p._id);
    assert.deepEqual(await ids('preparing'), ['p']);
    assert.deepEqual(await ids('normal'), []);
    const first = await runCatalogPreparationWorker(f.authority, await f.dispatch());
    assert.ok(first.ok && first.outcome === 'ready', JSON.stringify(first));
    assert.deepEqual(await ids('normal'), ['p']);
    assert.deepEqual(await ids('preparing'), []);
    // Inject a bad stored input through the real write layer, as a legacy/source repair case.
    await f.adapter.update('products', 'p', { name: '' });
    assert.deepEqual(await ids('normal'), []);
    assert.deepEqual(await ids('unchecked'), ['p']);
    const execute = async () => {
      const start = await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'start',
        actorId: 'admin',
        productId: 'p',
      });
      assert.ok(start.ok && 'progress' in start);
      const dispatch = await f.adapter.manageCatalogPreparationJob(f.authority, {
        action: 'dispatch',
        actorId: 'admin',
        jobId: start.progress.jobId,
      });
      assert.ok(dispatch.ok && 'call' in dispatch);
      assert.deepEqual(await ids('preparing'), ['p']);
      return runCatalogPreparationWorker(f.authority, dispatch.call);
    };
    const bad = await execute();
    assert.ok(bad.ok && bad.outcome === 'blocked', JSON.stringify(bad));
    assert.deepEqual(await ids('issues'), ['p']);
    assert.deepEqual(await ids('normal'), []);
    await f.adapter.update('products', 'p', { name: 'Repaired clock' });
    assert.deepEqual(await ids('unchecked'), ['p']);
    const repaired = await execute();
    assert.ok(repaired.ok && repaired.outcome === 'ready', JSON.stringify(repaired));
    assert.deepEqual(await ids('normal'), ['p']);
    assert.deepEqual(await ids('issues'), []);
    const saved = await new JsonFileAdapter(f.file).get('products', 'p');
    assert.equal(saved?.published, false);
    assert.equal(saved?.productFamily, missingCategory ? undefined : 'misc');
    assert.equal(saved?.subcategoryIds, undefined);
    assert.equal(readCurrentCatalogPreparation(saved ?? {})?.state, 'ready');
  });

async function progressLease(t: { after(fn: () => void): void }, phase: 'reserve' | 'attest') {
  const f = await fixture(t, 1);
  if (phase === 'attest') {
    const checked = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
    assert.ok(checked.ok && checked.media.verified === 1, JSON.stringify(checked));
  }
  let clock = Date.now();
  const authority = createCatalogPreparationAuthority({
    secret: 'worker-local-test',
    environmentId: 'local-worker-env',
    now: () => clock,
  });
  const run = (command: Parameters<typeof f.adapter.manageCatalogPreparationJob>[1]) =>
    f.adapter.manageCatalogPreparationJob(authority, command, clock);
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId: f.jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'progress-heartbeat-worker' });
  assert.ok(c.ok && 'lease' in c);
  const scope = { jobId: f.jobId, lease: c.lease };
  const job = await f.adapter.get('catalogPreparationJobs', f.jobId);
  assert.ok(job);
  const media = z.object({ planDigest: z.string() }).safeParse(job.media);
  if (phase === 'attest') {
    assert.ok(media.success);
    const bound = await run({
      action: 'bind-media-seal',
      ...scope,
      planDigest: media.data.planDigest,
    });
    assert.ok(bound.ok, JSON.stringify(bound));
  }
  const command =
    phase === 'reserve'
      ? { action: 'reserve-image-check' as const, ...scope, imageId: 'image-0000' }
      : {
          action: 'attest-media-image' as const,
          ...scope,
          imageId: 'image-0000',
          index: 0,
          planDigest: media.success ? media.data.planDigest : '',
        };
  return {
    ...f,
    authority,
    run,
    command,
    initialExpiry: c.progress.leaseExpiresAt,
    get clock() {
      return clock;
    },
    set clock(value: number) {
      clock = value;
    },
  };
}
for (const phase of ['reserve', 'attest'] as const) {
  test(`${phase} progress transaction renews the same valid lease and preserves idempotent attestation`, async (t) => {
    const f = await progressLease(t, phase);
    const before = await f.adapter.get('products', 'p');
    f.clock += 90000;
    const first = await f.run(f.command);
    assert.ok(first.ok, JSON.stringify(first));
    const after = await f.adapter.get('catalogPreparationJobs', f.jobId);
    assert.equal(after?.leaseExpiresAt, f.clock + 120000);
    f.clock += 40000;
    assert.ok(f.clock > f.initialExpiry);
    const health = await f.run({
      action: 'get-protected-image-health',
      jobId: f.jobId,
      lease: f.command.lease,
      imageId: 'image-0000',
    });
    assert.ok(health.ok, JSON.stringify(health));
    if (phase === 'attest') {
      const snapshot = readFileSync(f.file, 'utf8');
      assert.deepEqual(await f.run(f.command), first);
      assert.equal(readFileSync(f.file, 'utf8'), snapshot);
    }
    assert.deepEqual(await f.adapter.get('products', 'p'), before);
    assert.equal((await f.adapter.get('images', 'image-0000'))?.publishedRefCount, 0);
  });
  for (const fault of ['expired', 'cancelled', 'taken-over', 'edited'] as const)
    test(`${phase} progress transaction cannot renew an ${fault} capability`, async (t) => {
      const f = await progressLease(t, phase);
      if (fault === 'expired' || fault === 'taken-over') f.clock += 120001;
      if (fault === 'cancelled') {
        const job = await f.adapter.get('catalogPreparationJobs', f.jobId);
        assert.ok(job && typeof job.leaseVersion === 'number');
        assert.ok(
          (
            await f.run({
              action: 'cancel',
              actorId: 'admin',
              jobId: f.jobId,
              expectedLeaseVersion: job.leaseVersion,
            })
          ).ok,
        );
      }
      if (fault === 'taken-over') {
        const d = await f.run({ action: 'dispatch', actorId: 'admin', jobId: f.jobId });
        assert.ok(d.ok && 'call' in d);
        assert.ok(
          (await f.run({ action: 'claim', call: d.call, owner: 'new-independent-worker' })).ok,
        );
      }
      if (fault === 'edited') await f.adapter.update('products', 'p', { name: 'Independent edit' });
      const before = await f.adapter.get('catalogPreparationJobs', f.jobId);
      assert.ok(before && typeof before.leaseExpiresAt === 'number');
      const result = await f.run(f.command);
      assert.equal(result.ok, false);
      const after = await f.adapter.get('catalogPreparationJobs', f.jobId);
      assert.ok(after && typeof after.leaseExpiresAt === 'number');
      assert.ok(after.leaseExpiresAt <= before.leaseExpiresAt);
      assert.deepEqual(after.media, before.media);
      assert.deepEqual(after.mediaSeal, before.mediaSeal);
      assert.equal((await f.adapter.get('products', 'p'))?.published, false);
      if (fault !== 'edited') assert.deepEqual(after, before);
    });
}
test('nine actual PNG checks and attestations bound standalone heartbeats to guarded inspections', async (t) => {
  const f = await fixture(t, 9);
  const before = await f.adapter.get('products', 'p');
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let renewals = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (args[1].action === 'renew') renewals++;
    return manage(...args);
  };
  try {
    let ready = false;
    for (let step = 0; step < 3; step++) {
      const result = await runCatalogPreparationWorker(f.authority, await f.dispatch());
      assert.ok(result.ok, JSON.stringify(result));
      ready = result.outcome === 'ready';
    }
    assert.equal(ready, true);
    assert.ok(renewals <= 6, `expected at most 6 inspection heartbeats, got ${renewals}`);
    const current = await f.adapter.get('products', 'p');
    assert.equal(current?.published, false);
    assert.deepEqual(current?.imageIds, before?.imageIds);
    assert.equal(current?.productFamily, before?.productFamily);
    for (const image of f.images)
      assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  } finally {
    f.adapter.manageCatalogPreparationJob = manage;
  }
});

async function reservedCachedImage(t: { after(fn: () => void): void }) {
  const f = await fixture(t, 1);
  const warm = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  assert.ok(warm.ok && warm.media.verified === 1, JSON.stringify(warm));
  const shared = await sharedProduct(f);
  const claim = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'claim',
    call: shared.call,
    owner: 'cached-reservation-worker',
  });
  assert.ok(claim.ok && 'lease' in claim);
  const command = {
    action: 'reserve-image-check' as const,
    jobId: shared.jobId,
    lease: claim.lease,
    imageId: 'image-0000',
    includeProtectedHealth: true as const,
  };
  const reserve = () => f.adapter.manageCatalogPreparationJob(f.authority, command);
  return { ...f, shared, command, reserve };
}
test('reserved image opt-in returns the current protected pixel proof without a shared cache write', async (t) => {
  const f = await reservedCachedImage(t);
  const before = JSON.parse(readFileSync(f.file, 'utf8'));
  const result = await f.reserve();
  assert.ok(result.ok && 'reservation' in result, JSON.stringify(result));
  const proof = Reflect.get(result, 'protectedHealth');
  assert.ok(proof && typeof proof === 'object');
  assert.equal(Reflect.get(proof, 'imageId'), 'image-0000');
  assert.equal(Reflect.get(proof, 'status'), 'verified');
  assert.equal(
    Reflect.get(proof, 'checksumSha256'),
    createHash('sha256').update(bytes).digest('hex'),
  );
  const after = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.deepEqual(after.images, before.images);
  assert.deepEqual(after.products, before.products);
  for (const row of before.catalogImageObservations)
    assert.deepEqual(
      after.catalogImageObservations.find((x: { _id: string }) => x._id === row._id),
      row,
    );
});
test('legacy reservation keeps its response shape and does not require a protected-pixel read', async (t) => {
  const f = await reservedCachedImage(t);
  const { includeProtectedHealth: _optIn, ...command } = f.command;
  assert.deepEqual(await f.adapter.manageCatalogPreparationJob(f.authority, command), {
    ok: true,
    reservation: 'reserved',
  });
});
for (const fault of ['policy', 'checksum', 'binding', 'busy', 'missing-proof'] as const)
  test(`reserved image returns no cached health for ${fault}`, async (t) => {
    const f = await reservedCachedImage(t);
    const rows = JSON.parse(readFileSync(f.file, 'utf8'));
    const proof = rows.catalogImageObservations.find(
      (x: { kind: string }) => x.kind === 'catalog-protected-image-health-v1',
    );
    assert.ok(proof);
    if (fault === 'policy') proof.policyVersion = 'old-policy';
    if (fault === 'checksum') rows.images[0].checksumSha256 = 'f'.repeat(64);
    if (fault === 'binding') rows.images[0].catalogStorageProtection.attemptId = 'f'.repeat(64);
    if (fault === 'busy')
      Object.assign(rows.images[0], {
        imageMutationOwner: 'independent-image-owner',
        imageMutationStartedAt: new Date().toISOString(),
      });
    if (fault === 'missing-proof')
      rows.catalogImageObservations = rows.catalogImageObservations.filter(
        (x: { _id: string }) => x._id !== proof._id,
      );
    writeFileSync(f.file, JSON.stringify(rows));
    const result = await f.reserve();
    assert.ok(result.ok && 'reservation' in result, JSON.stringify(result));
    assert.equal(Reflect.get(result, 'protectedHealth'), null);
    assert.equal((await f.adapter.get('products', 'second'))?.published, false);
  });
test('shared protected pixels finish without separate protection transactions or object IO', async (t) => {
  const f = await fixture(t, 1);
  const warm = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  assert.ok(warm.ok && warm.media.verified === 1, JSON.stringify(warm));
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  const unnecessary: string[] = [];
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (
      args[1].action === 'begin-image-protection' ||
      args[1].action === 'get-protected-image-health'
    )
      unnecessary.push(args[1].action);
    return manage(...args);
  };
  f.storage.getObjectAsBase64 = async () => {
    throw Error('cached pixels must not reread bytes');
  };
  f.storage.putObject = async () => {
    throw Error('cached pixels must not write objects');
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
  assert.deepEqual(unnecessary, []);
  const current = await f.adapter.get('products', 'second');
  assert.equal(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
  assert.equal(current?.published, false);
  assert.equal(current?.productFamily, 'misc');
  assert.equal((await f.adapter.get('images', 'image-0000'))?.publishedRefCount, 0);
});
for (const change of ['cancel', 'edit', 'image', 'wrong-proof'] as const)
  test(`cached reservation cannot bypass a later ${change} at advance or attestation`, async (t) => {
    const f = await fixture(t, 1);
    assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
    const shared = await sharedProduct(f);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let usedCache = false;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const result = await manage(...args);
      if (args[1].action === 'reserve-image-check' && result.ok && 'reservation' in result) {
        const proof = result.protectedHealth;
        if (!proof) return result;
        usedCache = true;
        if (change === 'cancel') {
          const job = await f.adapter.get('catalogPreparationJobs', shared.jobId);
          assert.ok(job && typeof job.leaseVersion === 'number');
          assert.ok(
            (
              await manage(f.authority, {
                action: 'cancel',
                actorId: 'admin',
                jobId: shared.jobId,
                expectedLeaseVersion: job.leaseVersion,
              })
            ).ok,
          );
        }
        if (change === 'edit')
          await f.adapter.update('products', 'second', { name: 'Independent edit' });
        if (change === 'image') {
          const rows = JSON.parse(readFileSync(f.file, 'utf8'));
          rows.images[0].checksumSha256 = 'f'.repeat(64);
          writeFileSync(f.file, JSON.stringify(rows));
        }
        if (change === 'wrong-proof')
          return { ...result, protectedHealth: { ...proof, imageId: 'another-image' } };
      }
      return result;
    };
    const result = await runCatalogPreparationWorker(f.authority, shared.call);
    assert.equal(usedCache, true);
    assert.equal(result.ok, false);
    const product = await f.adapter.get('products', 'second');
    assert.notEqual(readCurrentCatalogPreparation(product ?? {})?.state, 'ready');
    assert.equal(product?.published, false);
    assert.equal((await f.adapter.get('images', 'image-0000'))?.publishedRefCount, 0);
  });

test('lost cached reservation acknowledgement resumes the original job without object IO', async (t) => {
  const f = await fixture(t, 1);
  const warm = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  assert.ok(warm.ok && warm.media.verified === 1, JSON.stringify(warm));
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lostReplies = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'reserve-image-check' && result.ok && lostReplies < 2) {
      lostReplies++;
      throw Error('reservation response lost after commit');
    }
    return result;
  };
  f.storage.getObjectAsBase64 = async () => {
    throw Error('must reuse held protected pixels');
  };
  f.storage.putObject = async () => {
    throw Error('must not duplicate protected object');
  };
  assert.deepEqual(await runCatalogPreparationWorker(f.authority, shared.call), {
    ok: false,
    code: 'UNAVAILABLE',
  });
  const next = await manage(f.authority, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: shared.jobId,
  });
  assert.ok(next.ok && 'call' in next);
  const recovered = await runCatalogPreparationWorker(f.authority, next.call);
  assert.ok(recovered.ok && recovered.outcome === 'ready', JSON.stringify(recovered));
  assert.equal(recovered.jobId, shared.jobId);
  assert.equal(lostReplies, 2);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
  assert.equal((await f.adapter.get('images', 'image-0000'))?.publishedRefCount, 0);
});

async function cachedPlan(t: { after(fn: () => void): void }, count: number) {
  const f = await fixture(t, count);
  for (let n = 0; n < Math.ceil(count / 4); n++) {
    const result = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.media.checked, Math.min((n + 1) * 4, count));
  }
  const shared = await sharedProduct(
    f,
    f.images.slice(0, 9).map((i) => i._id),
    f.images.slice(9).map((i) => i._id),
  );
  const dispatchCached = async () => {
    const d = await f.adapter.manageCatalogPreparationJob(f.authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: shared.jobId,
    });
    assert.ok(d.ok && 'call' in d);
    return d.call;
  };
  return { ...f, shared, dispatchCached };
}
for (const [count, steps] of [
  [9, 1],
  [27, 3],
] as const)
  test(`cached-only ${count} images finish in ${steps} bounded calls without byte work`, async (t) => {
    const f = await cachedPlan(t, count);
    const original = await f.adapter.get('products', 'second');
    f.storage.getObjectAsBase64 = async () => {
      throw Error('metadata pass must not read objects');
    };
    f.storage.putObject = async () => {
      throw Error('metadata pass must not copy objects');
    };
    let result: Awaited<ReturnType<typeof runCatalogPreparationWorker>> | undefined;
    for (let n = 0; n < steps; n++) {
      result = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
      assert.ok(result.ok, JSON.stringify(result));
      if (count === 27 && n === 0) assert.equal(result.media.checked, 16);
    }
    assert.ok(result?.ok && result.outcome === 'ready', JSON.stringify(result));
    assert.equal(result.media.verified, count);
    assert.equal(result.attestation?.checked, count);
    const current = await f.adapter.get('products', 'second');
    assert.equal(current?.published, false);
    assert.equal(current?.productFamily, original?.productFamily);
    assert.deepEqual(current?.imageIds, original?.imageIds);
    assert.deepEqual(current?.descriptionImageIds, original?.descriptionImageIds);
    for (const image of f.images)
      assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  });
test('cached and raw images share a bounded pass while only four raw images enter protection', async (t) => {
  const f = await fixture(t, 9);
  const warm = await runCatalogPreparationMediaWorker(f.authority, await f.dispatch());
  assert.ok(warm.ok && warm.media.verified === 4);
  const shared = await sharedProduct(
    f,
    f.images.map((i) => i._id),
  );
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  const bytes = new Set<string>();
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (args[1].action === 'begin-image-protection') bytes.add(args[1].imageId);
    return manage(...args);
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'partial');
  assert.equal(result.media.checked, 8);
  assert.deepEqual(
    [...bytes].sort(),
    f.images.slice(4, 8).map((i) => i._id),
  );
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
});
for (const [mode, expected] of [
  ['single-image fallback', 1],
  ['atomic page', 8],
] as const)
  test(`cached-only ${mode} checkpoints its exact prefix when the time budget ends`, async (t) => {
    const f = await cachedPlan(t, 9);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let clock = Date.now();
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      if (mode === 'single-image fallback' && args[1].action === 'check-protected-media-page')
        return { ok: true, protectedPage: 'miss' };
      const result = await manage(...args);
      if (
        args[1].action === 'advance-media-check' ||
        args[1].action === 'check-protected-media-page'
      )
        clock += 20000;
      return result;
    };
    f.storage.getObjectAsBase64 = async () => {
      throw Error('cached budget cannot read bytes');
    };
    f.storage.putObject = async () => {
      throw Error('cached budget cannot copy');
    };
    const first = await runCatalogPreparationWorker(f.authority, await f.dispatchCached(), {
      now: () => clock,
    });
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal(first.outcome, 'partial');
    assert.equal(first.media.checked, expected);
    f.adapter.manageCatalogPreparationJob = manage;
    const next = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
    assert.ok(next.ok && next.outcome === 'ready', JSON.stringify(next));
    assert.equal(next.media.verified, 9);
    assert.equal((await f.adapter.get('products', 'second'))?.published, false);
  });
for (const change of ['edit', 'cancel'] as const)
  test(`cached single-image fallback rechecks ${change} before its fifth image`, async (t) => {
    const f = await cachedPlan(t, 9);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let changed = false;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const command = args[1];
      if (command.action === 'check-protected-media-page')
        return { ok: true, protectedPage: 'miss' };
      if (
        command.action === 'reserve-image-check' &&
        command.imageId === 'image-0004' &&
        !changed
      ) {
        changed = true;
        if (change === 'edit')
          await f.adapter.update('products', 'second', { name: 'Independent fifth-image edit' });
        else {
          const job = await f.adapter.get('catalogPreparationJobs', f.shared.jobId);
          assert.ok(job && typeof job.leaseVersion === 'number');
          assert.ok(
            (
              await manage(f.authority, {
                action: 'cancel',
                actorId: 'admin',
                jobId: f.shared.jobId,
                expectedLeaseVersion: job.leaseVersion,
              })
            ).ok,
          );
        }
      }
      return manage(...args);
    };
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
    assert.equal(changed, true);
    assert.equal(result.ok, false);
    const current = await f.adapter.get('products', 'second');
    assert.notEqual(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
    assert.equal(current?.published, false);
  });

test('optional cached reservation lost reply safely falls back once and still finishes without byte work', async (t) => {
  const f = await fixture(t, 1);
  assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
  const shared = await sharedProduct(f);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  const flags: boolean[] = [];
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'reserve-image-check') {
      flags.push(args[1].includeProtectedHealth === true);
      if (flags.length === 1) throw Error('committed optional reservation reply lost');
    }
    return result;
  };
  f.storage.getObjectAsBase64 = async () => {
    throw Error('no repeated bytes');
  };
  f.storage.putObject = async () => {
    throw Error('no duplicate object');
  };
  const result = await runCatalogPreparationWorker(f.authority, shared.call);
  assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
  assert.deepEqual(flags, [true, false]);
  assert.equal(result.jobId, shared.jobId);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
  assert.equal((await f.adapter.get('images', 'image-0000'))?.publishedRefCount, 0);
});
for (const failure of ['rejected', 'coded-busy', 'budget'] as const)
  test(`optional cached reservation fallback cannot bypass ${failure}`, async (t) => {
    const f = await fixture(t, 1);
    assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
    const shared = await sharedProduct(f);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let clock = Date.now();
    let reservations = 0;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      if (args[1].action === 'reserve-image-check') {
        reservations++;
        if (failure === 'rejected') return { ok: false, code: 'BUSY' };
        if (failure === 'coded-busy')
          throw Object.assign(Error('Busy'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
        clock += 20000;
        throw Error('cache transport used remaining budget');
      }
      return manage(...args);
    };
    const result = await runCatalogPreparationWorker(f.authority, shared.call, {
      now: () => clock,
    });
    assert.equal(result.ok, false);
    assert.equal(reservations, 1);
    assert.equal((await f.adapter.get('products', 'second'))?.published, false);
  });

test('a bounded metadata page seals three protected images atomically and replays without writes', async (t) => {
  const f = await fixture(t, 3);
  assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const command = {
    action: 'attest-media-page' as const,
    ...seal.scope,
    planDigest: seal.planDigest,
    from: seal.bind.mediaSeal,
    imageIds: f.images.map((i) => i._id),
  };
  const result = await seal.run(command);
  assert.ok(result.ok && 'mediaSeal' in result, JSON.stringify(result));
  assert.equal(result.mediaSeal.cursor, 3);
  assert.equal(result.mediaSeal.imageIdsDigest, catalogSealedImageIdsDigest(command.imageIds));
  const committed = readFileSync(f.file, 'utf8');
  assert.deepEqual(await seal.run(command), result);
  assert.equal(readFileSync(f.file, 'utf8'), committed);
  assert.deepEqual(await seal.attest(2, 'image-0002'), result);
});

for (const fault of [
  'late-image-change',
  'wrong-order',
  'missing-hold',
  'wrong-plan',
  'over-eight',
] as const)
  test(`metadata page rejects ${fault} without a partial seal`, async (t) => {
    const f = await fixture(t, 3);
    assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
    const seal = await sealScope(f.adapter, f.authority, f.jobId);
    const command = {
      action: 'attest-media-page' as const,
      ...seal.scope,
      planDigest: seal.planDigest,
      from: seal.bind.mediaSeal,
      imageIds: f.images.map((i) => i._id),
    };
    if (fault === 'wrong-order') command.imageIds.reverse();
    if (fault === 'wrong-plan') command.planDigest = 'f'.repeat(64);
    if (fault === 'over-eight')
      command.imageIds = Array.from({ length: 9 }, (_, i) => `image-${i}`);
    if (fault === 'late-image-change' || fault === 'missing-hold') {
      const data = JSON.parse(readFileSync(f.file, 'utf8'));
      if (fault === 'late-image-change') data.images[2].checksumSha256 = 'b'.repeat(64);
      else
        data.catalogImageObservations = data.catalogImageObservations.filter(
          (row: { imageId?: string; kind?: string }) =>
            !(row.imageId === 'image-0002' && row.kind?.includes('hold')),
        );
      writeFileSync(f.file, JSON.stringify(data));
    }
    const before = readFileSync(f.file, 'utf8');
    const result = await seal.run(command);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(readFileSync(f.file, 'utf8'), before);
  });

async function metadataPageFixture(
  t: { after(fn: () => void): void },
  count = 3,
  now?: () => number,
) {
  const f = await fixture(t, count, false, now);
  for (let n = 0; n < Math.ceil(count / 4); n++)
    assert.ok((await runCatalogPreparationMediaWorker(f.authority, await f.dispatch())).ok);
  const seal = await sealScope(f.adapter, f.authority, f.jobId);
  const command = {
    action: 'attest-media-page' as const,
    ...seal.scope,
    planDigest: seal.planDigest,
    from: seal.bind.mediaSeal,
    imageIds: f.images.map((i) => i._id),
  };
  return { ...f, seal, command };
}
function pageStore(
  file: string,
  beforeRead?: (collection: string, id: string, rows: Record<string, CollectionDoc[]>) => void,
) {
  const rows: Record<string, CollectionDoc[]> = JSON.parse(readFileSync(file, 'utf8'));
  let reads = 0;
  const writes: Array<{ collection: string; row: CollectionDoc }> = [];
  return {
    rows,
    writes,
    reads: () => reads,
    tx: {
      get: async (collection: string, id: string) => {
        reads++;
        beforeRead?.(collection, id, rows);
        return structuredClone(rows[collection]?.find((row) => row._id === id) ?? null);
      },
      set: async (collection: string, row: CollectionDoc) => {
        writes.push({ collection, row: structuredClone(row) });
        rows[collection] ??= [];
        const list = rows[collection];
        const index = list.findIndex((item) => item._id === row._id);
        if (index < 0) list.push(structuredClone(row));
        else list[index] = structuredClone(row);
      },
    },
  };
}
test('eight attested images stay inside the 38-operation native transaction budget', async (t) => {
  const f = await metadataPageFixture(t, 8);
  const store = pageStore(f.file);
  const result = await runCatalogPreparationJob(store.tx, f.authority, f.command);
  assert.ok(result.ok && 'mediaSeal' in result, JSON.stringify(result));
  assert.equal(result.mediaSeal.cursor, 8);
  assert.ok(store.reads() + store.writes.length <= 38);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.collection, 'catalogPreparationJobs');
});
test('expiry during the third image rejects the whole metadata page without writes', async (t) => {
  let clock = Date.now();
  const f = await metadataPageFixture(t, 3, () => clock);
  let changed = false;
  const store = pageStore(f.file, (collection, id, rows) => {
    if (collection === 'images' && id === 'image-0002') {
      const expiresAt = rows.catalogPreparationJobs?.[0]?.leaseExpiresAt;
      assert.equal(typeof expiresAt, 'number');
      clock = Number(expiresAt) + 1;
      changed = true;
    }
  });
  const result = await runCatalogPreparationJob(store.tx, f.authority, f.command, clock);
  assert.equal(changed, true);
  assert.equal(result.ok, false);
  assert.equal(store.writes.length, 0);
  assert.equal(store.rows.catalogPreparationJobs?.[0]?.state, 'running');
});
test('a content change during metadata reads retires the job without a partial seal', async (t) => {
  const f = await metadataPageFixture(t);
  let changed = false;
  const store = pageStore(f.file, (collection, id, rows) => {
    if (collection === 'images' && id === 'image-0002') {
      const product = rows.products?.[0];
      assert.ok(product);
      product.name = 'Concurrent independent edit';
      changed = true;
    }
  });
  const result = await runCatalogPreparationJob(store.tx, f.authority, f.command);
  assert.equal(changed, true);
  assert.deepEqual(result, { ok: false, code: 'STALE' });
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.collection, 'catalogPreparationJobs');
  const job = store.rows.catalogPreparationJobs?.[0];
  assert.ok(job);
  assert.equal(job.state, 'stale');
  assert.deepEqual(job.mediaSeal, f.command.from);
  assert.equal(store.rows.products?.[0]?.published, false);
});
test('a metadata page lost reply replays the exact committed proof after reopening the database', async (t) => {
  const f = await metadataPageFixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const result = await manage(...args);
    if (args[1].action === 'attest-media-page' && !lost) {
      lost = true;
      throw Error('committed page ACK lost');
    }
    return result;
  };
  await assert.rejects(f.seal.run(f.command), /ACK lost/);
  const saved = readFileSync(f.file, 'utf8');
  const reopened = new JsonFileAdapter(f.file);
  const result = await reopened.manageCatalogPreparationJob(f.authority, f.command);
  assert.ok(result.ok && 'mediaSeal' in result, JSON.stringify(result));
  assert.equal(result.mediaSeal.cursor, 3);
  assert.equal(readFileSync(f.file, 'utf8'), saved);
});
test('nine cached images use at most two attestation transactions and keep private references unchanged', async (t) => {
  const f = await cachedPlan(t, 9);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let attestations = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (isMediaAttestation(args[1])) attestations++;
    return manage(...args);
  };
  f.storage.getObjectAsBase64 = async () => {
    throw Error('metadata cannot reread bytes');
  };
  f.storage.putObject = async () => {
    throw Error('metadata cannot rewrite storage');
  };
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
  assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
  assert.equal(attestations, 2);
  for (const image of f.images)
    assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
});

for (const fault of ['serialized-lease', 'foreign-job', 'cancelled-job'] as const)
  test(`a metadata page rejects ${fault} without writes`, async (t) => {
    const f = await metadataPageFixture(t);
    if (fault === 'serialized-lease') f.command.lease = JSON.parse(JSON.stringify(f.command.lease));
    if (fault === 'foreign-job') f.command.jobId = 'f'.repeat(64);
    if (fault === 'cancelled-job') {
      const row = await f.adapter.get('catalogPreparationJobs', f.jobId);
      assert.ok(row && typeof row.leaseVersion === 'number');
      assert.ok(
        (
          await f.seal.run({
            action: 'cancel',
            actorId: 'admin',
            jobId: f.jobId,
            expectedLeaseVersion: row.leaseVersion,
          })
        ).ok,
      );
    }
    const before = readFileSync(f.file, 'utf8');
    const result = await f.seal.run(f.command);
    assert.equal(result.ok, false);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  });

for (const change of ['edit', 'cancel'] as const)
  test(`cached atomic page rechecks ${change} after eight images before its final image`, async (t) => {
    const f = await cachedPlan(t, 9);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let changed = false;
    const prefixes: number[] = [];
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const result = await manage(...args);
      if (args[1].action === 'check-protected-media-page' && result.ok && 'media' in result) {
        prefixes.push(result.media.cursor);
        if (!changed) {
          changed = true;
          if (change === 'edit')
            await f.adapter.update('products', 'second', {
              name: 'Independent edit after atomic page',
            });
          else {
            const job = await f.adapter.get('catalogPreparationJobs', f.shared.jobId);
            assert.ok(job && typeof job.leaseVersion === 'number');
            assert.ok(
              (
                await manage(f.authority, {
                  action: 'cancel',
                  actorId: 'admin',
                  jobId: f.shared.jobId,
                  expectedLeaseVersion: job.leaseVersion,
                })
              ).ok,
            );
          }
        }
      }
      return result;
    };
    const result = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
    assert.equal(changed, true);
    assert.deepEqual(prefixes, [8]);
    assert.equal(result.ok, false);
    const current = await f.adapter.get('products', 'second');
    assert.notEqual(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
    assert.equal(current?.published, false);
    if (change === 'edit') assert.equal(current?.name, 'Independent edit after atomic page');
  });

test('cached metadata pages keep their deletion holds committed before reading any protected image', async (t) => {
  const f = await cachedPlan(t, 9);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let pages = 0;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const command = args[1];
    if (command.action === 'check-protected-media-page') {
      const rows = await f.adapter.list({
        collection: 'catalogImageObservations',
        search: '',
        page: 1,
        pageSize: 100,
        filter: {
          combinator: 'and',
          clauses: [
            { field: 'kind', op: 'eq', value: 'catalog-preparation-image-hold-v1' },
            { field: 'jobId', op: 'eq', value: command.jobId },
          ],
        },
      });
      for (const id of command.imageIds)
        assert.ok(
          rows.items.some((row) => row.imageId === id),
          'A source-only image must be retained before its metadata is read',
        );
      pages++;
    }
    return manage(...args);
  };
  const result = await runCatalogPreparationWorker(f.authority, await f.dispatchCached());
  assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
  assert.equal(pages, 1);
  assert.equal((await f.adapter.get('products', 'second'))?.published, false);
});
