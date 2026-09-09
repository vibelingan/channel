import assert from 'node:assert/strict';
import test from 'node:test';
import { localSiteUrl } from './local-site-readiness.mjs';
test('recognizes actual CI colored Astro readiness and rejects unrelated or invalid hosts', () => {
  assert.equal(
    localSiteUrl('\x1b[2m┃\x1b[22m Local    \x1b[36mhttp://127.0.0.1:39367/\x1b[39m'),
    'http://127.0.0.1:39367',
  );
  for (const text of [
    'Local http://evil.test:123/',
    'Local http://127.0.0.1:0/',
    'Local http://127.0.0.1:65536/',
    'building…',
  ])
    assert.equal(localSiteUrl(text), undefined);
});
