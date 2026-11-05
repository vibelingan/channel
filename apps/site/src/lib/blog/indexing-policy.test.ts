import assert from 'node:assert/strict';
import test from 'node:test';
import { blogRequestIndexing } from './indexing-policy.ts';

const origin = 'https://supplychainsai.com';
const input = { siteOrigin: origin, requestHost: 'supplychainsai.com', previewFlag: '0' };

test('only an explicitly enabled canonical host can expose Blog indexing', () => {
  assert.deepEqual(blogRequestIndexing(input), {
    enabled: true,
    canonicalHost: true,
    allowed: true,
  });
  assert.equal(blogRequestIndexing({ ...input, requestHost: 'SUPPLYCHAINSAI.COM' }).allowed, true);
  for (const previewFlag of [undefined, '', '1', 'false', 'true']) {
    const state = blogRequestIndexing({ ...input, previewFlag });
    assert.equal(state.enabled, false);
    assert.equal(state.allowed, false);
  }
});

test('temporary, missing, malformed and unrelated hosts remain blocked', () => {
  for (const requestHost of [
    null,
    '',
    'blog-pages-example.sh.run.tcloudbase.com',
    'supplychainsai.com.evil.example',
    'supplychainsai.com,evil.example',
    'supplychainsai.com:8080',
    'user@supplychainsai.com',
    'supplychainsai.com/path',
  ]) {
    assert.equal(blogRequestIndexing({ ...input, requestHost }).allowed, false);
  }
});

test('a forwarded-host claim cannot override the direct HTTP host', () => {
  const request = new Request('https://temporary.example/blog/', {
    headers: {
      host: 'temporary.example',
      'x-forwarded-host': 'supplychainsai.com',
      forwarded: 'host=supplychainsai.com;proto=https',
    },
  });
  assert.equal(
    blogRequestIndexing({ ...input, requestHost: request.headers.get('host') }).allowed,
    false,
  );
});

test('unknown origins fail closed; a loopback build remains testable', () => {
  for (const siteOrigin of [
    undefined,
    '',
    'not a URL',
    'https://user@site.example',
    `${origin}/blog`,
    'http://public.example',
  ])
    assert.equal(blogRequestIndexing({ ...input, siteOrigin }).allowed, false);
  assert.equal(
    blogRequestIndexing({
      ...input,
      siteOrigin: 'http://localhost:4321',
      requestHost: 'localhost:4321',
    }).allowed,
    true,
  );
});
