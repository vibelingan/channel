import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { functionRecoveryFixture } from './release-function-fixtures.mjs';
import {
  assertFunctionRecoveryCurrent,
  planFunctionRecovery,
  readFunctionRecoveryPackage,
} from './release/function-recovery.mjs';

test('plans only explicitly requested accepted function bytes while retaining current configuration and data', (t) => {
  const x = functionRecoveryFixture(t);
  const p = planFunctionRecovery(x);
  assert.equal(p.execution, 'not-connected');
  assert.equal(p.sourceRunId, 'accepted-A');
  assert.equal(p.functions[0].baseline.codeSha, 'a'.repeat(40));
  assert.equal(p.functions[0].currentCodeSha, 'b'.repeat(40));
  assert.deepEqual(p.configurationWrites, []);
  assert.deepEqual(p.databaseWrites, []);
  assert.deepEqual(p.functionDeletes, []);
  assert.equal(
    readFunctionRecoveryPackage({
      plan: p,
      name: 'public-api',
      directory: x.baselineInput.directory,
      now: x.now,
    }).toString(),
    'archived-A-function-bytes',
  );
  assertFunctionRecoveryCurrent({ plan: p, observation: x.observation, now: x.now });
  assert(Object.isFrozen(p.functions[0]));
});
for (const [name, change] of [
  [
    'foreign ledger target',
    (x) => {
      x.acceptedRun.targetId = 'f'.repeat(64);
    },
  ],
  [
    'corrupt accepted composition identity',
    (x) => {
      x.acceptedRun.compositionHash = 'f'.repeat(64);
    },
  ],
  [
    'missing function acceptance',
    (x) => {
      x.acceptedRun.composition['function:public-api'] = undefined;
    },
  ],
  [
    'failed source run',
    (x) => {
      x.acceptedRun.state = 'FAILED';
    },
  ],
  [
    'different accepted seal',
    (x) => {
      x.acceptedRun.accepted.seals['function:public-api'] = {};
    },
  ],
  [
    'function not in archive',
    (x) => {
      x.names = ['admin'];
    },
  ],
  [
    'duplicate scope',
    (x) => {
      x.names = ['public-api', 'public-api'];
    },
  ],
  [
    'canary scope',
    (x) => {
      x.policy.scope = { kind: 'canary', prefix: '__release-canary/' };
    },
  ],
  [
    'foreign environment',
    (x) => {
      x.policy.target = { ...x.policy.target, envId: 'other-env' };
    },
  ],
  [
    'untrusted proof source',
    (x) => {
      x.compatibilityInput.run.headSha = 'c'.repeat(40);
    },
  ],
  [
    'expired proof archive',
    (x) => {
      x.compatibilityInput.envelope.artifact.expiresAt = new Date(x.now - 1).toISOString();
    },
  ],
  [
    'static seal without function acceptance',
    (x) => {
      x.acceptedRun.accepted.seals = { static: x.baselineInput.acceptedSeal };
    },
  ],
])
  test(`rejects ${name}`, (t) => {
    const x = functionRecoveryFixture(t);
    change(x);
    assert.throws(() => planFunctionRecovery(x));
  });

test('failed old-writer proof denies a plan even when archive hashes are valid', (t) => {
  const x = functionRecoveryFixture(t, {
    changeReport: (r) => {
      r.preservesUnknownFields = false;
    },
  });
  assert.throws(
    () => planFunctionRecovery(x),
    (e) => e.code === 'COMPATIBILITY_DENIED' && e.reasons.includes('OLD_WRITER_MAY_DROP_FIELDS'),
  );
});

test('tampering with report or function bytes cannot be repaired by a compatible flag', (t) => {
  const x = functionRecoveryFixture(t);
  writeFileSync(join(x.compatibilityInput.directory, 'compatibility.json'), '{"compatible":true}');
  assert.throws(() => planFunctionRecovery(x), /Corrupt/);
  const y = functionRecoveryFixture(t);
  writeFileSync(join(y.baselineInput.directory, y.baseline.packagePath), 'different package');
  assert.throws(() => planFunctionRecovery(y), /Corrupt/);
});

test('rechecks data, client and runtime identities after plan construction', (t) => {
  const x = functionRecoveryFixture(t);
  const p = planFunctionRecovery(x);
  x.observation.data.revision = 'next-data';
  assert.throws(
    () => assertFunctionRecoveryCurrent({ plan: p, observation: x.observation, now: x.now }),
    /changed/,
  );
});

test('expired plans and changed local packages are refused immediately before use', (t) => {
  const x = functionRecoveryFixture(t);
  const p = planFunctionRecovery(x);
  assert.throws(
    () =>
      readFunctionRecoveryPackage({
        plan: p,
        name: 'public-api',
        directory: x.baselineInput.directory,
        now: x.now + 300000,
      }),
    /expired/,
  );
  writeFileSync(join(x.baselineInput.directory, x.baseline.packagePath), 'changed-after-plan');
  assert.throws(
    () =>
      readFunctionRecoveryPackage({
        plan: p,
        name: 'public-api',
        directory: x.baselineInput.directory,
        now: x.now,
      }),
    /changed/,
  );
});

test('symlink replacement and unrequested function reads are refused', (t) => {
  const x = functionRecoveryFixture(t);
  const p = planFunctionRecovery(x);
  const file = join(x.baselineInput.directory, x.baseline.packagePath);
  unlinkSync(file);
  symlinkSync(join(x.baselineInput.directory, 'index.html'), file);
  assert.throws(
    () =>
      readFunctionRecoveryPackage({
        plan: p,
        name: 'public-api',
        directory: x.baselineInput.directory,
        now: x.now,
      }),
    /Symlink/,
  );
  assert.throws(
    () =>
      readFunctionRecoveryPackage({
        plan: p,
        name: 'admin',
        directory: x.baselineInput.directory,
        now: x.now,
      }),
    /Unplanned/,
  );
});

test('planning never changes the archive or its compatibility report', (t) => {
  const x = functionRecoveryFixture(t);
  const a = readFileSync(join(x.baselineInput.directory, 'payload-manifest.json'));
  const b = readFileSync(join(x.compatibilityInput.directory, 'compatibility.json'));
  planFunctionRecovery(x);
  assert.deepEqual(readFileSync(join(x.baselineInput.directory, 'payload-manifest.json')), a);
  assert.deepEqual(readFileSync(join(x.compatibilityInput.directory, 'compatibility.json')), b);
});

test('a denied second function does not return a partial recovery plan', (t) => {
  const x = functionRecoveryFixture(t);
  x.names = ['public-api', 'admin'];
  assert.throws(() => planFunctionRecovery(x), /absent/);
});

test('a serialized plan changed after review is refused', (t) => {
  const x = functionRecoveryFixture(t);
  const p = structuredClone(planFunctionRecovery(x));
  p.target.envId = 'other-env';
  assert.throws(
    () => assertFunctionRecoveryCurrent({ plan: p, observation: x.observation, now: x.now }),
    /Invalid/,
  );
});
