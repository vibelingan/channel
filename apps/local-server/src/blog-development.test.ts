import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createCloudBaseArticleRepository } from '@vibelingan-channel/db/article-repository';
import { articleSdkFixture } from '../../../packages/db/src/article-sdk-fixture.test-helper.ts';
import { createBlogDevelopmentApp } from './blog-development-app.ts';

test('real local HTTP routes use the installed CloudBase repository; business routes and publication stay closed', async (t) => {
  const sdk = articleSdkFixture(t);
  let role = 'admin';
  let authCalls = 0;
  const app = createBlogDevelopmentApp({
    repository: createCloudBaseArticleRepository(sdk.db),
    frontendOrigin: 'http://localhost:4321',
    envId: 'offline-sdk',
    auth: async () => {
      authCalls++;
      return { ok: true, data: { user: { id: 'admin', role, status: 'active' } } };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (action: string, data: unknown) =>
    fetch(`${origin}/api/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4321' },
      body: JSON.stringify({ action, data, token: 'existing-account-token' }),
    });
  const content = {
    title: 'Cloud-backed developer article',
    slug: '',
    body: {
      schemaVersion: 1,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Actual HTTP, installed SDK transport' }],
          },
        ],
      },
    },
  };
  const response = await post('articleDrafts', {
    operation: 'create',
    requestId: 'dev-1',
    content,
  });
  assert.equal(response.status, 200);
  const stored: unknown = await response.json();
  assert.ok(stored && typeof stored === 'object' && Reflect.get(stored, 'ok') === true);
  assert.equal([...sdk.rows.keys()].filter((key) => key.startsWith('articleDrafts/')).length, 1);
  assert.deepEqual(await (await post('articleReleases', { operation: 'capabilities' })).json(), {
    ok: true,
    data: { enabled: false },
  });
  assert.equal((await post('articleReleases', { operation: 'publish' })).status, 403);
  const before = authCalls;
  assert.equal((await post('update', { collection: 'products' })).status, 403);
  assert.equal(authCalls, before);
  assert.equal((await fetch(`${origin}/api/alibaba-sync`)).status, 404);
  role = 'member';
  assert.equal((await post('articleDrafts', { operation: 'list' })).status, 403);
  role = 'admin';
  sdk.put('users', 'admin', { role: 'member', status: 'active' });
  assert.equal((await post('articleDrafts', { operation: 'list' })).status, 403);
  assert.equal(
    (await fetch(`${origin}/api/health`, { headers: { Origin: 'https://untrusted.example' } }))
      .status,
    403,
  );
});
