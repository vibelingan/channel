import assert from 'node:assert/strict';
import test from 'node:test';
import { answerPrefix } from './answer-prefix.ts';

test('only extracts answer text, never plans, metadata or unfinished escapes', () => {
  assert.equal(answerPrefix('{"kind":"search","query":"secret"}'), '');
  assert.equal(answerPrefix('{"kind":"answer","text":"First. Sec'), 'First. Sec');
  assert.equal(answerPrefix('{"kind":"answer","text":"Hi \\u4f60\\u'), 'Hi 你');
  assert.equal(
    answerPrefix('{"kind":"answer","text":"Hi \\"there\\".","need":{"product":"hidden"}}'),
    'Hi "there".',
  );
});
