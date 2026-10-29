import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInquiry } from './inquiry';
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
