import { strict as assert } from 'node:assert';
import test from 'node:test';
import { COMMITMENT_TOPICS, classifyCommitmentRequest, templateFor } from './commitments.ts';

/** Asks that MUST be answered by policy, never by the model. */
const MUST_REFUSE: [string, string][] = [
  ['pricing', 'What is the exact unit price in USD for 1000 wireless earbuds?'],
  ['pricing', 'How much for 5000 units?'],
  ['pricing', 'Can you quote me for a run of 2000?'],
  ['pricing', 'What does it cost per unit?'],
  ['pricing', 'Send me your price list.'],
  ['discount', 'Give me a 40% discount if I order 5000 units today.'],
  ['discount', 'Can you do better on price?'],
  ['discount', 'What is your best price for 10000 units?'],
  ['discount', 'Any chance of a deal on a larger order?'],
  ['delivery-date', 'Can you ship to Brazil by next Friday?'],
  ['delivery-date', 'What is your lead time for 3000 units?'],
  ['delivery-date', 'When will you deliver if I order today?'],
  ['delivery-date', 'How soon can I have them?'],
  ['certification', 'Are you ISO 9001 and IATF 16949 certified?'],
  ['certification', 'Do you have RoHS compliance certificates?'],
  ['certification', 'Is your factory certified?'],
];

for (const [topic, question] of MUST_REFUSE) {
  test(`policy answers: ${question}`, () => {
    const policy = classifyCommitmentRequest(question);
    assert.ok(policy, `no policy matched, so the model would answer: ${question}`);
    assert.equal(policy.topic, topic);
    assert.equal(policy.template, templateFor(topic as never));
  });
}

/** Ordinary questions the website answers. The model must still handle these. */
const MUST_REACH_ENGINE = [
  'What is your minimum order quantity for headphones?',
  'Where is your factory?',
  'How long have you been in business?',
  'What does your OEM development process involve?',
  'What kinds of products do you make?',
  'Do you do industrial design in house?',
  'How many production lines do you have?',
  'What materials do you work with?',
];

for (const question of MUST_REACH_ENGINE) {
  test(`engine answers: ${question}`, () => {
    assert.equal(
      classifyCommitmentRequest(question),
      null,
      `policy hijacked an ordinary question: ${question}`,
    );
  });
}

test('every topic has a template that routes to a person', () => {
  for (const topic of COMMITMENT_TOPICS) {
    const template = templateFor(topic);
    assert.ok(template.length > 40, `${topic} template is too thin to be an answer`);
    assert.match(template, /inquiry/i, `${topic} template gives no route to a human`);
  }
});

test('no template states a figure', () => {
  // The templates are the whole answer for these topics, so a number in one
  // would be a commitment shipped in our own code.
  for (const topic of COMMITMENT_TOPICS) {
    assert.ok(
      !/(?:\$\s?\d|\d+\s?%|\d+\s?(?:usd|dollars))/i.test(templateFor(topic)),
      `${topic} template names a figure`,
    );
  }
});

test('empty and non-string input is not a commitment request', () => {
  assert.equal(classifyCommitmentRequest(''), null);
  assert.equal(classifyCommitmentRequest('   '), null);
  assert.equal(classifyCommitmentRequest(undefined as never), null);
});
