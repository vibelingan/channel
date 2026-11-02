import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INQUIRY_AUTO_CHECK_DELAYS_MS,
  applyInquiryUpdate,
  inquiryAfterFailure,
  inquiryChanges,
  inquiryCheckStart,
  inquiryReceipt,
  keepInquiryDraft,
  nextInquiryCheckDelay,
  persistedInquiry,
  proposeInquiry,
  restoredInquiry,
  validateInquiry,
} from './inquiry';
import type { InquiryDraft, PublicProduct } from './model';
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

const editing = (patch: Partial<InquiryDraft> = {}) => ({
  phase: 'editing' as const,
  key: 'old',
  errors: {},
  draft: {
    requirement: '500 headphones',
    name: 'Buyer',
    email: 'buyer@example.invalid',
    company: 'BuyerCo',
    consent: true,
    ...patch,
  },
});
const productA: PublicProduct = {
  id: 'pa',
  revision: 'r1',
  name: 'Headphone A',
  summary: 'A',
  href: '/products/pa',
};
const productB = { ...productA, id: 'pb', name: 'Headphone B', href: '/products/pb' };
test('model_update_shows_change_summary: a conversation suggestion waits on the card with old and new values', () => {
  const current = editing();
  const next = proposeInquiry(
    current,
    { origin: 'conversation', requirement: '700 headphones with logo' },
    () => 'new',
  );
  assert.ok(next.phase === 'editing' && next.pending);
  if (next.phase !== 'editing' || !next.pending) return;
  assert.deepEqual(next.draft, current.draft);
  assert.deepEqual(inquiryChanges(next.draft, next.pending), [
    { field: 'requirement', before: '500 headphones', after: '700 headphones with logo' },
  ]);
  assert.equal(
    proposeInquiry(current, { origin: 'conversation', requirement: ' 500 headphones ' }, () => 'x'),
    current,
  );
});
test('changed_need_preserves_contact_and_clears_consent: using an update keeps contact, needs consent again and changes the unsent key', () => {
  const proposed = proposeInquiry(
    editing(),
    { origin: 'conversation', requirement: '700 headphones with logo' },
    () => 'unused',
  );
  const next = applyInquiryUpdate(proposed, () => 'new');
  assert.ok(next.phase === 'editing');
  if (next.phase !== 'editing') return;
  assert.equal(next.draft.requirement, '700 headphones with logo');
  assert.equal(next.draft.email, 'buyer@example.invalid');
  assert.equal(next.draft.company, 'BuyerCo');
  assert.equal(next.draft.consent, false);
  assert.equal(next.key, 'new');
  assert.equal(next.pending, undefined);
});
test('manual_edit_not_overwritten_silently: keeping the current draft drops the suggestion and keeps the visitor text and consent', () => {
  const mine = editing({ requirement: '500 headphones, my own wording' });
  const proposed = proposeInquiry(
    mine,
    { origin: 'conversation', requirement: '700 headphones' },
    () => 'x',
  );
  const kept = keepInquiryDraft(proposed);
  assert.deepEqual(kept, mine);
});
test('two_products_do_not_silently_swap_draft: a second product card asks first, an empty product is filled directly', () => {
  const withA = editing({ product: productA });
  const asked = proposeInquiry(withA, { origin: 'visitor', product: productB }, () => 'x');
  assert.ok(asked.phase === 'editing' && asked.pending);
  assert.equal(asked.phase === 'editing' && asked.draft.product?.id, 'pa');
  assert.deepEqual(
    asked.phase === 'editing' && asked.pending && inquiryChanges(asked.draft, asked.pending),
    [{ field: 'product', before: 'Headphone A', after: 'Headphone B' }],
  );
  const filled = proposeInquiry(editing(), { origin: 'visitor', product: productA }, () => 'k2');
  assert.ok(filled.phase === 'editing' && !filled.pending);
  assert.equal(filled.phase === 'editing' && filled.draft.product?.id, 'pa');
  assert.equal(filled.phase === 'editing' && filled.draft.consent, false);
  const refreshed = { ...productA, revision: 'r2' };
  const changed = proposeInquiry(withA, { origin: 'conversation', product: refreshed }, () => 'x');
  assert.deepEqual(
    changed.phase === 'editing' &&
      changed.pending &&
      inquiryChanges(changed.draft, changed.pending),
    [{ field: 'product', before: 'Headphone A', after: 'Headphone A (updated details)' }],
  );
});
test('only the visitor opens a draft; a frozen submission is never changed', () => {
  assert.deepEqual(
    proposeInquiry({ phase: 'closed' }, { origin: 'conversation', requirement: '700' }, () => 'k'),
    { phase: 'closed' },
  );
  const opened = proposeInquiry(
    { phase: 'closed' },
    { origin: 'visitor', requirement: ' 700 gifts ', product: productA },
    () => 'k',
  );
  assert.deepEqual(opened, {
    phase: 'editing',
    key: 'k',
    errors: {},
    draft: {
      name: '',
      email: '',
      company: '',
      requirement: '700 gifts',
      consent: false,
      product: productA,
    },
  });
  const { draft } = editing();
  for (const current of [
    { phase: 'saving' as const, key: 'original', draft, checks: 0, uncertain: false },
    { phase: 'unknown' as const, key: 'original', draft, checks: 0 },
  ])
    for (const origin of ['visitor', 'conversation'] as const)
      assert.equal(
        proposeInquiry(current, { origin, requirement: '700 gifts' }, () => 'new'),
        current,
      );
});
test('saved_receipt_does_not_resubmit: after saving, the conversation cannot start another inquiry; the visitor can', () => {
  const saved = {
    phase: 'saved' as const,
    key: 'original',
    draft: { ...editing().draft, product: productA },
    receipt: { reference: 'ai_saved' },
  };
  assert.equal(
    proposeInquiry(saved, { origin: 'conversation', requirement: 'ok, thanks' }, () => 'new'),
    saved,
  );
  const next = proposeInquiry(saved, { origin: 'visitor', requirement: '200 more' }, () => 'new');
  assert.ok(next.phase === 'editing');
  assert.equal(next.phase === 'editing' && next.key, 'new');
  assert.equal(next.phase === 'editing' && next.draft.email, 'buyer@example.invalid');
  assert.equal(next.phase === 'editing' && next.draft.consent, false);
  assert.deepEqual(inquiryReceipt(saved), {
    reference: 'ai_saved',
    requirement: '500 headphones',
    product: 'Headphone A',
  });
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
