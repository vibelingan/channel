import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { safeFields } from './blog/cloud-readiness-fields.mjs';
test('billing readback keeps approved numbers and flags while excluding user, credential and arbitrary raw fields', () => {
  const projected = safeFields({
    EnvInfo: { EnvId: 'fixed', SecretId: 'secret', Users: [{ token: 'private' }] },
    BillingInfo: {
      IsAutoRenew: false,
      PayMode: 'PREPAYMENT',
      ExpireTime: '2026-12-01',
      Raw: 'private',
    },
    RealBalance: 0,
  });
  assert.deepEqual(projected, [
    { field: 'EnvInfo.EnvId', value: 'fixed' },
    { field: 'BillingInfo.IsAutoRenew', value: false },
    { field: 'BillingInfo.PayMode', value: 'PREPAYMENT' },
    { field: 'BillingInfo.ExpireTime', value: '2026-12-01' },
    { field: 'RealBalance', value: 0 },
  ]);
  const source = readFileSync(new URL('./blog/cloud-readiness.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /manageCloudRun|manageEnv|managePermissions|ModifyAccount|writeFunction/,
  );
  const parent = parse(readFileSync('.github/workflows/seo-static-canary.yml', 'utf8'));
  assert.equal(parent.jobs.cloud_readiness.uses, './.github/workflows/seo-cloud-readiness.yml');
  assert.equal(parent.concurrency.group, 'cloudbase-deploy-test');
});

test('resource-point usage preserves documented metrics without exposing generic config values', () => {
  assert.deepEqual(
    safeFields({
      Usages: [
        {
          Module: 'EKS',
          CreditsValue: 10,
          MetricUsageDetail: [{ MetricName: 'Cpu', Value: 42, Unit: 'hour' }],
        },
      ],
      Settings: { Value: 'private' },
    }),
    [
      { field: 'Usages.0.Module', value: 'EKS' },
      { field: 'Usages.0.CreditsValue', value: 10 },
      { field: 'Usages.0.MetricUsageDetail.0.MetricName', value: 'Cpu' },
      { field: 'Usages.0.MetricUsageDetail.0.Value', value: 42 },
      { field: 'Usages.0.MetricUsageDetail.0.Unit', value: 'hour' },
    ],
  );
});
