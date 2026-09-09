import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('website contact and structured data use the client approved sales mailbox', () => {
  const content = readFileSync(new URL('./content/en-US.md', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../layouts/BaseLayout.astro', import.meta.url), 'utf8');
  assert.match(content, /Email: sales@supplychainsai\.com/);
  assert.match(content, /mailto:sales@supplychainsai\.com/);
  assert.equal((layout.match(/email: 'sales@supplychainsai\.com'/g) ?? []).length, 2);
  assert.doesNotMatch(content + layout, /info@supplychainsai\.com/);
});
