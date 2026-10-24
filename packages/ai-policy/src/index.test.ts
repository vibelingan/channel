import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineCitation } from '@vibelingan-channel/ai-engine/port';
import {
  PUBLICATION_BLOCKED,
  enforceGroundedFinal,
  preparePublicTurns,
  redactContactData,
} from './index.ts';

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

/**
 * The gate, end to end. Each case below passed the previous "did any citation
 * come back" check, which is the whole reason these exist.
 */
const approved = (title: string, snippet: string): EngineCitation => ({
  sourceId: `channelkb-g1000-${title}`,
  title: `channelkb-g1000-${title}`,
  snippet,
  retrievedAt: '2026-08-27T00:00:00.000Z',
});

test('a price the sources do not state is replaced by a refusal, not published', () => {
  const result = enforceGroundedFinal({
    type: 'final',
    text: 'The unit price is $12 each.',
    citations: [approved('company', 'Founded in 2012. We make headphones.')],
  });
  assert.equal(result.type, 'final');
  assert.match(result.type === 'final' ? result.text : '', /don’t publish prices/);
  assert.doesNotMatch(result.type === 'final' ? result.text : '', /\$12/);
});

test('a certification the sources DENY is refused', () => {
  const result = enforceGroundedFinal({
    type: 'final',
    text: 'Yes, we hold ISO 9001.',
    citations: [approved('quality', 'We do not hold ISO 9001 at this time.')],
  });
  assert.equal(result.type, 'final');
  assert.match(result.type === 'final' ? result.text : '', /certification details/);
});

test('a value the sources DO state is published unchanged', () => {
  const cited = approved('moq', 'Minimum order quantity is 500 units.');
  const result = enforceGroundedFinal({
    type: 'final',
    text: 'Our minimum order quantity is 500 units.',
    citations: [cited],
  });
  assert.deepEqual(result, {
    type: 'final',
    text: 'Our minimum order quantity is 500 units.',
    citations: [cited],
  });
});

test('an internal document cannot ground a public answer', () => {
  // The exact failure the hosted KB probe found: `hermes-skills-*` returned by
  // vector search on the workspace the website would have used.
  const result = enforceGroundedFinal({
    type: 'final',
    text: 'Our internal escalation path is described below.',
    citations: [
      {
        sourceId: 'hermes-skills-escalation',
        title: 'hermes-skills-escalation',
        snippet: 'Internal only.',
        retrievedAt: '2026-08-27T00:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(result, {
    type: 'error',
    category: PUBLICATION_BLOCKED,
    retriable: false,
    safeDetail: 'no publishable source',
  });
});

test('a mixed public and internal citation set refuses the whole answer', () => {
  const result = enforceGroundedFinal({
    type: 'final',
    text: 'We make headphones.',
    citations: [
      approved('company', 'We make headphones.'),
      {
        sourceId: 'hermes-skills-escalation',
        title: 'hermes-skills-escalation',
        snippet: 'Internal only.',
        retrievedAt: '2026-08-27T00:00:00.000Z',
      },
    ],
  });
  assert.deepEqual(result, {
    type: 'error',
    category: PUBLICATION_BLOCKED,
    retriable: false,
    safeDetail: 'mixed publishable and unpublishable sources',
  });
});

test('an ordinary empty answer is NOT reported as a publication block', () => {
  // The distinction the acceptance test depends on: retrieval finding nothing
  // is routine, and must not be mistakable for the gate refusing to publish.
  const result = enforceGroundedFinal({ type: 'final', text: 'anything', citations: [] });
  assert.equal(result.type, 'error');
  assert.equal(result.type === 'error' ? result.category : '', 'knowledge_empty');
  assert.notEqual(result.type === 'error' ? result.category : '', PUBLICATION_BLOCKED);
});
