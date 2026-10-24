import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setAdapter } from '@vibelingan-channel/db';
import { MediaReadError, setMediaStorage } from '@vibelingan-channel/media-storage';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { CATALOG_IMAGE_MAX_BYTES } from '@vibelingan-channel/shared';
import { readStoredCatalogImageBytes } from './catalog-image-bytes.ts';
import { ReadPlanAdapter } from './testing/catalog-source-plan-fixture.ts';

const now = Date.parse('2026-10-15T04:00:00.000Z');
const bytes = Buffer.from('ffd8ffdb00040000ffd9', 'hex');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  let image: CollectionDoc | null = {
    _id: 'image',
    status: 'active',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://opaque/Case%2f ID ',
    storagePath: 'catalog/original.jpg',
    mimeType: 'image/jpeg',
    byteSize: bytes.length,
    checksumSha256: hash(bytes),
    publishedRefCount: 0,
  };
  let body = bytes.toString('base64');
  let reads = 0;
  let hint = bytes.length;
  let afterRead: (() => void) | null = null;
  let unavailable = false;
  const targetIds: string[] = [];
  const run = () =>
    readStoredCatalogImageBytes('image', {
      getImage: async () => structuredClone(image),
      readObject: async (fileId) => {
        reads++;
        targetIds.push(fileId);
        if (unavailable) throw new Error('private signed URL and secret must never reach response');
        afterRead?.();
        return { body, byteSize: hint };
      },
      now: () => now,
    });
  return {
    run,
    targetIds,
    get reads() {
      return reads;
    },
    get image() {
      return image;
    },
    set image(value) {
      image = value;
    },
    set body(value: string) {
      body = value;
    },
    set hint(value: number) {
      hint = value;
    },
    set afterRead(value: (() => void) | null) {
      afterRead = value;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
  };
}
test('stored bytes bind the exact opaque file id and current input without exposing private bytes', async () => {
  const f = fixture();
  const before = structuredClone(f.image);
  const result = await f.run();
  assert.equal(result.status, 'verified');
  if (result.status !== 'verified') return;
  assert.equal(result.kind, 'stored-image-byte-check-v1');
  assert.equal(result.imageId, 'image');
  assert.equal(result.byteSize, bytes.length);
  assert.equal(result.checksumSha256, hash(bytes));
  assert.match(result.inputDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.targetIds, [before?.storageFileId]);
  assert.equal(JSON.stringify(result).includes('cloud://'), false);
  assert.equal(JSON.stringify(result).includes(bytes.toString('base64')), false);
  assert.deepEqual(f.image, before);
});
test('adapter size hints cannot hide an actual body size mismatch', async () => {
  const f = fixture();
  f.hint = 1;
  f.body = Buffer.concat([bytes, bytes]).toString('base64');
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'size' });
});
test('a wrong size hint does not reject intact actual bytes', async () => {
  const f = fixture();
  f.hint = -1;
  assert.equal((await f.run()).status, 'verified');
});
for (const body of ['', '***=', 'YQ', 'YQ===', 'AB==', 'AA=A', 'AAAA\n'])
  test(`invalid or noncanonical base64 cannot become verified: ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    f.body = body;
    assert.deepEqual(await f.run(), {
      status: 'invalid',
      reason: body === '' ? 'size' : 'content',
    });
  });
test('a checksum mismatch is distinct from a missing object', async () => {
  const f = fixture();
  const changed = Buffer.from(bytes);
  changed[6] = 1;
  f.body = changed.toString('base64');
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'checksum' });
});
test('unreadable storage is retryable and does not disclose the SDK exception', async () => {
  const f = fixture();
  f.unavailable = true;
  assert.deepEqual(await f.run(), { status: 'retry', reason: 'unavailable' });
  assert.equal(f.reads, 1);
  assert.equal(f.image?.status, 'active');
});
for (const patch of [
  { _id: 'foreign' },
  { status: 'deleted' },
  { storageProvider: 'unknown' },
  { storageFileId: '' },
  { storageFileId: ['cloud://not-a-string'] },
  { byteSize: 0 },
  { byteSize: CATALOG_IMAGE_MAX_BYTES + 1 },
  { byteSize: '10' },
  { checksumSha256: 'x' },
  { checksumSha256: undefined },
  { mimeType: undefined },
  { storageMode: 'local-disk' },
  { storageMode: ['classic-nosql-storage'] },
  { storagePath: ['wrong-path'] },
  { data: 'inline-would-take-precedence' },
  { mimeType: 'text/html' },
  { publishedRefCount: '1' },
  { publishedRefCount: -1 },
  { imageMutationOwner: 'broken' },
  { imageMutationOwner: 'old', imageMutationStartedAt: new Date(now - 3600000).toISOString() },
])
  test(`invalid stored metadata is rejected before a download: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    assert.ok(f.image);
    Object.assign(f.image, patch);
    assert.deepEqual(await f.run(), { status: 'invalid', reason: 'record' });
    assert.equal(f.reads, 0);
  });
test('missing images do not trigger a download', async () => {
  const f = fixture();
  f.image = null;
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'record' });
  assert.equal(f.reads, 0);
});
test('a live deletion or finalization lock postpones verification', async () => {
  const f = fixture();
  assert.ok(f.image);
  f.image.imageMutationOwner = 'owner';
  f.image.imageMutationStartedAt = new Date(now - 1000).toISOString();
  assert.deepEqual(await f.run(), { status: 'retry', reason: 'busy' });
  assert.equal(f.reads, 0);
});
for (const field of [
  '_id',
  'status',
  'storageProvider',
  'storageMode',
  'storageFileId',
  'storagePath',
  'mimeType',
  'byteSize',
  'checksumSha256',
] as const)
  test(`a changed stored target or content invalidates the observation: ${field}`, async () => {
    const f = fixture();
    f.afterRead = () => {
      assert.ok(f.image);
      Reflect.set(f.image, field, field === 'byteSize' ? 11 : 'changed');
    };
    assert.deepEqual(await f.run(), { status: 'retry', reason: 'changed' });
  });
test('a disappeared record invalidates a successful byte read', async () => {
  const f = fixture();
  f.afterRead = () => {
    f.image = null;
  };
  assert.deepEqual(await f.run(), { status: 'retry', reason: 'changed' });
});
test('a new image mutex prevents sealing a prior unlocked read', async () => {
  const f = fixture();
  f.afterRead = () => {
    assert.ok(f.image);
    f.image.imageMutationOwner = 'owner';
    f.image.imageMutationStartedAt = new Date(now - 1000).toISOString();
  };
  assert.deepEqual(await f.run(), { status: 'retry', reason: 'busy' });
});
test('reference count changes do not change image byte identity', async () => {
  const f = fixture();
  const before = await f.run();
  f.afterRead = () => {
    assert.ok(f.image);
    f.image.publishedRefCount = 17;
  };
  assert.deepEqual(await f.run(), before);
});
test('a corrupt counter after the download is still rejected', async () => {
  const f = fixture();
  f.afterRead = () => {
    assert.ok(f.image);
    f.image.publishedRefCount = '17';
  };
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'record' });
});
test('a legacy absent counter is compatible', async () => {
  const f = fixture();
  assert.ok(f.image);
  Reflect.deleteProperty(f.image, 'publishedRefCount');
  assert.equal((await f.run()).status, 'verified');
});
test('declared image MIME must match the actual signature even if the checksum matches', async () => {
  const f = fixture();
  assert.ok(f.image);
  f.image.mimeType = 'image/png';
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'content' });
});
test('catalog byte checks reject non-image magic bytes', async () => {
  const f = fixture();
  const pdf = Buffer.from('%PDF-12345');
  assert.ok(f.image);
  f.image.byteSize = pdf.length;
  f.image.checksumSha256 = hash(pdf);
  f.body = pdf.toString('base64');
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'content' });
});
test('checks use the actual catalog byte cap', async () => {
  const f = fixture();
  const oversized = Buffer.alloc(CATALOG_IMAGE_MAX_BYTES + 1);
  bytes.copy(oversized);
  f.body = oversized.toString('base64');
  assert.deepEqual(await f.run(), { status: 'invalid', reason: 'size' });
});

for (const body of ['', '****', Buffer.concat([bytes, bytes]).toString('base64')])
  test(`a changed pointer takes precedence over an old byte failure: ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    f.body = body;
    f.afterRead = () => {
      assert.ok(f.image);
      f.image.storageFileId = 'cloud://replacement';
    };
    assert.deepEqual(await f.run(), { status: 'retry', reason: 'changed' });
  });
test('storage read failures still recheck whether the target changed', async () => {
  const f = fixture();
  let calls = 0;
  assert.deepEqual(
    await readStoredCatalogImageBytes('image', {
      getImage: async () => {
        calls++;
        const image = structuredClone(f.image);
        assert.ok(image);
        if (calls === 2) image.storageFileId = 'cloud://replacement';
        return image;
      },
      readObject: async () => {
        throw new Error('missing old object');
      },
      now: () => now,
    }),
    { status: 'retry', reason: 'changed' },
  );
});
for (const phase of ['initial', 'readback'] as const)
  test(`a database read outage remains retryable: ${phase}`, async () => {
    const f = fixture();
    let calls = 0;
    assert.deepEqual(
      await readStoredCatalogImageBytes('image', {
        getImage: async () => {
          calls++;
          if (phase === 'initial' || calls === 2) throw new Error('db unavailable');
          return structuredClone(f.image);
        },
        readObject: async () => ({ body: bytes.toString('base64') }),
        now: () => now,
      }),
      { status: 'retry', reason: 'unavailable' },
    );
  });
test('a byte check deliberately does not certify that image pixels decode', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, 'verified');
  assert.equal('mediaReady' in result, false);
});
for (const imageId of ['', ' image', 'image ', 'a'.repeat(201)])
  test(`invalid ids cannot start storage reads: ${imageId.length}`, async () => {
    let calls = 0;
    assert.deepEqual(
      await readStoredCatalogImageBytes(imageId, {
        getImage: async () => {
          calls++;
          return null;
        },
      }),
      { status: 'invalid', reason: 'record' },
    );
    assert.equal(calls, 0);
  });

test('the default service uses the real DB and storage facades without writes or file-id normalization', async () => {
  const f = fixture();
  assert.ok(f.image);
  const before = structuredClone(f.image);
  const adapter = new ReadPlanAdapter({ images: [f.image] });
  setAdapter(adapter);
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected storage mutation or credential mint');
  };
  setMediaStorage({
    putObject: unused,
    deleteObject: unused,
    getUploadCredential: unused,
    getTempUrl: unused,
    getObjectAsBase64: async (fileId, limits) => {
      assert.deepEqual(limits, { maxBytes: CATALOG_IMAGE_MAX_BYTES, timeoutMs: 5000 });
      assert.equal(fileId, before.storageFileId);
      return { body: bytes.toString('base64'), byteSize: 1 };
    },
  });
  assert.equal((await readStoredCatalogImageBytes('image')).status, 'verified');
  assert.deepEqual(adapter.rows.images, [before]);
  assert.deepEqual(adapter.commands, []);
});

test('an adapter stream cap violation is invalid size, after checking the same target', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageBytes('image', {
      getImage: async () => structuredClone(f.image),
      readObject: async () => {
        throw new MediaReadError('too-large');
      },
    }),
    { status: 'invalid', reason: 'size' },
  );
});
