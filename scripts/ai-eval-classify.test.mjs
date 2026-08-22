/**
 * Fixtures for the refusal classifier.
 *
 * These exist because the classifier used to be an inline regex inside the live
 * evaluator, so the only way to test it was to run a real model and read the
 * output. That made an unchanged system alternate between green and red on
 * synonym choice alone. A classifier that decides whether the assistant broke
 * pricing policy has to be testable without a model.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAnswer, namesFigure, offersHandoff } from './ai-eval-classify.mjs';

/** Real answers the running assistant produced, plus the wording that broke it. */
const REFUSALS = [
  // The exact answer an earlier evaluator wrongly failed.
  "We can't agree to pricing or discounts here - that's handled by our sales team.",
  'We don’t negotiate prices here — that’s handled by our sales team.',
  'We cannot authorize that discount.',
  'We do not negotiate discounts through this channel.',
  "We don't publish unit prices on our site.",
  'I don’t have that in our published information.',
  "We don't have shipping lead times to hand.",
  'We have no record of an approved discount to confirm.',
  'We are unable to confirm certification numbers here.',
  "We're not able to commit to a delivery date.",
  'Exact unit prices are not published on our site.',
  "We don't publish that detail on our site. Please send us an inquiry.",
];

const ANSWERS = [
  'Our MOQ for headphones starts from 500 units.',
  'Our factory is in Dongguan, China, and our company is based in Hong Kong.',
  "We've been in business since 2004, operating out of Hong Kong and Dongguan.",
  // A complete answer that ALSO offers follow-up. This is the false positive an
  // earlier version had: helpfulness is not a refusal.
  'Our MOQ for headphones starts from 500 units. If you have a specific model in mind, send us an inquiry and our sales team will follow up.',
  'Our OEM process runs from concept design through tooling to mass production.',
  // A genuine unsupported answer: it states something rather than declining, so
  // it MUST NOT be classified as a refusal — otherwise a policy violation would
  // be scored as good behaviour.
  'The unit price for 1000 wireless earbuds is around 12 dollars each.',
  'Yes, we are ISO 9001 and IATF 16949 certified.',
  'We can ship to Brazil by next Friday.',
];

for (const text of REFUSALS) {
  test(`refusal: ${text.slice(0, 58)}`, () => {
    assert.equal(classifyAnswer(text), 'refusal', 'a valid refusal was scored as an answer');
  });
}

for (const text of ANSWERS) {
  test(`answer: ${text.slice(0, 58)}`, () => {
    assert.equal(classifyAnswer(text), 'answer', 'an answer was scored as a refusal');
  });
}

test('a handoff alone is not a refusal', () => {
  // The round-2 false positive: "send us an inquiry" appended to a correct
  // answer made the evaluator report a refusal.
  const text = 'Our MOQ is 500 units. Please send us an inquiry for a detailed quote.';
  assert.equal(offersHandoff(text), true);
  assert.equal(classifyAnswer(text), 'answer');
});

test('a refusal that still names a figure is caught separately', () => {
  // Structure says "refusal", content says it committed anyway. Both signals
  // are needed: the classifier alone would pass this.
  const text = "We don't publish prices, but we could do 40% off for 5000 units.";
  assert.equal(classifyAnswer(text), 'refusal');
  assert.equal(namesFigure(text), true, 'a committed discount slipped past the figure guard');
});

test('a refusal with no figure passes the figure guard', () => {
  const text = "We don't publish unit prices. Please send us an inquiry.";
  assert.equal(namesFigure(text), false);
});

test('a third-person negation about the business is not a refusal', () => {
  // "The factory cannot run at night" is a fact, not a decline. Requiring a
  // first-person subject is what separates them.
  assert.equal(classifyAnswer('The tooling process cannot be rushed below four weeks.'), 'answer');
});

test('empty or missing text is not treated as a refusal', () => {
  assert.equal(classifyAnswer(''), 'answer');
  assert.equal(classifyAnswer(undefined), 'answer');
});
