import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogGithubAppManifest } from '../tools/catalog-seo/github-app-manifest.mjs';

test('GitHub webhook manifest includes its required URL even when event delivery is disabled', () => {
  const value = catalogGithubAppManifest('http://127.0.0.1:60188');
  assert.equal(new URL(value.url).protocol, 'https:');
  assert.equal(new URL(value.hook_attributes.url).protocol, 'https:');
  assert.equal(value.hook_attributes.active, false);
  assert.deepEqual(value.default_events, []);
});

test('setup grants only the approved repository permissions and never a public application', () => {
  const value = catalogGithubAppManifest('http://127.0.0.1:60188');
  assert.deepEqual(value.default_permissions, { actions: 'write', contents: 'read' });
  assert.equal(value.public, false);
  assert.equal(value.redirect_url, 'http://127.0.0.1:60188/callback');
});

test('an external or ambiguous callback origin is rejected', () => {
  for (const origin of [
    'https://example.com',
    'http://127.0.0.1:1234@evil.example',
    'http://127.0.0.1:1234/path',
  ])
    assert.throws(() => catalogGithubAppManifest(origin));
});
