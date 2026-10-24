import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCurrentCatalogPreparation } from '@vibelingan-channel/shared/catalog-preparation';
import { z } from 'zod';
import { signSession } from '../../../../../packages/auth/src/jwt.ts';
import { createCatalogPreparationAuthority } from '../../../../../packages/db/src/catalog-preparation-authority.ts';
import { readCatalogPreparationJob } from '../../../../../packages/db/src/catalog-preparation-jobs.ts';
import { setAdapter } from '../../../../../packages/db/src/index.ts';
import { setMediaStorage } from '../../../../../packages/media-storage/src/index.ts';
import { LocalDiskMediaStorage } from '../../../../../packages/media-storage/src/local-disk.ts';
import { handleAdminRequest } from '../../../../functions/admin/src/handler.ts';
import { handleAdminFunctionEvent } from '../../../../functions/admin/src/http-adapter.ts';
import { runCatalogPreparationCall } from '../../../../functions/alibaba-catalog-sync/src/catalog-preparation.ts';
import { createLocalCatalogPreparationInvoker } from '../../../../local-server/src/catalog-preparation-invoker.ts';
import { JsonFileAdapter } from '../../../../local-server/src/json-adapter.ts';
import { AdminApiError } from './api.ts';
import { runPreparation } from './catalog-preparation-api.ts';

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
for (const [count, steps] of [
  [9, 3],
  [27, 8],
] as const)
  test(`actual ${count}-image preparation finishes within ${steps} bounded calls without publishing`, async (t) => {
    const f = await fixture(t, count);
    const original = await f.adapter.get('products', 'p');
    let result: Awaited<ReturnType<typeof runCatalogPreparationCall>> | undefined;
    let calls = 0;
    for (; calls < steps; calls++) {
      result = await runCatalogPreparationCall(f.authority, await f.dispatch());
      assert.ok(result.ok, JSON.stringify(result));
      if (result.outcome === 'ready') {
        calls++;
        break;
      }
    }
    assert.equal(result?.ok && result.outcome, 'ready');
    assert.equal(calls, steps);
    const current = await f.adapter.get('products', 'p');
    const report = readCurrentCatalogPreparation(current ?? {});
    assert.equal(report?.state, 'ready');
    assert.equal(report?.state === 'ready' && report.seal.imageCount, count);
    assert.equal(current?.published, false);
    assert.deepEqual(current?.imageIds, original?.imageIds);
    assert.equal(current?.productFamily, original?.productFamily);
    for (const image of f.images)
      assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  });

for (const change of ['edit', 'cancel'] as const)
  test(`paged attestation rechecks ${change} before the last page and cannot commit stale ready`, async (t) => {
    const f = await fixture(t, 9);
    for (let i = 0; i < 2; i++)
      assert.ok((await runCatalogPreparationCall(f.authority, await f.dispatch())).ok);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    const indices: number[] = [];
    let changed = false;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const command = args[1];
      if (command.action === 'attest-media-page' || command.action === 'attest-media-image') {
        const index = command.action === 'attest-media-page' ? command.from.cursor : command.index;
        indices.push(index);
        if (index === 8 && !changed) {
          changed = true;
          if (change === 'edit')
            await f.adapter.update('products', 'p', { name: 'New independent edit' });
          else {
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
        }
      }
      return manage(...args);
    };
    try {
      const result = await runCatalogPreparationCall(f.authority, await f.dispatch());
      assert.equal(changed, true);
      assert.equal(result.ok, false);
      assert.deepEqual(indices, [0, 8]);
      const current = await f.adapter.get('products', 'p');
      assert.notEqual(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
      assert.equal(current?.published, false);
      if (change === 'edit') assert.equal(current?.name, 'New independent edit');
    } finally {
      f.adapter.manageCatalogPreparationJob = manage;
    }
  });

for (const change of ['none', 'edit', 'cancel', 'revoke'] as const) {
  test(`browser coordinator uses actual authenticated HTTP/native PNG progress after a lost worker reply: ${change}`, async (t) => {
    const f = await fixture(t, 9);
    const original = await f.adapter.get('products', 'p');
    const pending: ReturnType<typeof runCatalogPreparationCall>[] = [];
    let changed = false;
    const config = {
      jwtSecret: 'durable-browser-local-session',
      enableDetailApproval: true,
      preparationAuthority: f.authority,
      preparationInvoke: createLocalCatalogPreparationInvoker((call) => {
        const work = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return runCatalogPreparationCall(f.authority, call);
        })();
        pending.push(work);
        return work;
      }, 1),
    };
    const token = await signSession(config.jwtSecret, {
      sub: 'admin',
      email: 'admin@example.test',
      name: 'Admin',
      role: 'admin',
    });
    const actions: string[] = [];
    try {
      const result = await runPreparation(
        { productId: 'p', jobId: f.jobId },
        {
          request: async (command, signal) => {
            signal.throwIfAborted();
            actions.push(command.action);
            const response = await handleAdminFunctionEvent(
              {
                httpMethod: 'POST',
                headers: {},
                body: JSON.stringify({ action: 'catalogPreparation', token, data: command }),
              },
              config,
              handleAdminRequest,
            );
            assert.ok('statusCode' in response);
            const envelope = z
              .union([
                z.object({ ok: z.literal(true), data: z.unknown() }),
                z.object({
                  ok: z.literal(false),
                  error: z.object({ code: z.string(), message: z.string() }),
                }),
              ])
              .parse(JSON.parse(response.body));
            if (!envelope.ok) throw new AdminApiError(envelope.error.code, envelope.error.message);
            assert.equal(response.statusCode, 200);
            return envelope.data;
          },
          wait: async (_ms, signal) => {
            await Promise.allSettled(pending);
            signal.throwIfAborted();
            setAdapter(new JsonFileAdapter(f.file));
            if (changed) return;
            changed = true;
            if (change === 'edit')
              await f.adapter.update('products', 'p', { name: 'Concurrent edit' });
            if (change === 'revoke')
              await f.adapter.update('users', 'admin', { status: 'suspended' });
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
          },
        },
      );
      if (change === 'none') {
        assert.equal(result.reason, 'ready');
        assert.equal(result.status?.progress.media?.verified, 9);
        assert.equal(result.status?.attestation?.checked, 9);
        assert.ok(actions.filter((action) => action === 'continue').length >= 3);
        const current = await f.adapter.get('products', 'p');
        assert.equal(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
        assert.deepEqual(current?.imageIds, original?.imageIds);
        assert.equal(current?.productFamily, original?.productFamily);
      } else {
        assert.equal(result.reason, 'needs-action');
        assert.equal(actions.filter((action) => action === 'continue').length, 1);
      }
      assert.equal(result.jobId, f.jobId);
      assert.equal((await f.adapter.get('products', 'p'))?.published, false);
      assert.ok(!actions.includes('start'));
    } finally {
      await Promise.allSettled(pending);
    }
  });
}

test('actual persisted attestation pages keep the same running lease readable until ready', async (t) => {
  const f = await fixture(t, 9);
  const original = await f.adapter.get('products', 'p');
  for (let i = 0; i < 2; i++)
    assert.ok((await runCatalogPreparationCall(f.authority, await f.dispatch())).ok);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  const gates: { index: number; release: () => void }[] = [];
  const pending: ReturnType<typeof runCatalogPreparationCall>[] = [];
  let draining = false;
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    const value = await manage(...args);
    const command = args[1];
    if (
      (command.action === 'attest-media-page' || command.action === 'attest-media-image') &&
      value.ok &&
      !draining
    )
      await new Promise<void>((release) => {
        gates.push({
          index: command.action === 'attest-media-page' ? command.from.cursor : command.index,
          release,
        });
      });
    return value;
  };
  const config = {
    jwtSecret: 'progress-browser-local-session',
    enableDetailApproval: true,
    preparationAuthority: f.authority,
    preparationInvoke: createLocalCatalogPreparationInvoker((call) => {
      const work = runCatalogPreparationCall(f.authority, call);
      pending.push(work);
      return work;
    }, 1),
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'admin',
  });
  const actions: string[] = [];
  const progress: { checked: number; lease: number }[] = [];
  let released = 0;
  let observedFirstPage = false;
  const gateAt = async (index: number) => {
    const deadline = performance.now() + 5000;
    while (!gates[index]) {
      assert.ok(performance.now() < deadline, `worker did not persist attestation ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(gates[index].index, [0, 8][index]);
    return gates[index];
  };
  try {
    const result = await runPreparation(
      { productId: 'p', jobId: f.jobId },
      {
        request: async (command, signal) => {
          signal.throwIfAborted();
          actions.push(command.action);
          const response = await handleAdminFunctionEvent(
            {
              httpMethod: 'POST',
              headers: {},
              body: JSON.stringify({ action: 'catalogPreparation', token, data: command }),
            },
            config,
            handleAdminRequest,
          );
          assert.ok('statusCode' in response);
          const envelope = z
            .union([
              z.object({ ok: z.literal(true), data: z.unknown() }),
              z.object({
                ok: z.literal(false),
                error: z.object({ code: z.string(), message: z.string() }),
              }),
            ])
            .parse(JSON.parse(response.body));
          if (!envelope.ok) throw new AdminApiError(envelope.error.code, envelope.error.message);
          assert.equal(response.statusCode, 200);
          return envelope.data;
        },
        wait: async (_ms, signal) => {
          signal.throwIfAborted();
          if (!observedFirstPage) {
            observedFirstPage = true;
            await gateAt(0);
            return;
          }
          (await gateAt(released++)).release();
          if (released < 2) await gateAt(released);
          else await Promise.all(pending);
        },
        onProgress: ({ status }) => {
          if (status?.progress.state === 'running' && status.attestation)
            progress.push({
              checked: status.attestation.checked,
              lease: status.progress.leaseVersion,
            });
        },
      },
    );
    assert.equal(result.reason, 'ready');
    assert.equal(result.jobId, f.jobId);
    assert.equal(result.status?.attestation?.checked, 9);
    assert.ok(progress.some((p) => p.checked === 8));
    assert.ok(progress.some((p) => p.checked === 9));
    assert.ok(progress.every((p, i) => i === 0 || p.checked >= (progress[i - 1]?.checked ?? 0)));
    assert.equal(new Set(progress.map((p) => p.lease)).size, 1);
    assert.equal(actions.filter((action) => action === 'continue').length, 1);
    assert.ok(actions.filter((action) => action === 'status').length >= 2);
    assert.ok(!actions.includes('start'));
    const current = await f.adapter.get('products', 'p');
    assert.equal(readCurrentCatalogPreparation(current ?? {})?.state, 'ready');
    assert.equal(current?.published, false);
    assert.deepEqual(current?.imageIds, original?.imageIds);
    assert.equal(current?.productFamily, original?.productFamily);
    for (const image of f.images)
      assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  } finally {
    draining = true;
    for (const gate of gates) gate.release();
    await Promise.allSettled(pending);
    f.adapter.manageCatalogPreparationJob = manage;
  }
});

test('real protected PNGs recheck an edited 27-image product in bounded metadata pages without reading bytes again', async (t) => {
  const f = await fixture(t, 27);
  for (let i = 0; i < 8; i++)
    assert.ok((await runCatalogPreparationCall(f.authority, await f.dispatch())).ok);
  assert.equal(
    readCurrentCatalogPreparation((await f.adapter.get('products', 'p')) ?? {})?.state,
    'ready',
  );
  await f.adapter.update('products', 'p', { description: 'Independent edited description' });
  const started = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  assert.ok(started.ok && 'progress' in started);
  const jobId = started.progress.jobId;
  let byteReads = 0;
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    byteReads++;
    return read(...args);
  };
  const pages: number[] = [];
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (...args) => {
    if (args[1].action === 'check-protected-media-page') pages.push(args[1].imageIds.length);
    return manage(...args);
  };
  const progress: number[] = [];
  for (let i = 0; i < 3; i++) {
    const dispatched = await manage(f.authority, { action: 'dispatch', actorId: 'admin', jobId });
    assert.ok(dispatched.ok && 'call' in dispatched);
    const result = await runCatalogPreparationCall(f.authority, dispatched.call);
    assert.ok(result.ok, JSON.stringify(result));
    progress.push(result.media.checked);
  }
  assert.deepEqual(progress, [16, 27, 27]);
  assert.deepEqual(pages, [8, 8, 8, 3]);
  assert.equal(byteReads, 0);
  const product = await f.adapter.get('products', 'p');
  assert.equal(product?.description, 'Independent edited description');
  assert.equal(product?.published, false);
  assert.equal(readCurrentCatalogPreparation(product ?? {})?.state, 'ready');
  for (const image of f.images)
    assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
});

test('a missing protected pixel receipt falls back to the original real-byte check and still finishes the edited product', async (t) => {
  const f = await fixture(t, 9);
  for (let i = 0; i < 3; i++)
    assert.ok((await runCatalogPreparationCall(f.authority, await f.dispatch())).ok);
  const observations = await f.adapter.list({
    collection: 'catalogImageObservations',
    search: '',
    page: 1,
    pageSize: 100,
  });
  const receipt = observations.items.find(
    (row) => row.kind === 'catalog-protected-image-health-v1',
  );
  assert.ok(receipt);
  await f.adapter.remove('catalogImageObservations', receipt._id);
  await f.adapter.update('products', 'p', { description: 'Edited after cache removal' });
  const started = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'start',
    actorId: 'admin',
    productId: 'p',
  });
  assert.ok(started.ok && 'progress' in started);
  const dispatched = await f.adapter.manageCatalogPreparationJob(f.authority, {
    action: 'dispatch',
    actorId: 'admin',
    jobId: started.progress.jobId,
  });
  assert.ok(dispatched.ok && 'call' in dispatched);
  let byteReads = 0;
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    byteReads++;
    return read(...args);
  };
  const result = await runCatalogPreparationCall(f.authority, dispatched.call);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.outcome, 'ready');
  assert.equal(byteReads, 1);
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});

for (const fault of ['none', 'before-commit', 'after-commit'] as const)
  test(`a small live-edit preparation revalidates its old image set and recovers ${fault} reply loss`, async (t) => {
    const f = await fixture(t, 9);
    for (let i = 0; i < 3; i++)
      assert.ok((await runCatalogPreparationCall(f.authority, await f.dispatch())).ok);
    const previous = readCurrentCatalogPreparation((await f.adapter.get('products', 'p')) ?? {});
    assert.ok(previous && previous.state === 'ready');
    await f.adapter.update('products', 'p', {
      description: 'Current edited text, original protected images',
    });
    const started = await f.adapter.manageCatalogPreparationJob(f.authority, {
      action: 'start',
      actorId: 'admin',
      productId: 'p',
    });
    assert.ok(started.ok && 'progress' in started);
    const dispatched = await f.adapter.manageCatalogPreparationJob(f.authority, {
      action: 'dispatch',
      actorId: 'admin',
      jobId: started.progress.jobId,
    });
    assert.ok(dispatched.ok && 'call' in dispatched);
    const calls: string[] = [];
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    let injected = false;
    f.adapter.manageCatalogPreparationJob = async (...args) => {
      const action = args[1].action;
      calls.push(action);
      const fail = action === 'finish-protected-preparation' && !injected && fault !== 'none';
      if (fail) injected = true;
      if (fail && fault === 'before-commit') throw Error('Transient native request failure');
      const result = await manage(...args);
      if (fail && fault === 'after-commit') throw Error('Lost successful finish response');
      return result;
    };
    f.storage.getObjectAsBase64 = async () => {
      throw Error('No second byte read is needed for these protected targets');
    };
    f.storage.putObject = async () => {
      throw Error('No second physical copy is needed');
    };
    const result = await runCatalogPreparationCall(f.authority, dispatched.call);
    assert.ok(result.ok && result.outcome === 'ready', JSON.stringify(result));
    assert.equal(
      calls.filter((action) => action === 'finish-protected-preparation').length,
      fault === 'none' ? 1 : 2,
    );
    assert.equal(injected, fault !== 'none');
    assert.equal(
      calls.some((action) =>
        ['bind-media-plan', 'bind-media-seal', 'attest-media-page', 'finish-preparation'].includes(
          action,
        ),
      ),
      false,
      'One native metadata snapshot must replace these separate transactions, retaining their original checks',
    );
    const current = await f.adapter.get('products', 'p');
    const report = readCurrentCatalogPreparation(current ?? {});
    assert.ok(report && report.state === 'ready');
    assert.equal(report.seal.jobId, started.progress.jobId);
    assert.notEqual(report.seal.jobId, previous.seal.jobId);
    assert.ok(report.contentGeneration > previous.contentGeneration);
    assert.equal(current?.published, false);
    assert.equal(current?.description, 'Current edited text, original protected images');
    for (const image of f.images)
      assert.equal((await f.adapter.get('images', image._id))?.publishedRefCount, 0);
  });
