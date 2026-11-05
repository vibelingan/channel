import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertTrackedCatalogProgram,
  checkCatalogRuntimeFlags,
} from './release/catalog-runtime-flags.mjs';
const config = { siteOrigin: 'https://fixture.example', detailEnabled: true };
function setup() {
  const records = Object.fromEntries(
    ['admin', 'alibaba-catalog-sync', 'public-api'].map((name) => [
      name,
      {
        FunctionName: name,
        Status: 'Active',
        Runtime: 'Nodejs20.19',
        Environment: {
          Variables: Object.entries({
            TCB_ENV: 'fixture-env',
            CATALOG_DETAIL_APPROVAL_ENABLED: '1',
            ...(name === 'public-api'
              ? {}
              : { CATALOG_SEO_RECORDING: '1', CATALOG_SEO_SITE_ORIGIN: config.siteOrigin }),
            JWT_SECRET: 'fixture-private-do-not-report',
          }).map(([Key, Value]) => ({ Key, Value })),
        },
      },
    ]),
  );
  return { records, manager: { functions: { getFunctionDetail: async (name) => records[name] } } };
}
test('both real writers and the public detail mode must agree; unrelated secrets are not returned', async () => {
  const x = setup();
  const result = await checkCatalogRuntimeFlags(x.manager, config, 'fixture-env');
  assert.deepEqual(
    result.map((r) => r.name),
    ['admin', 'alibaba-catalog-sync', 'public-api'],
  );
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
});
test('an unconfigured synchronization writer blocks publication', async () => {
  const x = setup();
  x.records['alibaba-catalog-sync'].Environment.Variables = x.records[
    'alibaba-catalog-sync'
  ].Environment.Variables.filter((v) => v.Key !== 'CATALOG_SEO_RECORDING');
  await assert.rejects(
    checkCatalogRuntimeFlags(x.manager, config, 'fixture-env'),
    /recording has not/,
  );
});
test('approval mode and environment mismatch fail before content delivery', async () => {
  for (const key of ['TCB_ENV', 'CATALOG_DETAIL_APPROVAL_ENABLED']) {
    const x = setup();
    x.records['public-api'].Environment.Variables.find((v) => v.Key === key).Value = 'wrong';
    await assert.rejects(
      checkCatalogRuntimeFlags(x.manager, config, 'fixture-env'),
      /mode differs/,
    );
  }
});

test('clock activation requires tracked pages and the exact accepted website run', () => {
  const active = { catalogTracked: true, acceptedRunId: 'site-101-1', codeSha: 'a'.repeat(40) };
  const baseline = { sourceRunId: 'site-101-1' };
  assert.doesNotThrow(() => assertTrackedCatalogProgram(active, baseline));
  for (const wrong of [
    { ...active, catalogTracked: false },
    { ...active, acceptedRunId: 'site-100-1' },
    null,
  ])
    assert.throws(() => assertTrackedCatalogProgram(wrong, baseline), /tracked HTML acceptance/);
});

test('clock enabling also requires the public API readiness switch after bootstrap', async () => {
  const x = setup();
  await assert.rejects(
    checkCatalogRuntimeFlags(x.manager, { ...config, requireReadiness: true }, 'fixture-env'),
    /readiness has not/,
  );
  x.records['public-api'].Environment.Variables.push(
    { Key: 'CATALOG_SEO_PAGE_READINESS', Value: '1' },
    { Key: 'CATALOG_SEO_SITE_ORIGIN', Value: config.siteOrigin },
  );
  await checkCatalogRuntimeFlags(x.manager, { ...config, requireReadiness: true }, 'fixture-env');
});
