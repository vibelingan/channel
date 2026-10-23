import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { setAdapter } from '@vibelingan-channel/db';
import { JsonFileAdapter } from '../../../local-server/src/json-adapter.ts';
import { handleAdminRequest } from './handler.ts';

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-article-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  writeFileSync(
    file,
    JSON.stringify({
      users: [{ _id: 'admin', role: 'admin', status: 'active', email: 'dummy@example.test' }],
    }),
  );
  const adapter = new JsonFileAdapter(file);
  setAdapter(adapter);
  const jwtSecret = 'local-release-test-secret';
  const token = await signSession(jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Dummy',
    email: 'dummy@example.test',
  });
  const config = {
    jwtSecret,
    articleRepository: adapter.articleRepository,
    enableArticleReleases: true,
  };
  const draft = await adapter.articleRepository.create({
    actorId: 'admin',
    requestId: 'create',
    content: {
      title: 'Release me',
      slug: 'release-me',
      authorName: 'Sean',
      excerpt: '',
      seoTitle: '',
      seoDescription: '',
      body: {
        schemaVersion: 1,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { textAlign: null },
              content: [{ type: 'text', text: 'Real local file.', marks: [] }],
            },
          ],
        },
      },
    },
  });
  const request = {
    action: 'articleReleases',
    token,
    data: { operation: 'publish', articleId: draft.id, expectedRevision: 1, requestId: 'publish' },
  };
  return { file, config, request, token, draft };
}

test('release entry defaults off and existing draft operations remain available', async (t) => {
  const { config, request, token, draft } = await setup(t);
  const result = await handleAdminRequest(request, {
    jwtSecret: config.jwtSecret,
    articleRepository: config.articleRepository,
  });
  assert.equal(result.ok, false);
  const caps = await handleAdminRequest(
    { action: 'articleReleases', token, data: { operation: 'capabilities' } },
    { ...config, enableArticleReleases: false },
  );
  assert.deepEqual(caps, { ok: true, data: { enabled: false } });
  const get = await handleAdminRequest(
    { action: 'articleDrafts', token, data: { operation: 'get', articleId: draft.id } },
    config,
  );
  assert.equal(get.ok, true);
});

test('admin handler persists the frozen task, reads it after reopen and refuses browser commands that forge deployment results', async (t) => {
  const { file, config, request, token, draft } = await setup(t);
  const result = await handleAdminRequest(request, config);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Release request failed');
  assert(!JSON.stringify(result.data).includes('Real local file'));
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.articleReleaseTasks.length, 1);
  assert.equal(stored.articlePublications[0].candidate.revision, 1);
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  const nextConfig = { ...config, articleRepository: reopened.articleRepository };
  assert.deepEqual(await handleAdminRequest(request, nextConfig), result);
  assert.deepEqual(
    await handleAdminRequest(
      { action: 'articleReleases', token, data: { operation: 'get', articleId: draft.id } },
      nextConfig,
    ),
    result,
  );
  for (const operation of ['claim', 'complete', 'markDeploying', 'markUnknown']) {
    const forged = await handleAdminRequest(
      {
        action: 'articleReleases',
        token,
        data: { operation, articleId: draft.id, state: 'SUCCEEDED' },
      },
      nextConfig,
    );
    assert.equal(forged.ok, false);
  }
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).articleReleaseTasks[0].state, 'QUEUED');
});

test('release entry rejects invalid sessions, oversized input and a role revoked after JWT issuance', async (t) => {
  const { file, config, request } = await setup(t);
  for (const input of [
    { ...request, token: 'invalid' },
    { action: request.action, data: request.data },
  ])
    assert.equal((await handleAdminRequest(input, config)).ok, false);
  assert.equal(
    (
      await handleAdminRequest(
        { ...request, data: { ...request.data, unexpected: 'x'.repeat(5000) } },
        config,
      )
    ).ok,
    false,
  );
  const changed = JSON.parse(readFileSync(file, 'utf8'));
  changed.users[0].role = 'viewer';
  writeFileSync(file, JSON.stringify(changed));
  const reopened = new JsonFileAdapter(file);
  setAdapter(reopened);
  const denied = await handleAdminRequest(request, {
    ...config,
    articleRepository: reopened.articleRepository,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) throw new Error('Revoked admin published');
  assert.equal(denied.error.code, 'FORBIDDEN');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).articleReleaseTasks, undefined);
});
