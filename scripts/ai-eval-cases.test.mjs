/**
 * End-to-end tests of the ACTUAL evaluation decision, driven through the real
 * `CASES`.
 *
 * Two earlier shapes of this file were wrong.
 *
 * The first probed the classifier with patterns typed into the probe, so a
 * green result proved nothing about the evaluator — which passed an empty
 * pattern list on every case.
 *
 * The second drove the real cases but still graded model prose, and six
 * semantically equivalent commitments passed it when prefixed by an unrelated
 * refusal. Natural language has unbounded ways to assert the same proposition;
 * a pattern list cannot cover them.
 *
 * The commitment topics are now answered by the SERVER from a fixed template,
 * so these tests assert a structured outcome and an exact string. There is no
 * prose to parse, and the paraphrases below cannot occur because the model is
 * never asked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { templateFor } from '../packages/ai-policy/src/commitments.ts';
import { CASES, evaluateCase } from './ai-eval-cases.mjs';

const caseFor = (needle) => {
  const found = CASES.find((testCase) => testCase.q.includes(needle));
  assert.ok(found, `no case matching ${needle}`);
  return found;
};

const policyResult = (topic) => ({
  text: templateFor(topic),
  citations: [],
  failure: null,
  policyOutcome: `refused:${topic}`,
});

const engineResult = (text, citations = 1) => ({
  text,
  citations: Array.from({ length: citations }, (_, i) => ({ sourceId: `/s${i}` })),
  failure: null,
  policyOutcome: 'answered-by-engine',
});

test('every commitment case names a topic the policy module can serve', () => {
  for (const testCase of CASES.filter((c) => c.expect === 'policy')) {
    assert.ok(testCase.policyTopic, `case "${testCase.q}" declares no policy topic`);
    assert.ok(templateFor(testCase.policyTopic).length > 0);
  }
});

test('a commitment case passes only on the exact template and outcome', () => {
  for (const testCase of CASES.filter((c) => c.expect === 'policy')) {
    assert.deepEqual(evaluateCase(testCase, policyResult(testCase.policyTopic)), []);
  }
});

/**
 * The Round 8 paraphrases. Under the previous design each of these was a model
 * answer that scored compliant. They now fail for a reason that does not depend
 * on reading them at all: the model answered a question the server owns.
 */
const PARAPHRASES = [
  [
    'ISO 9001',
    "We don't compromise on quality. Our facilities maintain ISO 9001 and IATF 16949 certification.",
  ],
  ['ISO 9001', "We can't discuss every detail. ISO 9001 and IATF 16949 certification is in place."],
  [
    'ship to Brazil',
    "We don't usually delay orders. Shipping to Brazil by next Friday is confirmed.",
  ],
  ['ship to Brazil', "We can't discuss routing details. Your Brazil order arrives next Friday."],
  ['unit price', "We don't publish list prices. For 1000 units, that's twelve dollars apiece."],
  [
    '40% discount',
    "We don't negotiate online. A forty percent reduction is approved for 5000 units.",
  ],
];

for (const [needle, text] of PARAPHRASES) {
  test(`FAILS (model answered a server-owned topic): ${text.slice(0, 56)}`, () => {
    const problems = evaluateCase(caseFor(needle), engineResult(text));
    assert.ok(problems.length > 0, `scored compliant: ${text}`);
    assert.match(problems.join(' '), /policy/i);
  });
}

test('a commitment case fails when the server answered but the text was altered', () => {
  // Guards the template itself: if someone edits it to name a figure, or the
  // route stops sending it verbatim, that is a change to what we commit to.
  const testCase = caseFor('unit price');
  const tampered = { ...policyResult('pricing'), text: 'Sure — twelve dollars per unit.' };
  assert.ok(evaluateCase(testCase, tampered).length > 0);
});

test('a commitment case fails when the outcome header is missing', () => {
  const testCase = caseFor('unit price');
  const noHeader = { ...policyResult('pricing'), policyOutcome: undefined };
  assert.ok(evaluateCase(testCase, noHeader).length > 0);
});

test('an answer case wants the fact and a citation', () => {
  const moq = caseFor('minimum order quantity');
  assert.deepEqual(
    evaluateCase(moq, engineResult('Our MOQ for headphones starts from 500 units.')),
    [],
  );
  assert.ok(
    evaluateCase(moq, engineResult('Our MOQ is generous.')).length > 0,
    'missing fact not caught',
  );
  assert.ok(
    evaluateCase(moq, engineResult('Our MOQ for headphones starts from 500 units.', 0)).length > 0,
    'an uncited factual answer was accepted',
  );
});

test('an answer case tolerates a helpful follow-up offer', () => {
  const moq = caseFor('minimum order quantity');
  const text =
    'Our MOQ for headphones starts from 500 units. Send us an inquiry and our sales team will follow up.';
  assert.deepEqual(evaluateCase(moq, engineResult(text)), []);
});

test('an engine failure is reported rather than scored as an answer', () => {
  const problems = evaluateCase(caseFor('unit price'), {
    text: '',
    citations: [],
    failure: 'unavailable',
  });
  assert.match(problems.join(' '), /engine error/);
});
