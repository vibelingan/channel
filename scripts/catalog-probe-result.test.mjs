import assert from 'node:assert/strict';
import test from 'node:test';
import { readCatalogProbeResult } from './catalog-probe-result.mjs';
const result = {
  purpose: 'catalog-seo-live-probe-v1',
  environment: 'diversity-123-d9grnqfux221323bb',
  prefix: 'seo_probe_40910382710_',
  checks: [
    'real-product-save-and-request-transaction',
    'repeat-consumption-does-not-duplicate',
    'public-change-advances-version',
    'real-database-aborts-product-and-queue-together',
    'real-transaction-blocks-save-during-delivery',
    'known-failure-releases-only-owned-task',
    'real-batched-page-availability-query',
    'withdrawal-invalidates-ready-page',
    'unknown-outcome-prevents-takeover',
    'real-approved-variant-pagination',
  ],
  passed: 10,
  businessCollectionsAccessed: 0,
  websiteWrites: 0,
  htmlDeliveryVerified: false,
  approvedVariantCount: 137,
};
const response = { RequestId: 'request', RetMsg: JSON.stringify(result), ErrMsg: '' };
test('legacy SDK responses may omit old optional fields but must return the actual complete probe result', () => {
  assert.deepEqual(readCatalogProbeResult(response, '40910382710'), result);
});
test('async, failed and incomplete invocation replies cannot authorize cleanup', () => {
  for (const bad of [
    { ...response, InvokeFinished: 0 },
    { ...response, RetCode: 1 },
    { ...response, ErrMsg: 'failed' },
    { ...response, RetMsg: 'null' },
    { ...response, RetMsg: '{' },
    { ...response, RequestId: '' },
    {
      ...response,
      RetMsg: JSON.stringify({ ...result, checks: result.checks.map(() => result.checks[0]) }),
    },
    { ...response, RetMsg: JSON.stringify({ ...result, passed: 8 }) },
    { ...response, RetMsg: JSON.stringify({ ...result, prefix: 'other_' }) },
  ])
    assert.throws(() => readCatalogProbeResult(bad, '40910382710'));
});
