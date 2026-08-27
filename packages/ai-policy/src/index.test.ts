import assert from 'node:assert/strict';
import test from 'node:test';
import { enforceGroundedFinal, preparePublicTurns, redactContactData } from './index.ts';

test('contact details are removed before context crosses the model boundary', () => {
  const input = 'Email alice@example.com or call +1 (415) 555-0123 about MOQ.';
  const output = redactContactData(input);
  assert.equal(output, 'Email [email redacted] or call [phone redacted] about MOQ.');
  assert.doesNotMatch(output, /alice|415|0123/);
});

test('context is bounded and preserves public visitor/assistant roles', () => {
  const turns = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? ('visitor' as const) : ('assistant' as const),
    text: `turn-${index}`,
  }));
  const prepared = preparePublicTurns(turns);
  assert.equal(prepared.length, 20);
  assert.equal(prepared[0]?.text, 'turn-5');
  assert.equal(prepared.at(-1)?.text, 'turn-24');
});

test('empty or uncited final is converted to a fail-closed knowledge error', () => {
  assert.deepEqual(enforceGroundedFinal({ type: 'final', text: 'MOQ is 500', citations: [] }), {
    type: 'error',
    category: 'knowledge_empty',
    retriable: false,
    safeDetail: 'grounded final required',
  });
});
