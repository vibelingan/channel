import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVED_CATEGORY_RULES, classificationTarget } from './catalog-classification.ts';

test('approved clock mapping does not classify industrial or unknown categories', () => {
  assert.equal(classificationTarget('152801', 'new-clock'), 'misc');
  assert.equal(classificationTarget('100007155', 'motor'), null);
  assert.equal(classificationTarget('', 'missing'), null);
  assert.equal(classificationTarget('__proto__', 'unknown'), null);
});

test('mixed categories use explicit reviewed identities, never title or category defaults', () => {
  assert.equal(
    classificationTarget('100001765', '22a0bc9b-2eaa-4f6b-ab6e-82a1053df777'),
    'ai-gadgets',
  );
  assert.equal(classificationTarget('100001765', '258394ec-d04d-4777-a0ab-fa1b14ba4375'), 'toys');
  assert.equal(classificationTarget('100001765', 'new-AI-toy'), null);
  assert.equal(classificationTarget('152801', '22a0bc9b-2eaa-4f6b-ab6e-82a1053df777'), 'misc');
  assert.equal(classificationTarget('63708', '0f5f4aa4-7dd1-42d6-aafd-1a32aaae18a4'), null);
  assert.equal(
    APPROVED_CATEGORY_RULES.some((r) => r.sourceCategoryId === '100007155'),
    false,
  );
});
