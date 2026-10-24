import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  executeHostingRecovery,
  planHostingRecovery,
  recoveryStateIdentity,
} from './hosting-recovery.mjs';
import { digest, fixture, target } from './release-fixtures.mjs';

function setup(t) {
  const f = fixture(t);
  const plan = planHostingRecovery({
    ...f,
    target,
    publicProductPaths: [],
    currentOwnedPaths: ['retired/index.html'],
  });
  const output = mkdtempSync(join(tmpdir(), 'recovery-output-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, 'retired'));
  writeFileSync(join(output, 'retired/index.html'), 'retired');
  const calls = [];
  let operation = 0;
  let configurationSha256;
  const adapters = {
    upload: async (entry, intent) => {
      calls.push(`upload:${entry.path}`);
      mkdirSync(join(output, entry.path, '..'), { recursive: true });
      copyFileSync(join(f.directory, entry.path), join(output, entry.path));
      return { ...intent, status: 'submitted', operationId: `op-${++operation}` };
    },
    verify: async (entry, intent) => {
      calls.push(`verify:${entry.path}`);
      return {
        ...intent,
        status: 'verified',
        observedHash: digest(readFileSync(join(output, entry.path))),
      };
    },
    remove: async (path, intent) => {
      calls.push(`remove:${path}`);
      rmSync(join(output, path));
      return {
        ...intent,
        status: 'verified',
        operationId: `op-${++operation}`,
        observedHash: 'absent',
      };
    },
    configure: async (intent) => {
      calls.push('configure');
      configurationSha256 = plan.configurationSha256;
      return {
        ...intent,
        status: 'verified',
        operationId: `op-${++operation}`,
        observedHash: configurationSha256,
      };
    },
    accept: async (intent) => {
      calls.push('accept');
      const observedHash = recoveryStateIdentity({
        ...plan,
        uploads: plan.uploads.map((entry) => ({
          path: entry.path,
          sha256: digest(readFileSync(join(output, entry.path))),
        })),
        configurationSha256,
      });
      return { ...intent, status: 'verified', operationId: `op-${++operation}`, observedHash };
    },
  };
  return { plan, adapters, calls, output };
}

test('real local files restore in order and the final read-back matches the planned state', async (t) => {
  const f = setup(t);
  const result = await executeHostingRecovery(f.plan, f.adapters);
  assert.equal(result.status, 'verified');
  assert.equal(result.restored, 2);
  assert.equal(result.removed, 1);
  assert.equal(result.receipts.length, 5);
  assert.deepEqual(f.calls, [
    'upload:_astro/a.hash.js',
    'verify:_astro/a.hash.js',
    'upload:index.html',
    'verify:index.html',
    'remove:retired/index.html',
    'configure',
    'accept',
  ]);
  assert.equal(readFileSync(join(f.output, 'index.html'), 'utf8'), 'home');
  assert.throws(() => readFileSync(join(f.output, 'retired/index.html')), /ENOENT/);
});

for (const [name, bad] of [
  ['false', false],
  ['void', undefined],
  ['pending', { status: 'pending' }],
  ['truthy', { status: 'verified' }],
]) {
  for (const stage of ['upload', 'verify', 'remove', 'configure', 'accept']) {
    test(`${stage} returning ${name} stops without reporting recovery success`, async (t) => {
      const f = setup(t);
      const original = f.adapters[stage];
      f.adapters[stage] = async (...args) => {
        await original(...args);
        return bad;
      };
      await assert.rejects(
        executeHostingRecovery(f.plan, f.adapters),
        /Unverified recovery receipt/,
      );
      assert.equal(f.calls.at(-1).split(':')[0], stage);
      assert.equal(f.calls.filter((call) => call === 'accept').length, stage === 'accept' ? 1 : 0);
    });
  }
}

for (const [field, value] of [
  ['operationId', 'old-operation'],
  ['planSha256', '0'.repeat(64)],
  ['subject', 'read:other.html'],
  ['expectedHash', '1'.repeat(64)],
  ['observedHash', '2'.repeat(64)],
]) {
  test(`read-back rejects mismatched ${field} before the next file`, async (t) => {
    const f = setup(t);
    const verify = f.adapters.verify;
    f.adapters.verify = async (...args) => ({ ...(await verify(...args)), [field]: value });
    await assert.rejects(executeHostingRecovery(f.plan, f.adapters), /Unverified recovery receipt/);
    assert.deepEqual(f.calls, ['upload:_astro/a.hash.js', 'verify:_astro/a.hash.js']);
  });
}

test('a changed byte after upload is found by the actual read-back', async (t) => {
  const f = setup(t);
  const upload = f.adapters.upload;
  f.adapters.upload = async (...args) => {
    const result = await upload(...args);
    writeFileSync(join(f.output, args[0].path), 'bad bytes');
    return result;
  };
  await assert.rejects(executeHostingRecovery(f.plan, f.adapters), /Unverified recovery receipt/);
  assert.equal(f.calls.length, 2);
});

test('a throw stops immediately and never retries or starts an automatic second recovery', async (t) => {
  const f = setup(t);
  f.adapters.verify = async () => {
    throw new Error('read-back mismatch');
  };
  await assert.rejects(executeHostingRecovery(f.plan, f.adapters), /read-back mismatch/);
  assert.deepEqual(f.calls, ['upload:_astro/a.hash.js']);
});

test('all required callbacks and the plan identity are checked before the first effect', async (t) => {
  for (const change of [
    (f) => {
      f.adapters.accept = undefined;
    },
    (f) => {
      f.plan = { ...f.plan, deletes: ['other/index.html'] };
    },
    (f) => {
      f.plan = { ...f.plan, stateSha256: '0'.repeat(64) };
    },
  ]) {
    const f = setup(t);
    change(f);
    await assert.rejects(executeHostingRecovery(f.plan, f.adapters));
    assert.deepEqual(f.calls, []);
  }
});

test('the caller cannot change queued operations while an adapter is awaiting', async (t) => {
  const f = setup(t);
  const mutable = structuredClone(f.plan);
  const upload = f.adapters.upload;
  f.adapters.upload = async (...args) => {
    mutable.uploads[1].path = 'injected.html';
    mutable.deletes.push('danger.html');
    return upload(...args);
  };
  await executeHostingRecovery(mutable, f.adapters);
  assert.equal(f.calls.includes('upload:injected.html'), false);
  assert.equal(f.calls.includes('remove:danger.html'), false);
});

test('a receipt from an earlier execution of the same plan cannot satisfy a new recovery', async (t) => {
  const first = setup(t);
  const seen = {};
  for (const stage of ['upload', 'verify', 'remove', 'configure', 'accept']) {
    const original = first.adapters[stage];
    first.adapters[stage] = async (...args) => {
      const result = await original(...args);
      seen[stage] ??= result;
      return result;
    };
  }
  await executeHostingRecovery(first.plan, first.adapters);
  for (const stage of ['upload', 'verify', 'remove', 'configure', 'accept']) {
    const next = setup(t);
    assert.equal(next.plan.planSha256, first.plan.planSha256);
    const original = next.adapters[stage];
    next.adapters[stage] = async (...args) => {
      await original(...args);
      return seen[stage];
    };
    await assert.rejects(
      executeHostingRecovery(next.plan, next.adapters),
      /Unverified recovery receipt/,
    );
  }
});

test('retained object evidence must be checked before the first external write', async (t) => {
  const f = setup(t);
  const { identity } = await import('./release/input.mjs');
  const plan = structuredClone(f.plan);
  const entry = plan.uploads.pop();
  plan.retained = [{ ...entry, proof: { etag: 'test', lastModified: 'test' } }];
  plan.stateSha256 = recoveryStateIdentity(plan);
  const { planSha256, ...body } = plan;
  plan.planSha256 = identity(body);
  await assert.rejects(executeHostingRecovery(plan, f.adapters), /Retained/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    executeHostingRecovery(plan, {
      ...f.adapters,
      verifyRetained: async () => {
        throw new Error('retained object changed');
      },
    }),
    /changed/,
  );
  assert.deepEqual(f.calls, []);
});
