import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedPreviewTarget } from './shared-detail-preview-target.ts';

test('preview requires an explicit dev-only mode and canonical ID', () => {
  assert.deepEqual(sharedPreviewTarget(true, '?preview=shared&id=product-1&variant=variant-2'), {
    status: 'preview',
    productId: 'product-1',
    requestedId: 'variant-2',
  });
  assert.deepEqual(sharedPreviewTarget(false, '?preview=shared&id=product-1'), {
    status: 'legacy',
  });
  assert.deepEqual(sharedPreviewTarget(true, '?slug=old'), { status: 'legacy' });
});
test('malformed or ambiguous preview URLs fail without falling back to legacy data', () => {
  for (const search of [
    '?preview=shared',
    '?preview=shared&id=',
    '?preview=shared&id=a&id=b',
    '?preview=shared&id=a&slug=b',
    '?preview=shared&id=a&variant=',
    '?preview=shared&id=%00',
    '?preview=shared&id=a&variant=x&variant=y',
  ]) {
    assert.deepEqual(sharedPreviewTarget(true, search), { status: 'invalid' });
  }
});
