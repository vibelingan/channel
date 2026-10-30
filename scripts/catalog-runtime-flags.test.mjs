import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCatalogRuntimeFlags } from './release/catalog-runtime-flags.mjs';
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
