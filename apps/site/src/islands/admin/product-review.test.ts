import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminApiError, decodeProductReviewSummary } from './api.ts';

test('product review summary accepts mapped counts plus uncategorized pending products', () => {
  assert.deepEqual(
    decodeProductReviewSummary({
      pendingTotal: 4,
      byFamily: { headphones: 1, 'ai-gadgets': 0, toys: 1, misc: 0 },
    }),
    {
      pendingTotal: 4,
      byFamily: { headphones: 1, 'ai-gadgets': 0, toys: 1, misc: 0 },
    },
  );
});

test('product review summary rejects malformed and inconsistent values', () => {
  for (const value of [
    null,
    {},
    { pendingTotal: -1, byFamily: {} },
    {
      pendingTotal: 1,
      byFamily: { headphones: 1, 'ai-gadgets': 1, toys: 0, misc: 0 },
    },
    {
      pendingTotal: 1,
      byFamily: { headphones: '1', 'ai-gadgets': 0, toys: 0, misc: 0 },
    },
  ]) {
    assert.throws(
      () => decodeProductReviewSummary(value),
      (error: unknown) => error instanceof AdminApiError && error.code === 'INVALID_RESPONSE',
    );
  }
});
