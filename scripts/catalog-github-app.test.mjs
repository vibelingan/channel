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
