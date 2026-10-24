import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogValidationMessage } from './catalog-validation.ts';

test('catalog diagnostics refuse unstructured schema text that may contain private source data', () => {
  assert.equal(
    catalogValidationMessage({
      stage: 'source-candidate',
      issues: ['PRIVATE_SOURCE_TOKEN: invalid value'],
    }),
    undefined,
  );
});
