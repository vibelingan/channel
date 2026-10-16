import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { handleAdminRequest } from '../../functions/admin/src/handler.ts';
import { handlePublicApiEvent } from '../../functions/public-api/src/http-adapter.ts';
import { JsonFileAdapter } from './json-adapter.ts';
test('actual protected file stays private, admin preview loads bytes, refcount publication and withdrawal gate public bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-protected-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new LocalDiskMediaStorage(join(directory, 'media'));
  setMediaStorage(storage);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
    'base64',
  );
  const sha = createHash('sha256').update(bytes).digest('hex');
  const file = join(directory, 'db.json');
  await writeFile(file, JSON.stringify({ users: [{ _id: 'admin', role: 'admin' }], images: [] }));
  const db = new JsonFileAdapter(file);
  setAdapter(db);
  const target = await storage.putObject(
    {
      namespace: 'catalog-sealed',
      logicalId: `${'a'.repeat(64)}:${sha}:${'c'.repeat(64)}`,
      fileName: 'original.png',
      mimeType: 'image/png',
      content: bytes,
    },
    {
      beforeWrite: async (pending) => {
        await db.create('images', {
          _id: 'image',
          ...pending,
          status: 'pending',
          mimeType: 'image/png',
          publishedRefCount: 0,
          checksumSha256: sha,
        });
      },
    },
  );
  await db.update('images', 'image', { ...target, status: 'active' });
  const config = { jwtSecret: 'protected-delivery-test' };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const publicImage = () =>
    handlePublicApiEvent({ httpMethod: 'GET', path: '/api/images/image' }, config);
  assert.equal((await publicImage()).statusCode, 404);
  const preview = await handleAdminRequest(
    { action: 'getImagePreview', token, data: { id: 'image' } },
    config,
  );
  assert.ok(preview.ok);
  assert.equal(JSON.stringify(preview).includes(target.storageFileId), false);
  assert.ok(
    preview.data &&
      typeof preview.data === 'object' &&
      'dataBase64' in preview.data &&
      typeof preview.data.dataBase64 === 'string',
  );
  assert.deepEqual(Buffer.from(preview.data.dataBase64, 'base64'), bytes);
  await db.incrementField('images', 'image', 'publishedRefCount', 1);
  const visible = await publicImage();
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.isBase64Encoded, true);
  assert.deepEqual(Buffer.from(visible.body, 'base64'), bytes);
  await db.incrementField('images', 'image', 'publishedRefCount', -1);
  assert.equal((await publicImage()).statusCode, 404);
  assert.equal((await db.get('images', 'image'))?.publishedRefCount, 0);
});
