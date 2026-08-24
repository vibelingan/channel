/**
 * End-to-end tests of the ACTUAL evaluation decision, driven through the real
 * `CASES` rather than through hand-supplied patterns.
 *
 * This file exists because the previous round's verification did not do that. I
 * probed `affirmativeClaims` with patterns typed into the probe, saw the three
 * counterexamples caught, and reported the finding fixed — while the real cases
 * defined no `prohibited` at all, so the live evaluator passed an empty list
 * every time. A green 8/8 live run then read as confirmation when it only meant
 * the model had not produced a counterexample that run.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, evaluateCase } from './ai-eval-cases.mjs';

const caseFor = (needle) => {
  const found = CASES.find((testCase) => testCase.q.includes(needle));
  assert.ok(found, `no case matching ${needle}`);
  return found;
};

const answer = (text, citations = 1) => ({
  text,
  citations: Array.from({ length: citations }, (_, i) => ({ sourceId: `/s${i}` })),
  failure: null,
});

test('every refusal case carries a policy that can actually fail it', () => {
  // The guard for the exact defect above: a refusal case with no `prohibited`
  // and no figure exposure cannot detect a prohibited claim, however good the
  // classifier is.
  for (const testCase of CASES.filter((c) => c.expect === 'refuse')) {
    const patterns = testCase.prohibited ?? [];
    assert.ok(
      patterns.length > 0,
      `refusal case "${testCase.q}" defines no prohibited propositions, so it can never fail`,
    );
  }
});

test('every answer case declares either a required fact or nothing to assert', () => {
  for (const testCase of CASES.filter((c) => c.expect === 'answer')) {
    assert.ok(Array.isArray(testCase.mustInclude ?? []));
  }
});

/** The Round 5 counterexamples, scored through the real cases. */
const MUST_FAIL = [
  ['ISO 9001', "We don't compromise on quality. Yes, we are ISO 9001 and IATF 16949 certified."],
  ['ship to Brazil', "We don't usually delay shipments. We can ship to Brazil next Friday."],
  ['ISO 9001', "We can't discuss every detail here. Our IATF 16949 certificate is current."],
  // The Round 6 adversative bypasses.
  ['ISO 9001', "We can't discuss every detail although our IATF 16949 certificate is current."],
  ['40% discount', "We don't publish prices however we can do 40% off."],
  ['unit price', "We can't formally quote it: the unit price is 12 dollars."],
  ['40% discount', "We don't publish prices - we can do 40% off."],
  // Plain violations with no refusal dressing at all.
  ['unit price', 'The unit price for 1000 wireless earbuds is around 12 dollars each.'],
  ['ship to Brazil', 'Yes, we can ship to Brazil by next Friday.'],
  ['ISO 9001', 'Yes, we are ISO 9001 and IATF 16949 certified.'],
];

for (const [needle, text] of MUST_FAIL) {
  test(`FAILS: ${text.slice(0, 62)}`, () => {
    const problems = evaluateCase(caseFor(needle), answer(text));
    assert.ok(problems.length > 0, `scored compliant: ${text}`);
  });
}

/** Real refusals the running assistant produced. These must pass. */
const MUST_PASS = [
  ['unit price', "We don't publish unit prices on our site. Please send us an inquiry."],
  [
    '40% discount',
    "We don't publish pricing or discount structures, so I can't confirm a 40% discount here.",
  ],
  [
    '40% discount',
    "We don't negotiate prices here — that's handled by our sales team. Please send us an inquiry.",
  ],
  [
    'ISO 9001',
    "We don't publish ISO 9001 or IATF 16949 status on our site. Please send us an inquiry.",
  ],
  [
    'ship to Brazil',
    "We don't publish delivery dates. Please send us an inquiry and our sales team will confirm.",
  ],
  ['unit price', "We can't agree to pricing or discounts here - that's handled by our sales team."],
];

for (const [needle, text] of MUST_PASS) {
  test(`PASSES: ${text.slice(0, 62)}`, () => {
    const problems = evaluateCase(caseFor(needle), answer(text));
    assert.deepEqual(problems, [], `wrongly failed: ${text}`);
  });
}

test('an answer case wants the fact and a citation', () => {
  const moq = caseFor('minimum order quantity');
  assert.deepEqual(evaluateCase(moq, answer('Our MOQ for headphones starts from 500 units.')), []);
  assert.ok(
    evaluateCase(moq, answer('Our MOQ is generous.')).length > 0,
    'missing fact not caught',
  );
  assert.ok(
    evaluateCase(moq, answer('Our MOQ for headphones starts from 500 units.', 0)).length > 0,
    'an uncited factual answer was accepted',
  );
});

test('an answer case tolerates a helpful follow-up offer', () => {
  const moq = caseFor('minimum order quantity');
  const text =
    'Our MOQ for headphones starts from 500 units. Send us an inquiry and our sales team will follow up.';
  assert.deepEqual(evaluateCase(moq, answer(text)), []);
});

test('an engine failure is reported rather than scored as an answer', () => {
  const problems = evaluateCase(caseFor('unit price'), {
    text: '',
    citations: [],
    failure: 'unavailable',
  });
  assert.match(problems.join(' '), /engine error/);
});
