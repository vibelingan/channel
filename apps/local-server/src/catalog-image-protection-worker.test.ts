import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { readCatalogImageStorageProtection } from '@vibelingan-channel/db/catalog-image-protection';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { catalogProtectedStoragePath } from '@vibelingan-channel/shared/catalog-media-protection';
import { readStoredCatalogImageHealth } from '../../functions/admin/src/catalog-image-health.ts';
import { prepareStoredCatalogImage } from '../../functions/admin/src/catalog-image-protection.ts';
import { JsonFileAdapter } from './json-adapter.ts';
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
async function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-protect-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(directory, 'media'));
  setMediaStorage(storage);
  const source = await storage.putObject({
    namespace: 'catalog',
    logicalId: 'image',
    fileName: 'original.png',
    mimeType: 'image/png',
    content: bytes,
  });
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin' }],
      products: [
        { _id: 'p', name: 'Clock', published: false, productFamily: 'misc', imageIds: ['image'] },
      ],
      images: [
        {
          _id: 'image',
          ...source,
          status: 'active',
          mimeType: 'image/png',
          byteSize: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          publishedRefCount: 0,
        },
      ],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const authority = createCatalogPreparationAuthority({
    secret: 'protect-worker-test',
    environmentId: 'local',
  });
  const run = (command: Parameters<typeof adapter.manageCatalogPreparationJob>[1]) =>
    adapter.manageCatalogPreparationJob(authority, command);
  const s = await run({ action: 'start', actorId: 'admin', productId: 'p' });
  assert.ok(s.ok && 'progress' in s);
  const jobId = s.progress.jobId;
  const d = await run({ action: 'dispatch', actorId: 'admin', jobId });
  assert.ok(d.ok && 'call' in d);
  const c = await run({ action: 'claim', call: d.call, owner: 'worker' });
  assert.ok(c.ok && 'lease' in c);
  const prepare = () =>
    prepareStoredCatalogImage(authority, { jobId, lease: c.lease, imageId: 'image' });
  return {
    directory,
    source,
    file,
    adapter,
    storage,
    run,
    prepare,
    jobId,
    lease: c.lease,
    authority,
  };
}
test('default file copy -> registered target -> native readback -> protected pointer keeps product and original bytes', async (t) => {
  const f = await fixture(t);
  const before = await f.adapter.get('products', 'p');
  const result = await f.prepare();
  assert.equal(result.health.status, 'verified');
  const image = await f.adapter.get('images', 'image');
  assert.ok(image);
  assert.ok(readCatalogImageStorageProtection(image));
  assert.notEqual(image.storageFileId, f.source.storageFileId);
  assert.equal(image.imageMutationOwner, '');
  assert.deepEqual(await readStoredCatalogImageHealth('image'), result.health);
  assert.equal(
    result.imageInputDigest,
    result.health.status === 'verified' ? result.health.inputDigest : null,
  );
  assert.deepEqual(await f.adapter.get('products', 'p'), before);
  assert.equal(
    Buffer.from((await f.storage.getObjectAsBase64(f.source.storageFileId)).body, 'base64').equals(
      bytes,
    ),
    true,
  );
  assert.ok(typeof image.storageFileId === 'string');
  assert.equal(
    Buffer.from((await f.storage.getObjectAsBase64(image.storageFileId)).body, 'base64').equals(
      bytes,
    ),
    true,
  );
  const reopened = new JsonFileAdapter(f.file);
  assert.deepEqual(await reopened.get('images', 'image'), image);
});
test('repeated default preparation reuses the protected target without another PUT or journal', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.prepare()).health.status, 'verified');
  const before = readFileSync(f.file, 'utf8');
  f.storage.putObject = async () => {
    throw Error('must not copy twice');
  };
  assert.equal((await f.prepare()).health.status, 'verified');
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
test('lost PUT acknowledgement resumes registered bytes without another PUT', async (t) => {
  const f = await fixture(t);
  const original = f.storage.putObject.bind(f.storage);
  let writes = 0;
  f.storage.putObject = async (...args) => {
    writes++;
    await original(...args);
    throw Error('lost PUT ack');
  };
  const first = await f.prepare();
  assert.equal(first.health.status, 'retry');
  assert.equal((await f.adapter.get('images', 'image'))?.storageFileId, f.source.storageFileId);
  f.storage.putObject = async () => {
    throw Error('registered object must be recovered');
  };
  const next = await f.prepare();
  assert.equal(next.health.status, 'verified');
  assert.equal(writes, 1);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
  assert.equal(rows.catalogImageObservations[0].state, 'committed');
});
test('checkpoint failure sends no bytes and releases the owned image lock', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    if (c.action === 'checkpoint-image-protection') throw Error('checkpoint fault');
    return manage(a, c, n);
  };
  const result = await f.prepare();
  assert.equal(result.health.status, 'retry');
  const image = await f.adapter.get('images', 'image');
  assert.equal(image?.storageFileId, f.source.storageFileId);
  assert.equal(image?.imageMutationOwner, '');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations[0].state, 'reserved');
  const i = rows.catalogImageObservations[0];
  const path = catalogProtectedStoragePath(
    `${i.imageIdentity}:${i.checksumSha256}:${i.attemptId}`,
    'original.png',
  );
  await assert.rejects(f.storage.getObjectAsBase64(`local-disk:${path}`));
  f.adapter.manageCatalogPreparationJob = manage;
  assert.equal((await f.prepare()).health.status, 'verified');
});
test('lost commit acknowledgement is recovered from the current committed marker', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = true;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (c.action === 'commit-image-protection' && lost) {
      lost = false;
      throw Error('lost commit ack');
    }
    return r;
  };
  const result = await f.prepare();
  assert.equal(result.health.status, 'verified');
  assert.ok(readCatalogImageStorageProtection(await f.adapter.get('images', 'image')));
  assert.equal((await f.adapter.get('products', 'p'))?.published, false);
});
test('cancellation after checkpoint preserves original pointer and allows exact lock cleanup', async (t) => {
  const f = await fixture(t);
  const original = f.storage.putObject.bind(f.storage);
  f.storage.putObject = async (input, options) =>
    original(input, {
      beforeWrite: async (target) => {
        await options?.beforeWrite?.(target);
        await f.run({
          action: 'cancel',
          actorId: 'admin',
          jobId: f.jobId,
          expectedLeaseVersion: 1,
        });
      },
    });
  const result = await f.prepare();
  assert.equal(result.health.status, 'retry');
  const image = await f.adapter.get('images', 'image');
  assert.equal(image?.storageFileId, f.source.storageFileId);
  assert.equal(image?.imageMutationOwner, '');
  assert.equal(image?.catalogStorageProtection, undefined);
});

test('lost begin acknowledgement releases the recovered owned lock and retains one attempt', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = true;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (c.action === 'begin-image-protection' && lost) {
      lost = false;
      throw Error('lost begin ack');
    }
    return r;
  };
  const first = await f.prepare();
  assert.equal(first.health.status, 'retry');
  assert.equal((await f.adapter.get('images', 'image'))?.imageMutationOwner, '');
  assert.equal((await f.prepare()).health.status, 'verified');
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(rows.catalogImageObservations.length, 1);
});
for (const fault of ['false', 'throw'] as const)
  test(`cleanup ${fault} cannot report successful image preparation`, async (t) => {
    const f = await fixture(t);
    const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
    f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
      if (c.action === 'release-image-protection') {
        if (fault === 'throw') throw Error('cleanup failure');
        return { ok: false, code: 'CONFLICT' };
      }
      return manage(a, c, n);
    };
    assert.equal((await f.prepare()).health.status, 'retry');
    assert.ok(readCatalogImageStorageProtection(await f.adapter.get('images', 'image')));
  });
test('different bytes read back from the physical target never replace the original image pointer', async (t) => {
  const f = await fixture(t);
  const put = f.storage.putObject.bind(f.storage);
  f.storage.putObject = async (...args) => {
    const target = await put(...args);
    writeFileSync(
      join(f.directory, 'media', target.storagePath),
      Buffer.from('different target bytes'),
    );
    return target;
  };
  const result = await f.prepare();
  assert.deepEqual(result.health, { status: 'retry', reason: 'unavailable' });
  assert.equal((await f.adapter.get('images', 'image'))?.storageFileId, f.source.storageFileId);
  assert.equal((await f.adapter.get('images', 'image'))?.imageMutationOwner, '');
});

test('source pointer replacement during the actual read returns retry changed and never commits the stale target', async (t) => {
  const f = await fixture(t);
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  let replaced = false;
  f.storage.getObjectAsBase64 = async (...args) => {
    const result = await read(...args);
    if (!replaced && args[0] === f.source.storageFileId) {
      replaced = true;
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.images[0].storageFileId = 'local-disk:replacement.png';
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return result;
  };
  const result = await f.prepare();
  assert.deepEqual(result.health, { status: 'retry', reason: 'changed' });
  const image = await f.adapter.get('images', 'image');
  assert.equal(image?.storageFileId, 'local-disk:replacement.png');
  assert.equal(image?.catalogStorageProtection, undefined);
  assert.equal(image?.imageMutationOwner, '');
});
test('invalid existing metadata retains its exact observation digest and writes no object or reservation', async (t) => {
  const f = await fixture(t);
  const rows = JSON.parse(readFileSync(f.file, 'utf8'));
  rows.images[0].byteSize = 0;
  writeFileSync(f.file, JSON.stringify(rows));
  f.storage.putObject = async () => {
    throw Error('invalid metadata must not write');
  };
  const result = await f.prepare();
  assert.deepEqual(result.health, { status: 'invalid', reason: 'record' });
  assert.match(result.imageInputDigest ?? '', /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations, undefined);
});

test('a foreign owner replacing the lock before the source read causes zero byte reads and no PUT', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (c.action === 'begin-image-protection') {
      const rows = JSON.parse(readFileSync(f.file, 'utf8'));
      rows.images[0].imageMutationOwner = 'foreign-owner';
      writeFileSync(f.file, JSON.stringify(rows));
    }
    return r;
  };
  let reads = 0;
  const read = f.storage.getObjectAsBase64.bind(f.storage);
  f.storage.getObjectAsBase64 = async (...args) => {
    reads++;
    return read(...args);
  };
  f.storage.putObject = async () => {
    throw Error('foreign owner must prevent PUT');
  };
  const result = await f.prepare();
  assert.equal(result.health.status, 'retry');
  assert.equal(reads, 0);
  assert.equal((await f.adapter.get('images', 'image'))?.imageMutationOwner, 'foreign-owner');
  assert.equal((await f.adapter.get('images', 'image'))?.storageFileId, f.source.storageFileId);
});
test('a mismatched PUT acknowledgement retains the registered target for a later recovery', async (t) => {
  const f = await fixture(t);
  const put = f.storage.putObject.bind(f.storage);
  f.storage.putObject = async (...args) => {
    const r = await put(...args);
    return { ...r, storageFileId: 'local-disk:foreign-ack.png' };
  };
  assert.equal((await f.prepare()).health.status, 'retry');
  assert.equal((await f.adapter.get('images', 'image'))?.storageFileId, f.source.storageFileId);
  f.storage.putObject = async () => {
    throw Error('recover the registered actual target');
  };
  assert.equal((await f.prepare()).health.status, 'verified');
});

test('lost checkpoint acknowledgement writes no bytes and resumes the same registered target', async (t) => {
  const f = await fixture(t);
  const manage = f.adapter.manageCatalogPreparationJob.bind(f.adapter);
  let lost = true;
  f.adapter.manageCatalogPreparationJob = async (a, c, n) => {
    const r = await manage(a, c, n);
    if (c.action === 'checkpoint-image-protection' && lost) {
      lost = false;
      throw Error('lost checkpoint ack');
    }
    return r;
  };
  assert.equal((await f.prepare()).health.status, 'retry');
  const first = JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations[0];
  assert.equal(first.state, 'targeted');
  await assert.rejects(f.storage.getObjectAsBase64(first.target.storageFileId));
  assert.equal((await f.prepare()).health.status, 'verified');
  const last = JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations[0];
  assert.equal(last._id, first._id);
  assert.equal(last.attemptId, first.attemptId);
  assert.deepEqual(last.target, first.target);
  assert.equal(last.state, 'committed');
});
test('altered source bytes with unchanged metadata fail checksum before any target is written', async (t) => {
  const f = await fixture(t);
  const changed = Buffer.from(bytes);
  changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 0xff;
  writeFileSync(join(f.directory, 'media', f.source.storagePath), changed);
  f.storage.putObject = async () => {
    throw Error('bad source bytes must not PUT');
  };
  const result = await f.prepare();
  assert.deepEqual(result.health, { status: 'invalid', reason: 'checksum' });
  assert.equal((await f.adapter.get('images', 'image'))?.storageFileId, f.source.storageFileId);
  assert.equal((await f.adapter.get('images', 'image'))?.imageMutationOwner, '');
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).catalogImageObservations[0].target, null);
});
