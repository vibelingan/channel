import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { cloudBaseAdapter } from '@vibelingan-channel/db/cloudbase';

const environmentId = 'owned-cloudbase-event-test';
const secret = 'owned-cloudbase-event-secret';
process.env.TCB_ENV = environmentId;
process.env.JWT_SECRET = secret;
const entrypoint = import('./index.ts');
function call() {
  return createCatalogPreparationAuthority({ secret, environmentId }).issueCall({
    jobId: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
  });
}

test('deployed entrypoint accepts signed calls with actual CloudBase context without trusting that context', async (t) => {
  const { main } = await entrypoint;
  const claims: unknown[] = [];
  const original = cloudBaseAdapter.manageCatalogPreparationJob;
  assert.ok(original);
  t.after(() => {
    cloudBaseAdapter.manageCatalogPreparationJob = original;
  });
  cloudBaseAdapter.manageCatalogPreparationJob = async (_authority, command) => {
    claims.push(command);
    return { ok: false, code: 'NOT_FOUND' };
  };
  const signed = JSON.parse(JSON.stringify(call()));
  assert.deepEqual(await main(signed), { ok: false, code: 'NOT_FOUND' });
  const wire = {
    ...signed,
    tcbContext: { diagnostic: 'platform-context' },
    userInfo: { role: 'admin', diagnostic: 'untrusted-context' },
  };
  const before = structuredClone(wire);
  assert.deepEqual(await main(wire), { ok: false, code: 'NOT_FOUND' });
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    assert.ok(claim && typeof claim === 'object');
    assert.equal(Reflect.get(claim, 'action'), 'claim');
    assert.deepEqual(Reflect.get(claim, 'call'), signed);
  }
  assert.deepEqual(wire, before);
});

test('platform context cannot admit a tampered signature, another environment or extra business rights', async (t) => {
  const { main } = await entrypoint;
  let claims = 0;
  const original = cloudBaseAdapter.manageCatalogPreparationJob;
  assert.ok(original);
  t.after(() => {
    cloudBaseAdapter.manageCatalogPreparationJob = original;
  });
  cloudBaseAdapter.manageCatalogPreparationJob = async () => {
    claims++;
    return { ok: false, code: 'NOT_FOUND' };
  };
  const signed = call();
  const context = { tcbContext: { trusted: true }, userInfo: { role: 'admin' } };
  const other = createCatalogPreparationAuthority({
    secret,
    environmentId: 'other-environment',
  }).issueCall({ jobId: signed.jobId, nonce: signed.nonce });
  for (const value of [
    { ...signed, signature: '0'.repeat(64) },
    { ...signed, nonce: 'c'.repeat(64) },
    { ...signed, role: 'admin' },
    { ...signed, productId: 'another-product' },
    { ...signed, ready: true },
    { ...signed, httpMethod: 'POST', body: '{}' },
    other,
  ])
    assert.deepEqual(await main({ ...value, ...context }), { ok: false, code: 'FORBIDDEN' });
  assert.equal(claims, 0);
});
