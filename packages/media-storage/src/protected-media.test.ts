import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type StoredMediaObject, catalogProtectedStoragePath, objectStoragePath } from './index.ts';
import { LocalDiskMediaStorage } from './local-disk.ts';
const identity = 'a'.repeat(64);
const content = 'b'.repeat(64);
const attempt = 'c'.repeat(64);
const logicalId = `${identity}:${content}:${attempt}`;
for (const ext of ['jpg', 'jpeg', 'png', 'gif', 'webp'])
  test(`protected ${ext} path is content/attempt scoped and independent of dates`, () => {
    const expected = `catalog/sealed/${identity}/${content}/${attempt}.${ext}`;
    assert.equal(catalogProtectedStoragePath(logicalId, `original.${ext}`), expected);
    for (const now of [new Date('2020-01-01'), new Date('2026-12-31')])
      assert.equal(
        objectStoragePath({
          namespace: 'catalog-sealed',
          logicalId,
          fileName: `original.${ext}`,
          now,
        }),
        expected,
      );
  });
for (const [id, name] of [
  [logicalId, 'original.svg'],
  [logicalId, '../original.png'],
  [logicalId, 'Original.png'],
  [`${identity}:${content}`, 'original.png'],
  [`${identity}:${content}:${attempt.toUpperCase()}`, 'original.png'],
  [`${identity}:${content}:${attempt}/..`, 'original.png'],
])
  test(`malformed protected storage input is refused: ${id?.slice(-5)} ${name}`, () => {
    assert.throws(() => catalogProtectedStoragePath(id ?? '', name ?? ''));
    assert.throws(() =>
      objectStoragePath({ namespace: 'catalog-sealed', logicalId: id ?? '', fileName: name ?? '' }),
    );
  });
test('protected LocalDisk target checkpoints before bytes and reads back exact content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-protected-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(directory);
  const bytes = Buffer.from('owned bytes');
  let checkpoint: Readonly<StoredMediaObject> | undefined;
  const stored = await storage.putObject(
    {
      namespace: 'catalog-sealed',
      logicalId,
      fileName: 'original.png',
      mimeType: 'image/png',
      content: bytes,
    },
    {
      beforeWrite: async (target) => {
        checkpoint = target;
        await assert.rejects(stat(join(directory, target.storagePath)), { code: 'ENOENT' });
      },
    },
  );
  assert.deepEqual(stored, checkpoint);
  assert.deepEqual(
    Buffer.from(
      (
        await storage.getObjectAsBase64(stored.storageFileId, {
          maxBytes: bytes.length,
          timeoutMs: 1000,
        })
      ).body,
      'base64',
    ),
    bytes,
  );
});

test('a different image or attempt never reuses another promotion target', () => {
  const first = catalogProtectedStoragePath(logicalId, 'original.png');
  assert.notEqual(
    catalogProtectedStoragePath(`${'d'.repeat(64)}:${content}:${attempt}`, 'original.png'),
    first,
  );
  assert.notEqual(
    catalogProtectedStoragePath(`${identity}:${content}:${'d'.repeat(64)}`, 'original.png'),
    first,
  );
});
test('LocalDisk protected writes require a durable checkpoint before any object is created', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-protected-untracked-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(directory);
  await assert.rejects(
    storage.putObject({
      namespace: 'catalog-sealed',
      logicalId,
      fileName: 'original.png',
      mimeType: 'image/png',
      content: Buffer.from('bytes'),
    }),
    /checkpoint/i,
  );
  await assert.rejects(
    stat(join(directory, catalogProtectedStoragePath(logicalId, 'original.png'))),
    { code: 'ENOENT' },
  );
});
