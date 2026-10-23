import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { articleSdkFixture } from '../../../../packages/db/src/article-sdk-fixture.test-helper.ts';
import { createBlogDummyHandler } from './blog-dummy-handler.ts';
import { assertBlogDummyFileId, createBlogDummyStorage } from './blog-dummy-storage.ts';
const key = 'isolated-dummy-test-secret-at-least-32-bytes';

test('real SDK transactions create isolated drafts and tasks; business collections are unreachable', async (t) => {
  const sdk = articleSdkFixture(t);
  sdk.put('blogDummy20261023Users', 'admin', { role: 'admin', status: 'active' });
  sdk.put('users', 'admin', {
    role: 'admin',
    status: 'active',
    business: 'must remain unchanged',
  });
  const api = createBlogDummyHandler({
    db: sdk.db,
    envId: 'offline-article-contract',
    codeSha: 'a'.repeat(40),
    jwtSecret: key,
    expiresAt: Date.now() + 3600000,
  });
  const token = await signSession(key, {
    sub: 'admin',
    email: 'dummy@example.invalid',
    name: 'Dummy',
    role: 'admin',
  });
  const content = {
    title: 'Dummy article',
    slug: 'dummy-article',
    authorName: 'Editor',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Actual persisted text' }] },
        ],
      },
    },
  };
  const result = await api({
    action: 'articleDrafts',
    data: { operation: 'create', requestId: 'create-a', content },
    token,
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.data || typeof result.data !== 'object')
    throw new Error('No actual draft');
  const articleId = Reflect.get(result.data, 'id');
  assert.equal(typeof articleId, 'string');
  const release = await api({
    action: 'articleReleases',
    data: { operation: 'publish', articleId, expectedRevision: 1, requestId: 'publish-a' },
    token,
  });
  assert.equal(release.ok, true);
  assert.ok([...sdk.rows.keys()].some((key) => key.startsWith('blogDummy20261023Tasks/')));
  assert.equal(
    (await api({ action: 'update', data: { collection: 'products' }, token })).ok,
    false,
  );
  assert.equal(
    (await api({ action: 'articleReleases', data: { operation: 'claim' }, token })).ok,
    false,
  );
  assert.deepEqual(sdk.rows.get('users/admin'), {
    _id: 'admin',
    role: 'admin',
    status: 'active',
    business: 'must remain unchanged',
  });
  assert.ok(
    sdk.calls
      .filter((call) => call.params.collectionName)
      .every(
        (call) =>
          typeof call.params.collectionName === 'string' &&
          call.params.collectionName.startsWith('blogDummy20261023'),
      ),
  );
});
test('dummy rejects expired windows, invalid tokens, non-admin and revoked users', async (t) => {
  const sdk = articleSdkFixture(t);
  sdk.put('blogDummy20261023Users', 'admin', { role: 'member', status: 'active' });
  const api = createBlogDummyHandler({
    db: sdk.db,
    envId: 'offline-article-contract',
    codeSha: 'a'.repeat(40),
    jwtSecret: key,
    expiresAt: Date.now() + 3600000,
  });
  const token = await signSession(key, {
    sub: 'admin',
    email: 'dummy@example.invalid',
    name: 'Dummy',
    role: 'admin',
  });
  assert.equal((await api({ action: 'me', token })).ok, false);
  sdk.put('blogDummy20261023Users', 'admin', { role: 'admin', status: 'suspended' });
  assert.equal((await api({ action: 'me', token })).ok, false);
  assert.equal((await api({ action: 'me', token: 'wrong' })).ok, false);
  const expired = createBlogDummyHandler({
    db: sdk.db,
    envId: 'offline-article-contract',
    codeSha: 'a'.repeat(40),
    jwtSecret: key,
    expiresAt: 0,
  });
  assert.equal((await expired({ action: 'health' })).ok, false);
});
test('dummy storage maps writes and denies all business file reads before contacting SDK', async () => {
  const calls: string[] = [];
  const adapter = createBlogDummyStorage(
    {
      uploadFile: async ({ cloudPath }) => {
        calls.push(cloudPath);
        return { fileID: `cloud://fixture-env.bucket/${cloudPath}` };
      },
      downloadFile: async ({ fileID }) => {
        calls.push(fileID);
        return { fileContent: Buffer.from('bytes') };
      },
      getUploadMetadata: async () => {
        throw new Error('not used');
      },
      getTempFileURL: async () => {
        throw new Error('not used');
      },
      deleteFile: async () => {
        throw new Error('not used');
      },
    },
    'fixture-env',
  );
  const object = await adapter.putObject({
    namespace: 'articles',
    logicalId: 'image-one',
    fileName: 'test.image',
    mimeType: 'image/webp',
    content: Buffer.from('bytes'),
  });
  assert.match(object.storagePath, /^__blog-dummy\/articles\//);
  await adapter.getObjectAsBase64(object.storageFileId);
  await assert.rejects(
    adapter.getObjectAsBase64('cloud://fixture-env.bucket/articles/business/image.webp'),
  );
  await assert.rejects(
    adapter.putObject({
      namespace: 'catalog',
      logicalId: 'image-one',
      fileName: 'test.image',
      mimeType: 'image/webp',
      content: Buffer.from('bytes'),
    }),
  );
  assert.equal(calls.length, 2);
  for (const id of [
    'cloud://other-env.bucket/__blog-dummy/articles/a',
    'https://example.com/__blog-dummy/articles/a',
    'cloud://fixture-env.bucket/__blog-dummy/%2e%2e/articles/a',
  ])
    assert.throws(() => assertBlogDummyFileId(id, 'fixture-env'));
});
