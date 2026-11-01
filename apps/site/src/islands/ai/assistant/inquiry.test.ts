import assert from 'node:assert/strict';
import test from 'node:test';
import { beginInquiryReview, validateInquiry } from './inquiry';
const draft = {
  requirement: '500 company gifts; model not decided',
  email: 'buyer@example.invalid',
  name: '',
  company: '',
  consent: false,
};
test('a vague purchase without a SKU is valid only after explicit contact consent', () => {
  assert.ok(validateInquiry(draft).consent);
  assert.deepEqual(validateInquiry({ ...draft, consent: true }), {});
});
test('invalid fields have specific errors without changing the input', () => {
  const input = { ...draft, email: 'bad', requirement: '' };
  const before = structuredClone(input);
  assert.deepEqual(Object.keys(validateInquiry(input)).sort(), ['consent', 'email', 'requirement']);
  assert.deepEqual(input, before);
});

test('reviewing updated requirements keeps contact fields, resets consent and changes an unsent key', () => {
  const current = {
    phase: 'editing' as const,
    key: 'old',
    errors: {},
    draft: {
      requirement: '500 headphones',
      name: 'Buyer',
      email: 'buyer@example.invalid',
      company: 'BuyerCo',
      consent: true,
    },
  };
  const next = beginInquiryReview(
    current,
    { requirement: '700 headphones with logo', explicitUpdate: true },
    () => 'new',
  );
  assert.equal(next.phase, 'editing');
  if (next.phase !== 'editing') throw new Error('expected review');
  assert.equal(next.draft.requirement, '700 headphones with logo');
  assert.equal(next.draft.email, current.draft.email);
  assert.equal(next.draft.consent, false);
  assert.equal(next.key, 'new');
  assert.equal(
    beginInquiryReview(current, { requirement: 'other', explicitUpdate: false }, () => 'new'),
    current,
  );
});
test('an uncertain or saving inquiry is frozen, while a saved inquiry needs an explicit new proposal', () => {
  const draft = {
    requirement: '500 gifts',
    name: 'Buyer',
    email: 'buyer@example.invalid',
    company: 'BuyerCo',
    consent: true,
  };
  for (const phase of ['saving', 'unknown'] as const) {
    const current = { phase, key: 'original', draft };
    assert.equal(
      beginInquiryReview(current, { requirement: '700 gifts', explicitUpdate: true }, () => 'new'),
      current,
    );
  }
  const saved = {
    phase: 'saved' as const,
    key: 'original',
    draft,
    receipt: { reference: 'ai_saved' },
  };
  assert.equal(
    beginInquiryReview(saved, { requirement: '700 gifts', explicitUpdate: false }, () => 'new'),
    saved,
  );
  const next = beginInquiryReview(
    saved,
    { requirement: '700 gifts', explicitUpdate: true },
    () => 'new',
  );
  assert.equal(next.phase, 'editing');
});
