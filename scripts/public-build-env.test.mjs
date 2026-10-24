import assert from 'node:assert/strict';
import test from 'node:test';
import { publicBuildEnvironment } from './release/public-build-env.mjs';
test('frontend and anonymous collection processes keep all declared public settings while excluding deployment and login credentials', () => {
  const source = {
    PATH: '/bin',
    GITHUB_SHA: 'a'.repeat(40),
    SITE_URL: 'https://site.example',
    PUBLIC_API_BASE_URL: 'https://api.example',
    PUBLIC_NEW_FEATURE: '1',
    SEO_CATALOG_SNAPSHOT: '/tmp/public.json',
    GITHUB_TOKEN: 'private-github',
    ACTIONS_RUNTIME_TOKEN: 'private-artifacts',
    TENCENTCLOUD_SECRETKEY: 'private-cloud',
    E2E_ADMIN_PASSWORD: 'private-password',
    JWT_SECRET: 'private-jwt',
  };
  const result = publicBuildEnvironment(source, { PUBLIC_BLOG_WORKSPACE: '0' });
  assert.equal(result.PUBLIC_NEW_FEATURE, '1');
  assert.equal(result.PUBLIC_BLOG_WORKSPACE, '0');
  assert.equal(result.SEO_CATALOG_SNAPSHOT, '/tmp/public.json');
  assert(!JSON.stringify(result).includes('private-'));
  assert(Object.isFrozen(result));
  assert.equal(source.PUBLIC_BLOG_WORKSPACE, undefined);
  assert.throws(() => publicBuildEnvironment(source, { JWT_SECRET: 'leak' }));
});
