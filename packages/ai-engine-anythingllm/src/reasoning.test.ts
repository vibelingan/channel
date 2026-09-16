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

test('a partial REASONING tag at end of stream is withheld, not flushed', () => {
  // Policy change, made deliberately. An earlier version flushed "<thi" as
  // ordinary text on the grounds that it never became a tag. But a stream that
  // dies four characters into "<think" is far more likely to be a truncated
  // reasoning tag than prose, and the cost of the two mistakes is not
  // symmetric: withholding loses four characters, flushing starts leaking the
  // model's deliberation. Non-reasoning partials are still flushed — see the
  // "<span class=" case below.
  assert.equal(run(['Cost <thi']), 'Cost ');
  assert.equal(run(['Cost <span class="x']), 'Cost <span class="x');
});

test('multiple reasoning blocks are all removed', () => {
  assert.equal(run(['<think>a</think>One. <think>b</think>Two.']), 'One. Two.');
});

test('the alternate <reasoning> tag is handled too', () => {
  assert.equal(run(['<reasoning>x</reasoning>Answer.']), 'Answer.');
});

test('a capitalised tag is still stripped', () => {
  // A model that writes <Think> rather than <think> used to stream its whole
  // deliberation through untouched.
  assert.equal(run(['<Think>hidden</Think>Visible.']), 'Visible.');
  assert.equal(run(['<THINK>hidden</THINK>Visible.']), 'Visible.');
});

test('whitespace inside the brackets does not defeat the filter', () => {
  assert.equal(run(['< think >hidden</ think >Visible.']), 'Visible.');
});

test('a tag carrying attributes is still a tag', () => {
  assert.equal(run(['<think type="internal" id="7">hidden</think>Visible.']), 'Visible.');
});

test('the other reasoning tag names this model family uses are covered', () => {
  for (const name of ['thinking', 'thought', 'reflection', 'scratchpad']) {
    assert.equal(run([`<${name}>hidden</${name}>Visible.`]), 'Visible.', `<${name}> leaked`);
  }
});

test('nested reasoning blocks do not leak the outer remainder', () => {
  // Closing the inner tag must not be read as leaving deliberation entirely.
  assert.equal(run(['<think>outer <think>inner</think> still hidden</think>Visible.']), 'Visible.');
});

test('a stray closing tag does not turn ordinary text into deliberation', () => {
  assert.equal(run(['Answer.</think>More answer.']), 'Answer.More answer.');
});

test('ordinary markup in the answer survives', () => {
  assert.equal(run(['Our MOQ is <b>500</b> units.']), 'Our MOQ is <b>500</b> units.');
});

test('a less-than in prose is emitted rather than held to end of stream', () => {
  // A looser rule would withhold everything after the "<" until the stream
  // ended, turning a streaming answer into a non-streaming one.
  const filter = createReasoningFilter();
  const streamed = filter.push('Orders < 500 units are ');
  assert.ok(streamed.includes('< 500'), `held back ordinary prose: ${JSON.stringify(streamed)}`);
});

test('a capitalised tag split across chunks is still stripped', () => {
  assert.equal(run(['<Th', 'ink>hid', 'den</Thi', 'nk>Visible.']), 'Visible.');
});

test('an unclosed capitalised tag never leaks', () => {
  assert.equal(run(['<Think>still deliberating when the stream died']), '');
});

/**
 * The combination that defeated the previous two implementations: a tag that
 * carries an attribute AND is split across chunks. Each half was handled
 * separately; together, the buffer stopped looking like a partial tag the
 * moment an attribute appeared, so it was released as prose — leaking the
 * opening tag and the deliberation behind it.
 */
const SPLIT_TAG_PROBES: [string, string[]][] = [
  ['attribute split at the quote', ['<think type="', 'internal">SECRET</think>Visible.']],
  ['whitespace tag split before the bracket', ['< think ', '>SECRET</ think >Visible.']],
  ['uppercase with a data attribute', ['<THINK data-x=', '"1">SECRET</THINK>Visible.']],
  ['split inside the attribute name', ['<think da', 'ta-x="1">SECRET</think>Visible.']],
  ['split inside a single-quoted value', ["<think a='in", "ternal'>SECRET</think>Visible."]],
  ['closing tag split across chunks', ['<think>SECRET</thi', 'nk>Visible.']],
  ['closing tag with whitespace split', ['<think>SECRET</ thi', 'nk >Visible.']],
];

for (const [name, chunks] of SPLIT_TAG_PROBES) {
  test(`no leak: ${name}`, () => {
    assert.equal(run(chunks), 'Visible.', `leaked with chunks ${JSON.stringify(chunks)}`);
  });
}

test('no leak when a tag arrives one character per chunk, attributes and all', () => {
  for (const source of [
    '<think type="internal">SECRET</think>Visible.',
    "< think foo='1' >SECRET</ think >Visible.",
    '<Thinking depth="3">SECRET</Thinking>Visible.',
  ]) {
    assert.equal(run([...source]), 'Visible.', `leaked one-char-per-chunk: ${source}`);
  }
});

test('a greater-than inside an attribute value does not end the tag early', () => {
  // `<think note="a > b">` closes at the LAST bracket, not the quoted one.
  assert.equal(run(['<think note="a > b">SECRET</think>Visible.']), 'Visible.');
});

test('an unterminated reasoning tag at end of stream leaks nothing', () => {
  assert.equal(run(['<think type="inter']), '');
  assert.equal(run(['<thi']), '');
  assert.equal(run(['Answer. <think dat']), 'Answer. ');
});

test('an unterminated ordinary tag at end of stream is returned as text', () => {
  // It was never deliberation, so withholding it would silently drop answer text.
  assert.equal(run(['Value <span class="x']), 'Value <span class="x');
});

test('nested attribute-bearing tags still close correctly', () => {
  assert.equal(
    run(['<think a="1">outer <think b="2">inner</think> still hidden</think>Visible.']),
    'Visible.',
  );
});
