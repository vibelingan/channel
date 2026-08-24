import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { EngineCitation } from '@vibelingan-channel/ai-engine';
import { commitmentValues, topicForCommitments, ungroundedCommitments } from './grounding.ts';

const cite = (snippet: string): EngineCitation[] => [
  { sourceId: '/x', title: 'Source', snippet, retrievedAt: new Date().toISOString() },
];

/**
 * The eight paraphrases that walked past ask-side interception, expressed as
 * the ANSWERS the model would produce. Each carries a concrete value the corpus
 * does not contain, so each fails regardless of how the sentence is built.
 */
const UNGROUNDED_ANSWERS = [
  'For 1000 units, that comes to twelve dollars apiece.',
  'The unit price is $12 each.',
  'Each piece works out at 12 USD.',
  'Yes — arrival before Friday is guaranteed.',
  'Your Brazil order arrives next Friday.',
  'We can knock forty percent off for that volume.',
  'A 40% reduction is approved for 5000 units.',
  'Our facilities maintain ISO 9001 and IATF 16949 certification.',
  'ISO 9001 certification is in place.',
  'Our management systems have passed IATF 16949.',
];

for (const answer of UNGROUNDED_ANSWERS) {
  test(`ungrounded commitment is caught: ${answer.slice(0, 52)}`, () => {
    const unsupported = ungroundedCommitments(answer, cite('MOQ from 500 units. Since 2004.'));
    assert.ok(unsupported.length > 0, `no commitment value detected in: ${answer}`);
  });
}

test('spelled-out and numeric forms of the same value are one claim', () => {
  // "twelve dollars" and "$12" must not be different problems, or an attacker
  // picks the spelling the gate does not know.
  assert.deepEqual(
    commitmentValues('twelve dollars').map((value) => value.token),
    commitmentValues('$12').map((value) => value.token),
  );
  assert.deepEqual(
    commitmentValues('forty percent').map((value) => value.token),
    commitmentValues('40%').map((value) => value.token),
  );
});

test('a value the corpus DOES contain is grounded and allowed through', () => {
  // The gate must not block the assistant from repeating a published fact.
  assert.deepEqual(
    ungroundedCommitments('Our MOQ is 500 units.', cite('brand minimum order: 500 units')),
    [],
  );
  assert.deepEqual(
    ungroundedCommitments(
      'We hold ISO 9001 certification.',
      cite('Certifications: ISO 9001 since 2012'),
    ),
    [],
  );
});

test('an ordinary answer with no commitment value passes untouched', () => {
  for (const answer of [
    'Our factory is in Dongguan, China.',
    'We run eight production lines.',
    'Our OEM process starts with a specification review.',
    "We don't publish prices here. Send us an inquiry.",
  ]) {
    assert.deepEqual(ungroundedCommitments(answer, cite('')), [], `wrongly blocked: ${answer}`);
  }
});

test('a plain quantity is not treated as a commitment', () => {
  // "8 production lines" is a fact the corpus grounds like any other; treating
  // every number as a commitment would block most real answers.
  assert.deepEqual(commitmentValues('We run 8 production lines and 3 shifts.'), []);
});

test('the refusal topic matches the kind of value that was invented', () => {
  assert.equal(topicForCommitments(commitmentValues('40% off')), 'discount');
  assert.equal(topicForCommitments(commitmentValues('$12 each')), 'pricing');
  assert.equal(topicForCommitments(commitmentValues('arrives Friday')), 'delivery-date');
  assert.equal(topicForCommitments(commitmentValues('ISO 9001')), 'certification');
});

test('an answer with no citations cannot ground anything', () => {
  assert.ok(ungroundedCommitments('The price is $12.', []).length > 0);
});
