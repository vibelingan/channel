import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBlogIndexingPreflight } from './blog/indexing-preflight.mjs';

const origin = 'https://supplychainsai.com';
function fixture() {
  const blog = {
    service: 'blog-pages',
    status: 'ok',
    siteOrigin: origin,
    releaseId: 'c'.repeat(40),
    previewOnly: true,
    indexingPolicyVersion: 1,
    indexing: { enabled: false, canonicalHost: true, allowed: false },
  };
  return {
    siteOrigin: origin,
    admin: {
      releaseId: 'a'.repeat(40),
      articleDeliveryMode: 'server',
      articlePublishingEnabled: true,
    },
    api: { releaseId: 'b'.repeat(40), articlePublicReadEnabled: true },
    formal: blog,
    temporary: { ...blog, indexing: { ...blog.indexing, canonicalHost: false } },
  };
}

test('opening indexing accepts independently deployed APIs and preserves normal publishing', () => {
  const value = fixture();
  assert.deepEqual(assertBlogIndexingPreflight(value), {
    adminSha: 'a'.repeat(40),
    apiSha: 'b'.repeat(40),
    blogSha: 'c'.repeat(40),
  });
  assert.equal(value.admin.articlePublishingEnabled, true);
});

test('a missing host policy or an unrecognized formal host prevents exposure', () => {
  for (const mutate of [
    (f) => {
      f.formal.indexingPolicyVersion = undefined;
    },
    (f) => {
      f.formal.indexing.canonicalHost = false;
    },
    (f) => {
      f.temporary.indexing.canonicalHost = true;
    },
    (f) => {
      f.temporary.indexing.allowed = true;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertBlogIndexingPreflight(f));
  }
});

test('different programs, broken contracts and contradictory flags cannot pass', () => {
  for (const mutate of [
    (f) => {
      f.temporary.releaseId = 'd'.repeat(40);
    },
    (f) => {
      f.api.releaseId = 'local';
    },
    (f) => {
      f.api.articlePublicReadEnabled = false;
    },
    (f) => {
      f.admin.articleDeliveryMode = 'static';
    },
    (f) => {
      f.admin.articlePublishingEnabled = undefined;
    },
    (f) => {
      f.formal.siteOrigin = 'https://another.example';
    },
    (f) => {
      f.formal.indexing.enabled = true;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => assertBlogIndexingPreflight(f));
  }
});

test('a previously opened formal host remains valid while the temporary host stays blocked', () => {
  const f = fixture();
  f.formal.previewOnly = f.temporary.previewOnly = false;
  f.formal.indexing.enabled = f.temporary.indexing.enabled = true;
  f.formal.indexing.allowed = true;
  assert.doesNotThrow(() => assertBlogIndexingPreflight(f));
});
