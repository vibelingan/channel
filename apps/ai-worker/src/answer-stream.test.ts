import assert from 'node:assert/strict';
import test from 'node:test';
import { GroundedAnswerStream } from './answer-stream.ts';
const sources = [
  {
    sourceId: 'channelkb/public',
    title: 'Company',
    snippet: 'We make gifts.',
    retrievedAt: new Date().toISOString(),
  },
];

test('complete sentences pass the same policy before delivery; no evidence means no preview', () => {
  const stream = new GroundedAnswerStream('channelkb');
  assert.equal(stream.accept('We make gifts.', sources), 'We make gifts.');
  assert.equal(stream.accept(' We support OEM.', sources), ' We support OEM.');
  assert.equal(stream.delivered, 'We make gifts. We support OEM.');
  assert.equal(new GroundedAnswerStream('channelkb').accept('Secret.', []), undefined);
});
test('internal sources or invented promises stop streaming, without publishing the rejected sentence', () => {
  const source = sources[0];
  assert.ok(source);
  for (const evidence of [sources, [{ ...source, sourceId: 'internal' }]]) {
    const stream = new GroundedAnswerStream('channelkb');
    assert.equal(stream.accept('We guarantee a price of $12 per unit.', evidence), undefined);
    assert.equal(stream.delivered, '');
    assert.equal(stream.accept(' Anything else.', sources), undefined);
  }
});
