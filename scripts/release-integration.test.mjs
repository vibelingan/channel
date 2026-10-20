import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  executeHostingRecovery,
  planHostingRecovery,
  recoveryStateIdentity,
} from './hosting-recovery.mjs';
import { cloudbaseFixture } from './release-cloudbase-fixture.mjs';
import { digest, fixture, target } from './release-fixtures.mjs';
import {
  clock,
  composition,
  plan,
  policy,
  receipt,
  runner,
  stepInput,
} from './release-state-fixtures.mjs';
import { identity } from './release/input.mjs';
import { createReleaseCoordinator } from './release/state.mjs';

test('module 01 restores actual local bytes while module 02 persists intents and accepts the restored composition', async (t) => {
  const sdk = cloudbaseFixture(t);
  const client = createReleaseCoordinator({ store: sdk.store, policy, clock: clock().now });
  const source = fixture(t);
  const recovery = planHostingRecovery({
    ...source,
    target,
    currentOwnedPaths: ['retired/index.html'],
    publicProductPaths: [],
  });
  const directory = mkdtempSync(join(tmpdir(), 'release-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const entry of recovery.uploads) {
    mkdirSync(join(directory, entry.path, '..'), { recursive: true });
    copyFileSync(join(source.directory, entry.path), join(directory, entry.path));
  }
  const initialGuard = await client.acquire(runner('bootstrap'));
  await client.startRun({
    guard: initialGuard,
    runId: 'baseline-A',
    scopeKey: 'site',
    kind: 'adopt',
    composition: composition(),
    plan: plan(1),
  });
  const adopted = await client.beginStep({
    guard: initialGuard,
    runId: 'baseline-A',
    ...stepInput('accept'),
  });
  await client.confirmStep({
    guard: initialGuard,
    runId: 'baseline-A',
    stepId: adopted.stepId,
    receipt: receipt(adopted),
  });
  const baseline = await client.commitRun({
    guard: initialGuard,
    runId: 'baseline-A',
    changeSetRef: 'changes:baseline',
  });

  const guard = await client.acquire(runner('deployment'));
  await client.startRun({
    guard,
    runId: 'publish-B',
    scopeKey: 'site',
    kind: 'publish',
    composition: composition('B'),
    deliveredComponents: ['static'],
    plan: plan(),
  });
  const change = await client.beginStep({
    guard,
    runId: 'publish-B',
    ...stepInput(),
    beforeHash: digest('home'),
    afterHash: digest('partial B'),
  });
  writeFileSync(join(directory, 'index.html'), 'partial B');
  await client.confirmStep({
    guard,
    runId: 'publish-B',
    stepId: change.stepId,
    receipt: receipt(change, 'verified', {
      observedHash: digest(readFileSync(join(directory, 'index.html'))),
    }),
  });
  await client.failRun({ guard, runId: 'publish-B', reason: 'synthetic delivery failure' });
  mkdirSync(join(directory, 'retired'));
  writeFileSync(join(directory, 'retired/index.html'), 'partial obsolete discovery page');
  await client.startRun({
    guard,
    runId: 'restore-A',
    kind: 'restore',
    scopeKey: 'site',
    deliveredComponents: ['static'],
    plan: {
      planSha256: recovery.planSha256,
      acceptanceHash: recovery.stateSha256,
      stepCount: recovery.uploads.length + recovery.deletes.length + 2,
    },
  });
  const steps = new Map();
  let actualConfiguration;
  const begin = async (intent, kind, beforeHash, verifySubject = intent.subject) => {
    const step = await client.beginStep({
      guard,
      runId: 'restore-A',
      ...intent,
      stepId: identity(intent.subject),
      component: kind === 'accept' ? 'scope' : 'static',
      kind,
      beforeHash,
      afterHash: intent.expectedHash,
      verifySubject,
    });
    steps.set(intent.subject, step);
    return step;
  };
  const confirm = async (step, intent, observedHash) => {
    const verified = {
      ...intent,
      operationId: step.operationId,
      intentHash: step.intentHash,
      status: 'verified',
      observedHash,
      terminal: true,
    };
    await client.confirmStep({ guard, runId: 'restore-A', stepId: step.stepId, receipt: verified });
    return verified;
  };
  const result = await executeHostingRecovery(recovery, {
    async upload(entry, intent) {
      const step = await begin(
        intent,
        'write',
        existsSync(join(directory, entry.path))
          ? digest(readFileSync(join(directory, entry.path)))
          : 'absent',
        `read:${entry.path}`,
      );
      copyFileSync(join(source.directory, entry.path), join(directory, entry.path));
      const submitted = {
        ...intent,
        operationId: step.operationId,
        intentHash: step.intentHash,
        status: 'submitted',
      };
      await client.recordSubmitted({
        guard,
        runId: 'restore-A',
        stepId: step.stepId,
        receipt: submitted,
      });
      return submitted;
    },
    async verify(entry, intent) {
      return confirm(
        steps.get(`upload:${entry.path}`),
        intent,
        digest(readFileSync(join(directory, entry.path))),
      );
    },
    async remove(path, intent) {
      const step = await begin(intent, 'write', digest(readFileSync(join(directory, path))));
      rmSync(join(directory, path));
      return confirm(step, intent, existsSync(join(directory, path)) ? 'unexpected' : 'absent');
    },
    async configure(intent) {
      const step = await begin(intent, 'write', 'absent');
      actualConfiguration = structuredClone(source.manifest.configuration);
      return confirm(step, intent, digest(JSON.stringify(actualConfiguration)));
    },
    async accept(intent) {
      const step = await begin(intent, 'accept', recovery.stateSha256);
      const observed = recoveryStateIdentity({
        ...recovery,
        uploads: recovery.uploads.map(({ path }) => ({
          path,
          sha256: digest(readFileSync(join(directory, path))),
        })),
        deletes: recovery.deletes.filter((path) => !existsSync(join(directory, path))),
        configurationSha256: digest(JSON.stringify(actualConfiguration)),
      });
      return confirm(step, intent, observed);
    },
  });
  assert.equal(result.status, 'verified');
  assert.equal((await client.status()).scope.active.activationId, baseline.activation.activationId);
  const activated = await client.commitRun({
    guard,
    runId: 'restore-A',
    changeSetRef: 'changes:restore',
  });
  assert.notEqual(activated.activation.activationId, baseline.activation.activationId);
  assert.equal(readFileSync(join(directory, 'index.html'), 'utf8'), 'home');
  assert.equal(existsSync(join(directory, 'retired/index.html')), false);
  assert.equal((await client.runStatus('publish-B')).state, 'FAILED_RECOVERED');
});
