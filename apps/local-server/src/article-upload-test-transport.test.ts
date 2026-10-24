import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { ArticleUploadTestTransport } from './article-upload-test-transport.ts';

test('isolated signed PUT transport writes real bytes only with the exact credential and article path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-article-put-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let origin = '';
  const storage = new ArticleUploadTestTransport(directory, () => origin);
  const app = express();
  storage.register(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  origin = `http://127.0.0.1:${address.port}`;
  const path = 'articles/test/owned/pending-upload';
  const credential = await storage.getUploadCredential(path);
  const bytes = Buffer.from('actual raw bytes');
  assert.equal(
    (
      await fetch(credential.uploadUrl, {
        method: 'PUT',
        headers: { ...credential.headers, Signature: 'wrong' },
        body: bytes,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(credential.uploadUrl, {
        method: 'POST',
        headers: credential.headers,
        body: bytes,
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(credential.uploadUrl, { method: 'PUT', headers: credential.headers, body: bytes }))
      .status,
    200,
  );
  assert.deepEqual(await readFile(join(directory, path)), bytes);
  assert.deepEqual(await storage.getObjectAsBase64(credential.storageFileId), {
    body: bytes.toString('base64'),
    byteSize: bytes.length,
  });
  await assert.rejects(storage.getUploadCredential('catalog/not-permitted'), /limited to article/);
});
