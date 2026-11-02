import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INQUIRY_AUTO_CHECK_DELAYS_MS,
  beginInquiryReview,
  inquiryAfterFailure,
  inquiryCheckStart,
  nextInquiryCheckDelay,
  persistedInquiry,
  restoredInquiry,
  validateInquiry,
} from './inquiry';
import { InquiryRejectedError } from './transport-error';
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
  for (const current of [
    { phase: 'saving' as const, key: 'original', draft, checks: 0, uncertain: false },
    { phase: 'unknown' as const, key: 'original', draft, checks: 0 },
  ]) {
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

const contact = {
  requirement: '500 gifts',
  name: 'Nina',
  email: 'nina@vibelingan.com',
  company: 'VibeLingan',
  consent: true,
};
test('known_rejection_stays_editable: a refusal on a first attempt reopens the same draft with a reason', () => {
  const next = inquiryAfterFailure(
    { phase: 'saving', key: 'k1', draft: contact, checks: 0, uncertain: false },
    new InquiryRejectedError('PRODUCT_UNVERIFIED'),
  );
  assert.equal(next.phase, 'editing');
  assert.ok(next.phase === 'editing' && next.formError);
  assert.deepEqual(next.phase === 'editing' && next.draft, contact);
  assert.equal(next.key, 'k1');
});
test('lost_receipt_recovers_same_submission: an unknown result is rechecked a bounded number of times with the frozen draft', () => {
  let view = inquiryAfterFailure(
    { phase: 'saving', key: 'k1', draft: contact, checks: 0, uncertain: false },
    new Error('Lost after commit'),
  );
  const delays: number[] = [];
  for (;;) {
    assert.equal(view.phase, 'unknown');
    const delay = nextInquiryCheckDelay(view);
    if (delay === null) break;
    delays.push(delay);
    const saving = inquiryCheckStart(view, true);
    assert.ok(saving && saving.phase === 'saving' && saving.key === 'k1' && saving.uncertain);
    assert.deepEqual(saving.draft, contact);
    view = inquiryAfterFailure(saving, new Error('still down'));
  }
  assert.deepEqual(delays, [...INQUIRY_AUTO_CHECK_DELAYS_MS]);
  // A manual check is still possible after the automatic ones run out.
  assert.ok(inquiryCheckStart(view, false));
});
test('a refusal after an uncertain attempt cannot unfreeze a submission that may have been saved', () => {
  const next = inquiryAfterFailure(
    { phase: 'saving', key: 'k1', draft: contact, checks: 1, uncertain: true },
    new InquiryRejectedError('NOT_ACCEPTING'),
  );
  assert.equal(next.phase, 'unknown');
});
test('an inquiry survives refresh: drafts stay editable, in-flight saves come back as unknown', () => {
  const draftView = { phase: 'editing' as const, key: 'k_editing1', draft: contact, errors: {} };
  assert.deepEqual(restoredInquiry(persistedInquiry(draftView)), draftView);
  const saving = {
    phase: 'saving' as const,
    key: 'k_saving01',
    draft: contact,
    checks: 1,
    uncertain: true,
  };
  assert.deepEqual(restoredInquiry(persistedInquiry(saving)), {
    phase: 'unknown',
    key: 'k_saving01',
    draft: contact,
    checks: 1,
  });
  const saved = {
    phase: 'saved' as const,
    key: 'k_saved001',
    draft: contact,
    receipt: { reference: `ai_${'b'.repeat(64)}` },
  };
  assert.deepEqual(restoredInquiry(persistedInquiry(saved)), saved);
  assert.equal(persistedInquiry({ phase: 'closed' }), undefined);
});
