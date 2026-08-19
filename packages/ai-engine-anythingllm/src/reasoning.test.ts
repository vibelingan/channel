import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createReasoningFilter } from './reasoning.ts';

/** Feed chunks through the filter and collect what a visitor would see. */
function run(chunks: string[]): string {
  const filter = createReasoningFilter();
  return chunks.map((c) => filter.push(c)).join('') + filter.end();
}

test('text with no reasoning block passes through untouched', () => {
  assert.equal(run(['Our MOQ ', 'is 500 units.']), 'Our MOQ is 500 units.');
});

test('a reasoning block is removed entirely', () => {
  assert.equal(
    run(['<think>The user asks about MOQ.</think>Our MOQ is 500 units.']),
    'Our MOQ is 500 units.',
  );
});

test('a reasoning block split across chunk boundaries is still removed', () => {
  // This is the case that matters: tokens arrive in fragments, so the opening
  // tag routinely straddles two chunks and a naive replace never sees it.
  assert.equal(run(['<thi', 'nk>hidden ', 'thoughts</thi', 'nk>Visible.']), 'Visible.');
});

test('a tag split one character per chunk is still removed', () => {
  assert.equal(run([...'<think>secret</think>Answer.'].map((c) => c)), 'Answer.');
});

test('text before a reasoning block is preserved', () => {
  assert.equal(run(['Sure. <think>hmm</think>The MOQ is 500.']), 'Sure. The MOQ is 500.');
});

test('an unclosed reasoning block never leaks, even at end of stream', () => {
  // A truncated stream must not dump the model's deliberation onto the page.
  assert.equal(run(['<think>I am still thinking and the stream died']), '');
});

test('a lone angle bracket is not mistaken for a tag', () => {
  assert.equal(run(['Sizes < 500 units are not accepted.']), 'Sizes < 500 units are not accepted.');
});

test('a partial tag prefix at end of stream is flushed, not swallowed', () => {
  // "<thi" that never completes is real text the visitor should see.
  assert.equal(run(['Cost <thi']), 'Cost <thi');
});

test('multiple reasoning blocks are all removed', () => {
  assert.equal(run(['<think>a</think>One. <think>b</think>Two.']), 'One. Two.');
});

test('the alternate <reasoning> tag is handled too', () => {
  assert.equal(run(['<reasoning>x</reasoning>Answer.']), 'Answer.');
});
