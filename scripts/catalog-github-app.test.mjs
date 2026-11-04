import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { createCatalogGithubApp } from './release/catalog-github-app.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const now = Date.parse('2026-10-30T00:00:00Z');
const json = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
function fixture() {
  const calls = [];
  const request = async (method, url, options) => {
    calls.push({ method, url, options });
    if (url.endsWith('/app/installations/2')) {
      const jwt = options.headers.authorization.slice(7);
      const [a, b, s] = jwt.split('.');
      assert.equal(
        verify('RSA-SHA256', Buffer.from(`${a}.${b}`), publicKey, Buffer.from(s, 'base64url')),
        true,
      );
      const claim = JSON.parse(Buffer.from(b, 'base64url'));
      assert.ok(claim.exp - claim.iat <= 600);
      assert.equal(claim.iss, '1');
      return json({ account: { login: 'vibelingan' }, repository_selection: 'selected' });
    }
    if (url.endsWith('/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ['channel'],
        permissions: { actions: 'write', contents: 'read' },
      });
      return json({
        token: 'fixture-token',
        expires_at: new Date(now + 3600000).toISOString(),
        repository_selection: 'selected',
        permissions: { actions: 'write', contents: 'read' },
      });
    }
    if (url.includes('/git/ref/')) return json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (url.endsWith('/dispatches')) return { status: 204, body: Buffer.alloc(0) };
    throw Error('Unexpected request');
  };
  return { calls, request };
}
test('GitHub application uses a short-lived signed JWT and requests only the pinned repo permissions', async () => {
  const x = fixture();
  const api = createCatalogGithubApp({
    appId: 1,
    installationId: 2,
    privateKey: pem,
    request: x.request,
    now: () => now,
  });
  assert.equal(await api.head('feat/seo-foundation'), 'a'.repeat(40));
  await api.head('feat/seo-foundation');
  assert.equal(x.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 1);
  assert.ok(x.calls.every((c) => c.options.redirect === 'error'));
});
test('a different account installation cannot be used', async () => {
  const x = fixture();
  const api = createCatalogGithubApp({
    appId: 1,
    installationId: 2,
    privateKey: pem,
    request: async (m, u, o) =>
      u.endsWith('/app/installations/2')
        ? json({ account: { login: 'another' }, repository_selection: 'selected' })
        : x.request(m, u, o),
    now: () => now,
  });
  await assert.rejects(api.head('feat/seo-foundation'), /owner/);
});
test('unapproved workflow or code-writing operation is rejected before HTTP', async () => {
  const x = fixture();
  const api = createCatalogGithubApp({
    appId: 1,
    installationId: 2,
    privateKey: pem,
    request: x.request,
    now: () => now,
  });
  await assert.rejects(api.dispatch('deploy-test.yml', { ref: 'test', inputs: {} }), /Unapproved/);
  assert.equal(x.calls.length, 0);
});

function runApi(respond, branch = 'feat/seo-foundation') {
  const x = fixture();
  const urls = [];
  const api = createCatalogGithubApp({
    appId: 1,
    installationId: 2,
    privateKey: pem,
    now: () => now,
    request: async (method, url, options) => {
      if (!url.includes('/runs?')) return x.request(method, url, options);
      const query = new URL(url).searchParams;
      urls.push(query);
      assert.equal(query.get('per_page'), '1', 'Only an existence check is needed');
      assert.equal(query.get('exclude_pull_requests'), 'true');
      assert.equal(query.get('branch'), branch);
      return json(respond(query));
    },
  });
  return { api, urls, calls: x.calls };
}
const run = (status) => ({
  status,
  head_branch: 'feat/seo-foundation',
  path: '.github/workflows/seo-static-canary.yml',
  repository: { full_name: 'vibelingan/channel' },
  head_repository: { full_name: 'vibelingan/channel' },
});

test('active work is found independently of completed history or the number of queued runs', async () => {
  const x = runApi((query) =>
    query.get('status') === 'queued'
      ? { total_count: 237, workflow_runs: [run('queued')] }
      : { total_count: 0, workflow_runs: [] },
  );
  assert.deepEqual(await x.api.runs('seo-static-canary.yml', 'feat/seo-foundation'), [
    run('queued'),
  ]);
  assert.deepEqual(x.urls.map((q) => q.get('status')).sort(), [
    'in_progress',
    'pending',
    'queued',
    'requested',
    'waiting',
  ]);
  assert.equal(x.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 1);
});

test('an idle result requires an empty result for every active status', async () => {
  const x = runApi(() => ({ total_count: 0, workflow_runs: [] }));
  assert.deepEqual(await x.api.runs('seo-static-canary.yml', 'feat/seo-foundation'), []);
  assert.equal(x.urls.length, 5);
});

for (const [label, response] of [
  ['missing count', { workflow_runs: [] }],
  ['missing witness', { total_count: 1, workflow_runs: [] }],
  ['null witness', { total_count: 1, workflow_runs: [null] }],
  ['unexpected row', { total_count: 0, workflow_runs: [run('queued')] }],
  ['wrong branch', { total_count: 1, workflow_runs: [{ ...run('queued'), head_branch: 'main' }] }],
  ['wrong status', { total_count: 1, workflow_runs: [run('completed')] }],
]) {
  test(`an incomplete or mismatched active response is rejected: ${label}`, async () => {
    const x = runApi(() => response);
    await assert.rejects(x.api.runs('seo-static-canary.yml', 'feat/seo-foundation'));
  });
}

test('active queries reject another workflow or branch before any HTTP call', async () => {
  const x = runApi(() => ({ total_count: 0, workflow_runs: [] }));
  await assert.rejects(x.api.runs('deploy-test.yml', 'feat/seo-foundation'));
  await assert.rejects(x.api.runs('seo-static-canary.yml', 'main'));
  assert.equal(x.calls.length, 0);
  assert.equal(x.urls.length, 0);
});

test('passed CI is an exact successful push existence query, even with many historical reruns', async () => {
  const x = runApi((query) => {
    assert.equal(query.get('head_sha'), 'a'.repeat(40));
    assert.equal(query.get('event'), 'push');
    assert.equal(query.get('status'), 'success');
    return {
      total_count: 200,
      workflow_runs: [
        {
          ...run('completed'),
          path: '.github/workflows/seo-module-1.yml',
          head_sha: 'a'.repeat(40),
          conclusion: 'success',
          event: 'push',
        },
      ],
    };
  });
  assert.equal(await x.api.passedCI('a'.repeat(40), 'feat/seo-foundation'), true);
});

test('test branch accepts its successful manual CI without hiding it behind failed or push history', async () => {
  const x = runApi(
    (query) =>
      query.get('event') === 'push'
        ? { total_count: 0, workflow_runs: [] }
        : {
            total_count: 10,
            workflow_runs: [
              {
                ...run('completed'),
                head_branch: 'test',
                path: '.github/workflows/deploy-test.yml',
                head_sha: 'a'.repeat(40),
                conclusion: 'success',
                event: 'workflow_dispatch',
              },
            ],
          },
    'test',
  );
  assert.equal(await x.api.passedCI('a'.repeat(40), 'test'), true);
  assert.deepEqual(
    x.urls.map((q) => q.get('event')),
    ['push', 'workflow_dispatch'],
  );
});

test('a failed status query cannot be treated as an empty queue', async () => {
  const x = runApi((query) => {
    if (query.get('status') === 'waiting') throw Error('HTTP read failed');
    return { total_count: 0, workflow_runs: [] };
  });
  await assert.rejects(
    x.api.runs('seo-static-canary.yml', 'feat/seo-foundation'),
    /HTTP read failed/,
  );
});
