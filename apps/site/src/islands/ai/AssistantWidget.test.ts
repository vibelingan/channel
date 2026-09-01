import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = new URL('./AssistantWidget.tsx', import.meta.url);

test('the chat transcript follows newly rendered messages without scrolling the page', async () => {
  const source = await readFile(component, 'utf8');
  assert.match(source, /ref=\{transcriptRef\}/);
  assert.match(source, /transcript\.scrollTo\(\{\s*top:\s*transcript\.scrollHeight/);
  assert.match(source, /\[open, status, transcriptVersion\]/);
});
