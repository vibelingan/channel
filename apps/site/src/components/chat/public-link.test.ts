import assert from 'node:assert/strict';
import test from 'node:test';
import { safePublicChatLink } from './public-link';
test('source links are public HTTP links, never executable or credential-bearing URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://user:pass@example.invalid/',
    'https://example.invalid/\nsecret',
  ])
    assert.equal(safePublicChatLink(value, 'https://site.invalid'), undefined);
  assert.equal(
    safePublicChatLink('/headphones', 'https://site.invalid'),
    'https://site.invalid/headphones',
  );
});
