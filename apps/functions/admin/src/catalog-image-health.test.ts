import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { readStoredCatalogImageBytes } from './catalog-image-bytes.ts';
import { readStoredCatalogImageHealth } from './catalog-image-health.ts';

const samples = {
  jpeg: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCcwFqQAB//2Q==',
  png: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  gif: 'R0lGODlhGAAQAIAAAExpcRI0ViH5BAUAAAAALAAAAAAYABAAAAIRjI+py+0Po5y02ouz3rz7rxQAOw==',
  webp: 'UklGRmIAAABXRUJQVlA4WAoAAAAQAAAAFwAADwAAQUxQSAoAAAABB1DAiAhERP8DVlA4IDIAAADQAgCdASoYABAAPm0qkkWkIqGYBABABsSxgDsAAIGwAP725gf/UREFJLD/8Qu9jCgAAA==',
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = Date.parse('2026-10-15T04:00:00Z');
function fixture(format: keyof typeof samples = 'png', supplied?: Buffer) {
  const bytes = supplied ?? Buffer.from(samples[format], 'base64');
  let image: CollectionDoc | null = {
    _id: 'image',
    status: 'active',
    storageProvider: 'cloudbase-storage',
    storageMode: 'classic-nosql-storage',
    storageFileId: 'cloud://opaque/Case%2f ID ',
    storagePath: `catalog/original.${format}`,
    mimeType: `image/${format}`,
    byteSize: bytes.length,
    checksumSha256: hash(bytes),
    publishedRefCount: 0,
  };
  let records = 0;
  let objects = 0;
  const options = {
    getImage: async () => {
      records++;
      return structuredClone(image);
    },
    readObject: async (id: string) => {
      objects++;
      assert.equal(id, image?.storageFileId);
      return { body: bytes.toString('base64') };
    },
    now: () => now,
  };
  return {
    bytes,
    options,
    get image() {
      return image;
    },
    get current() {
      assert.ok(image);
      return image;
    },
    set image(value) {
      image = value;
    },
    get records() {
      return records;
    },
    get objects() {
      return objects;
    },
  };
}
function decoded(bytes: Uint8Array) {
  return {
    status: 'decoded' as const,
    kind: 'catalog-image-pixels-v1' as const,
    checksumSha256: hash(bytes),
    width: 24,
    height: 16,
    pages: 1,
  };
}
for (const format of Object.keys(samples) as (keyof typeof samples)[])
  test(`${format} health combines actual pixels with exact current stored content`, async () => {
    const f = fixture(format);
    const before = structuredClone(f.image);
    const result = await readStoredCatalogImageHealth('image', f.options);
    assert.equal(result.status, 'verified');
    if (result.status !== 'verified') return;
    assert.equal(result.kind, 'stored-image-health-v1');
    assert.equal(result.imageId, 'image');
    assert.equal(result.byteSize, f.bytes.length);
    assert.equal(result.checksumSha256, hash(f.bytes));
    assert.deepEqual([result.width, result.height, result.pages], [24, 16, 1]);
    assert.match(result.inputDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual([f.records, f.objects], [2, 1]);
    assert.deepEqual(f.image, before);
    assert.equal(JSON.stringify(result).includes('cloud://'), false);
    assert.equal(JSON.stringify(result).includes(f.bytes.toString('base64')), false);
  });
test('byte signatures alone cannot produce a healthy image proof', async () => {
  const f = fixture('jpeg', Buffer.from('ffd8ffdb00040000ffd9', 'hex'));
  assert.equal((await readStoredCatalogImageBytes('image', f.options)).status, 'verified');
  assert.deepEqual(await readStoredCatalogImageHealth('image', f.options), {
    status: 'invalid',
    reason: 'content',
  });
});
for (const format of Object.keys(samples) as (keyof typeof samples)[])
  test(`${format} damaged pixels are rejected even when the stored size and SHA match`, async () => {
    const full = Buffer.from(samples[format], 'base64');
    const f = fixture(format, full.subarray(0, full.length - 10));
    assert.deepEqual(await readStoredCatalogImageHealth('image', f.options), {
      status: 'invalid',
      reason: 'content',
    });
  });
test('an invalid byte checksum never starts the native decoder', async () => {
  const f = fixture();
  f.current.checksumSha256 = 'f'.repeat(64);
  let calls = 0;
  const result = await readStoredCatalogImageHealth('image', {
    ...f.options,
    decodePixels: async (bytes) => {
      calls++;
      return decoded(bytes);
    },
  });
  assert.deepEqual(result, { status: 'invalid', reason: 'checksum' });
  assert.equal(calls, 0);
});
for (const reason of ['timeout', 'unavailable'] as const)
  test(`${reason} stays retryable and never becomes a content validation error`, async () => {
    const f = fixture();
    const result = await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async () => ({ status: 'retry', reason }),
    });
    assert.deepEqual(result, { status: 'retry', reason });
    assert.deepEqual([f.records, f.objects], [2, 1]);
  });
test('a decoder exception is private and retryable', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async () => {
        throw new Error('private signed URL secret');
      },
    }),
    { status: 'retry', reason: 'unavailable' },
  );
});
test('pixel evidence for other bytes cannot be attached to this storage record', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async () => decoded(Buffer.from('other')),
    }),
    { status: 'invalid', reason: 'checksum' },
  );
});
for (const field of [
  '_id',
  'status',
  'storageFileId',
  'storagePath',
  'mimeType',
  'byteSize',
  'checksumSha256',
  'storageProvider',
  'storageMode',
])
  test(`changing ${field} during native work invalidates its proof`, async () => {
    const f = fixture();
    const result = await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async (bytes) => {
        f.current[field] = field === 'byteSize' ? 999 : 'changed';
        return decoded(bytes);
      },
    });
    assert.deepEqual(result, { status: 'retry', reason: 'changed' });
  });
test('a deleted image during native work invalidates the result', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async (bytes) => {
        f.image = null;
        return decoded(bytes);
      },
    }),
    { status: 'retry', reason: 'changed' },
  );
});
test('a fresh image mutation lock during decoding blocks verification', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async (bytes) => {
        f.current.imageMutationOwner = 'new-owner';
        f.current.imageMutationStartedAt = new Date(now).toISOString();
        return decoded(bytes);
      },
    }),
    { status: 'retry', reason: 'busy' },
  );
});
test('shared-image reference increments do not invalidate unchanged stored content', async () => {
  const f = fixture();
  const result = await readStoredCatalogImageHealth('image', {
    ...f.options,
    decodePixels: async (bytes) => {
      f.current.publishedRefCount = 2;
      return decoded(bytes);
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal(f.image?.publishedRefCount, 2);
});
test('a corrupt reference counter after decoding is rejected', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async (bytes) => {
        f.current.publishedRefCount = -1;
        return decoded(bytes);
      },
    }),
    { status: 'invalid', reason: 'record' },
  );
});
test('the final record read waits for actual pixel work and no bytes escape the proof', async () => {
  const f = fixture();
  let release: () => void = () => {
    throw new Error('Missing gate release');
  };
  let started: () => void = () => {
    throw new Error('Missing start signal');
  };
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = readStoredCatalogImageHealth('image', {
    ...f.options,
    decodePixels: async (bytes) => {
      started();
      await gate;
      return decoded(bytes);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      start,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Pixel decoder was never started')), 1000);
      }),
    ]);
    assert.equal(f.records, 1);
    f.current.storageFileId = 'new';
  } finally {
    clearTimeout(timer);
    release();
  }
  assert.deepEqual(await pending, { status: 'retry', reason: 'changed' });
  assert.equal(f.records, 2);
});
test('a changed current target overrides a retry result from the old bytes', async () => {
  const f = fixture();
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      decodePixels: async () => {
        f.current.storageFileId = 'new';
        return { status: 'retry', reason: 'timeout' };
      },
    }),
    { status: 'retry', reason: 'changed' },
  );
});

test('decoder selection is fixed before the first asynchronous record read', async () => {
  const f = fixture();
  const options: Parameters<typeof readStoredCatalogImageHealth>[1] = {
    ...f.options,
    decodePixels: async (bytes) => decoded(bytes),
  };
  options.getImage = async () => {
    options.decodePixels = async () => ({ status: 'invalid', reason: 'content' });
    return f.options.getImage();
  };
  assert.equal((await readStoredCatalogImageHealth('image', options)).status, 'verified');
});
test('a failed final record read cannot leave a verified pixel proof', async () => {
  const f = fixture();
  let reads = 0;
  assert.deepEqual(
    await readStoredCatalogImageHealth('image', {
      ...f.options,
      getImage: async () => {
        reads++;
        if (reads === 2) throw new Error('private backend failure');
        return f.options.getImage();
      },
    }),
    { status: 'retry', reason: 'unavailable' },
  );
});

for (const status of ['invalid', 'retry'] as const)
  test(`${status} decoder results cannot forward private diagnostic fields`, async () => {
    const f = fixture();
    const result =
      status === 'invalid'
        ? {
            status: 'invalid' as const,
            reason: 'content' as const,
            privateFileId: 'cloud://private',
            privateBody: f.bytes.toString('base64'),
          }
        : {
            status: 'retry' as const,
            reason: 'unavailable' as const,
            privateFileId: 'cloud://private',
            privateBody: f.bytes.toString('base64'),
          };
    assert.deepEqual(
      await readStoredCatalogImageHealth('image', {
        ...f.options,
        decodePixels: async () => result,
      }),
      status === 'invalid'
        ? { status: 'invalid', reason: 'content' }
        : { status: 'retry', reason: 'unavailable' },
    );
  });
