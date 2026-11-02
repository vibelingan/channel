import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ContractValidationError,
  canonicalizeJson,
  parseContract,
  parseStrictJson,
  validateContract,
} from './index.ts';

const inquiry = JSON.parse(
  readFileSync(new URL('../fixtures/inquiry.json', import.meta.url), 'utf8'),
);

test('contract_rejects_unknown_version', () => {
  assert.throws(() => validateContract('inquiry', { ...inquiry, schema_version: '2.0' }));
});

test('existing confirmed inquiry validates without coercion or chat linkage', () => {
  assert.deepEqual(validateContract('inquiry', inquiry), inquiry);
  assert.throws(() => validateContract('inquiry', { ...inquiry, conversation_id: 'private-chat' }));
  assert.throws(() =>
    validateContract('inquiry', {
      ...inquiry,
      requirements: { confirmed_summary: 'need', quantity: '500' },
    }),
  );
});

test('inquiry attachment references fit the existing reader and lease limit', () => {
  const realistic = JSON.parse(readFileSync(new URL('../fixtures/inquiry.long-attachment.json', import.meta.url), 'utf8'));
  assert.equal(realistic.attachment_refs[0].length, 236);
  assert.deepEqual(validateContract('inquiry', realistic), realistic);
  validateContract('inquiry', { ...inquiry, attachment_refs: ['a'.repeat(1800)] });
  assert.throws(() => validateContract('inquiry', { ...inquiry, attachment_refs: ['a'.repeat(1801)] }));
});

test('strict parsing rejects duplicate decoded keys and lossy numbers', () => {
  for (const raw of [
    '{"id":1,"\\u0069d":2}',
    '9007199254740993',
    '1.0',
    '1e0',
    '{"a":1,}',
    '/*comment*/{}',
  ]) {
    assert.throws(() => parseStrictJson(raw));
  }
});

test('canonical order follows Unicode code points and lexical numeric keys', () => {
  assert.equal(
    canonicalizeJson({ '2': 2, '10': 10, '1': 1, '😀': 1, '\uE000': 2 }),
    '{"1":1,"10":10,"2":2,"":2,"😀":1}',
  );
});

test('canonical JSON rejects non-JSON or lossy values', () => {
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw new Error('getter executed');
    },
  });
  const sparse = new Array(2);
  sparse[1] = 1;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    9007199254740992,
    1n,
    new Date(),
    '\ud800',
    { '\udfff': 1 },
    sparse,
    getter,
    cycle,
  ]) {
    assert.throws(() => canonicalizeJson(value), ContractValidationError);
  }
});

test('strict duplicate keys are rejected before schema validation loses them', () => {
  const raw = JSON.stringify(inquiry).replace(
    '"client_id":',
    '"client_id":"other_client","client_id":',
  );
  assert.throws(() => parseContract('inquiry', raw));
});
