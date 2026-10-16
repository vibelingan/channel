import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sourceMediaLinkId } from '@vibelingan-channel/catalog-import/observations';
import { setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import { runCatalogPreparationWorker } from '../../functions/admin/src/catalog-preparation-worker.ts';
import { fixture as sourceFixture } from '../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
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
  assert.equal(rows.catalogImageObservations.length, 9);
  for (const row of rows.catalogImageObservations) {
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
  assert.equal(rows.catalogImageObservations, undefined);
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
  assert.equal(rows.catalogImageObservations, undefined);
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
  return { ...f, adapter, dispatch, productId: h.product._id, url };
}
test('105 source configurations retain the full plan with metadata reads only for four processed images', async (t) => {
  const f = await sourceWorkspace(t);
  let imageReads = 0;
  let batches = 0;
  const get = f.adapter.get.bind(f.adapter);
  const list = f.adapter.list.bind(f.adapter);
  f.adapter.get = async (c, id) => {
    if (c === 'images') imageReads++;
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
  assert.equal(imageReads, 12);
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
  const stored = JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations[0];
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
