import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { CATALOG_PREPARATION_POLICY } from '@vibelingan-channel/shared/catalog-preparation';
import { createCatalogPreparationAuthority } from './catalog-preparation-authority.ts';

const secret = 'test-preparation-service-secret';
const environmentId = 'test-environment';
const jobId = 'a'.repeat(64);
const nonce = 'b'.repeat(64);
const inputDigest = 'c'.repeat(64);
const initial = 1792080000000;
function fixture() {
  let now = initial;
  const config = { secret, environmentId, now: () => now };
  const authority = createCatalogPreparationAuthority(config);
  const job = {
    schemaVersion: 'catalog-preparation-job-v1',
    _id: jobId,
    nonce,
    productId: 'product',
    inputDigest,
    contentGeneration: 3,
    policyVersion: CATALOG_PREPARATION_POLICY,
    state: 'running',
    leaseOwner: 'worker-owner',
    leaseVersion: 1,
    leaseExpiresAt: initial + 120000,
  };
  const call = authority.issueCall({ jobId, nonce });
  const ticket = authority.verifyCall(call);
  assert.ok(ticket);
  return {
    authority,
    config,
    job,
    call,
    ticket,
    set now(value: number) {
      now = value;
    },
  };
}
test('a signed call binds only a current technical preparation lease without an administrator row', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  const scope = f.authority.currentLeaseScope(grant, f.job);
  assert.ok(scope);
  assert.equal(scope.jobId, jobId);
  assert.equal(scope.productId, 'product');
  assert.equal(scope.inputDigest, inputDigest);
  assert.equal(scope.contentGeneration, 3);
  assert.deepEqual(scope.capabilities, ['prepare-media', 'store-preparation-report']);
  assert.equal(Object.hasOwn(scope, 'role'), false);
  assert.equal(Object.hasOwn(scope, 'signature'), false);
  assert.equal(Object.hasOwn(scope, 'nonce'), false);
  assert.equal(JSON.stringify(grant), '{}');
  assert.equal(JSON.stringify(f.ticket), '{}');
});
for (const change of [
  { kind: 'Timer' },
  { jobId: 'd'.repeat(64) },
  { nonce: 'e'.repeat(64) },
  { issuedAt: initial - 1 },
  { expiresAt: initial + 1 },
  { signature: '0'.repeat(64) },
])
  test(`tampering with ${Object.keys(change)[0]} cannot authorize a call`, () => {
    const f = fixture();
    assert.equal(f.authority.verifyCall({ ...f.call, ...change }), null);
  });
test('the same key does not authorize a call in another environment', () => {
  const f = fixture();
  const other = createCatalogPreparationAuthority({
    secret,
    environmentId: 'other',
    now: () => initial,
  });
  assert.equal(other.verifyCall(f.call), null);
});
test('a portal JWT MAC cannot become a preparation MAC', () => {
  const f = fixture();
  const signingInput = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'admin', jobId, nonce })).toString('base64url')}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('hex');
  assert.equal(f.authority.verifyCall({ ...f.call, signature }), null);
});
for (const input of [null, [], '', 'token', 1, { Type: 'Timer', TriggerName: 'trusted-looking' }])
  test(`non-service envelope ${JSON.stringify(input)} never creates a ticket`, () => {
    const f = fixture();
    assert.equal(f.authority.verifyCall(input), null);
  });
for (const extra of [{ ready: true }, { role: 'admin' }, { Type: 'Timer' }, { productId: 'other' }])
  test(`extra ${Object.keys(extra)[0]} cannot extend signed service rights`, () => {
    const f = fixture();
    assert.equal(f.authority.verifyCall({ ...f.call, ...extra }), null);
  });
test('an expired call cannot start or bind a lease', () => {
  const f = fixture();
  f.now = initial + 30000;
  assert.equal(f.authority.verifyCall(f.call), null);
  assert.equal(f.authority.bindLease(f.ticket, f.job, 'worker-owner'), null);
});
test('a call too far in the future is rejected', () => {
  const f = fixture();
  f.now = initial - 5001;
  assert.equal(f.authority.verifyCall(f.call), null);
});
test('a small clock skew remains usable', () => {
  const f = fixture();
  f.now = initial - 1000;
  assert.ok(f.authority.verifyCall(f.call));
  assert.ok(f.authority.bindLease(f.ticket, f.job, 'worker-owner'));
});
for (const signature of ['', 'a', 'z'.repeat(64), 'f'.repeat(63), 'f'.repeat(66)])
  test(`malformed signature length/content rejects without throwing: ${signature.length}`, () => {
    const f = fixture();
    assert.equal(f.authority.verifyCall({ ...f.call, signature }), null);
  });
for (const change of [
  { _id: 'd'.repeat(64) },
  { nonce: 'd'.repeat(64) },
  { state: 'cancelled' },
  { leaseOwner: 'other' },
  { leaseVersion: 0 },
  { leaseVersion: 1.5 },
  { leaseExpiresAt: initial },
  { leaseExpiresAt: initial + 600000 },
  { policyVersion: 'other' },
])
  test(`current lease binding rejects ${Object.keys(change)[0]}:${String(Object.values(change)[0])}`, () => {
    const f = fixture();
    assert.equal(f.authority.bindLease(f.ticket, { ...f.job, ...change }, 'worker-owner'), null);
  });
test('a forged or serialized ticket cannot bind any job', () => {
  const f = fixture();
  assert.equal(f.authority.bindLease({ ...f.ticket }, f.job, 'worker-owner'), null);
  assert.equal(
    f.authority.bindLease(JSON.parse(JSON.stringify(f.ticket)), f.job, 'worker-owner'),
    null,
  );
});
test('another issuer instance cannot use a ticket or lease by shape', () => {
  const f = fixture();
  const other = createCatalogPreparationAuthority(f.config);
  assert.equal(other.bindLease(f.ticket, f.job, 'worker-owner'), null);
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  assert.equal(other.currentLeaseScope(grant, f.job), null);
});
for (const change of [
  { _id: 'd'.repeat(64) },
  { nonce: 'd'.repeat(64) },
  { productId: 'other' },
  { inputDigest: 'e'.repeat(64) },
  { contentGeneration: 4 },
  { state: 'cancelled' },
  { leaseOwner: 'other' },
  { leaseVersion: 2 },
  { leaseExpiresAt: initial },
  { policyVersion: 'other' },
])
  test(`a changed job revokes the old scope: ${Object.keys(change)[0]}`, () => {
    const f = fixture();
    const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
    assert.ok(grant);
    assert.equal(f.authority.currentLeaseScope(grant, { ...f.job, ...change }), null);
  });
test('valid same-owner lease renewal preserves the scope after call admission expires', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  f.now = initial + 31000;
  assert.equal(f.authority.verifyCall(f.call), null);
  assert.ok(f.authority.currentLeaseScope(grant, { ...f.job, leaseExpiresAt: initial + 151000 }));
});
test('changing the source job object cannot rewrite an issued scope', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  f.job.productId = 'other';
  assert.equal(f.authority.currentLeaseScope(grant, f.job), null);
});
test('forged and JSON-copied grants cannot acquire rights', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  assert.equal(f.authority.currentLeaseScope({ ...grant }, f.job), null);
  assert.equal(f.authority.currentLeaseScope(JSON.parse(JSON.stringify(grant)), f.job), null);
});
test('issuer configuration is captured before later caller mutation', () => {
  const f = fixture();
  f.config.secret = 'different';
  f.config.environmentId = 'other';
  assert.ok(f.authority.verifyCall(f.call));
});
test('returned scopes are frozen and have no publication or approval capability', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  const scope = f.authority.currentLeaseScope(grant, f.job);
  assert.ok(scope);
  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.capabilities));
  assert.equal(
    Array.from(scope.capabilities).some((x) => /publish|approve|classify/.test(x)),
    false,
  );
});
test('invalid server clock or empty issuer config fails explicitly', () => {
  assert.throws(() =>
    createCatalogPreparationAuthority({ secret: '', environmentId, now: () => initial }),
  );
  assert.throws(() =>
    createCatalogPreparationAuthority({ secret, environmentId: ' ', now: () => initial }),
  );
  const f = fixture();
  f.now = Number.NaN;
  assert.throws(() => f.authority.issueCall({ jobId, nonce }));
});

function independentlySign(
  fields: Omit<
    ReturnType<ReturnType<typeof createCatalogPreparationAuthority>['issueCall']>,
    'signature'
  >,
) {
  return {
    ...fields,
    signature: createHmac('sha256', secret)
      .update(
        JSON.stringify([
          'channel/catalog-preparation/admission/v1',
          environmentId,
          fields.kind,
          fields.jobId,
          fields.nonce,
          fields.issuedAt,
          fields.expiresAt,
        ]),
      )
      .digest('hex'),
  };
}
test('an independently signed envelope uses the documented domain and field order', () => {
  const f = fixture();
  assert.ok(f.authority.verifyCall(independentlySign(f.call)));
});
test('a genuine MAC cannot extend or shorten the fixed admission lifetime', () => {
  const f = fixture();
  for (const expiresAt of [initial, initial + 29999, initial + 30001, initial + 600000])
    assert.equal(f.authority.verifyCall(independentlySign({ ...f.call, expiresAt })), null);
});
test('clock skew includes exactly five seconds and excludes the next millisecond', () => {
  const f = fixture();
  f.now = initial - 5000;
  assert.ok(f.authority.verifyCall(f.call));
  f.now = initial - 5001;
  assert.equal(f.authority.verifyCall(f.call), null);
});
for (const change of [
  { productId: ' product' },
  { inputDigest: 'bad' },
  { contentGeneration: -1 },
  { contentGeneration: 1.5 },
  { contentGeneration: Number.MAX_SAFE_INTEGER + 1 },
  { schemaVersion: 'old' },
  { leaseOwner: ' worker-owner' },
])
  test(`malformed private lease rejects ${Object.keys(change)[0]}=${Object.values(change)[0]}`, () => {
    const f = fixture();
    assert.equal(f.authority.bindLease(f.ticket, { ...f.job, ...change }, 'worker-owner'), null);
  });
test('bound lease expires at equality even when the old call was genuine', () => {
  const f = fixture();
  const grant = f.authority.bindLease(f.ticket, f.job, 'worker-owner');
  assert.ok(grant);
  f.now = f.job.leaseExpiresAt;
  assert.equal(f.authority.currentLeaseScope(grant, f.job), null);
});
test('issuing a call rejects invalid private identity and timestamp overflow', () => {
  const f = fixture();
  assert.throws(() => f.authority.issueCall({ jobId: 'bad', nonce }));
  f.now = Number.MAX_SAFE_INTEGER;
  assert.throws(() => f.authority.issueCall({ jobId, nonce }));
});
