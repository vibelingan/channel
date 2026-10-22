import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setupFunctionExecution } from './release-function-execution-fixture.mjs';
import { functionZip } from './release-function-manager-fixture.mjs';
import { runner, policy as storePolicy } from './release-state-fixtures.mjs';
import {
  buildDummyFunction,
  dummyRecoveryScope,
  dummySuitePolicy,
  loadDummyFunction,
} from './release/dummy-recovery-fixture.mjs';
import {
  executeManualFunctionRecovery,
  planManualFunctionRecovery,
} from './release/function-orchestrator.mjs';
import { writeFunctionReportArtifact } from './release/function-report-artifact.mjs';
import { produceFunctionCompatibilityReport } from './release/function-report.mjs';
import { runFunctionCompatibilityTests } from './release/function-test-runner.mjs';
import { sha256 } from './release/input.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'seo-release-dummy';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const id = 'seo-drill-item';

async function setup(t, options = {}) {
  const packageA = buildDummyFunction({ version: 'A', codeSha: A });
  const packageB = buildDummyFunction({ version: 'B', codeSha: B });
  const f = await setupFunctionExecution(t, {
    ...options,
    name,
    packageA,
    packageB,
    start: false,
    formats: ['dummy-v1', 'dummy-v2'],
    apiContracts: ['dummy-ui-v1', 'dummy-ui-v2'],
  });
  const loadedA = loadDummyFunction(packageA);
  const loadedB = loadDummyFunction(packageB);
  t.after(loadedA.close);
  t.after(loadedB.close);
  const main = () => (f.sdk.state.bytes.equals(packageA) ? loadedA.main : loadedB.main);
  const args = {
    policy: { ...storePolicy, enabled: true, functions: [name] },
    coordinator: f.client,
    provider: f.provider,
    observer: { observe: f.observe },
    loadAccepted: async () => f.x.baselineInput,
    loadCompatibility: async () => f.x.compatibilityInput,
    request: {
      names: [name],
      restoreRunId: 'baseline-A',
      expectedActivationId: (await f.client.status()).scope.active.activationId,
      compatibilityArtifactId: '21',
      reason: 'Offline isolated dummy recovery rehearsal',
    },
    executorSha: 'c'.repeat(40),
    clock: () => f.x.now,
    adapterOptions: { pollIntervalMs: 1 },
    runId: 'restore-A',
    owner: runner('dummy-operator'),
    probe: async (functionName) => {
      const health = await main()({ action: 'health' });
      return { name: functionName, status: 'healthy', codeSha: health.codeSha, target: f.x.target };
    },
  };
  const records = new Map();
  const call = async (event) => {
    const result = await main()({ ...event, record: records.get(event.id) });
    if (['create', 'update', 'delete'].includes(event.action))
      records.set(event.id, structuredClone(result.record));
    return result;
  };
  return { ...f, args, call, records };
}

function certify(t, f) {
  const suitePolicy = dummySuitePolicy(root);
  const evidence = runFunctionCompatibilityTests({
    root,
    directory: f.x.baselineInput.directory,
    baselines: [f.x.baseline],
    observation: f.x.observation,
    policy: { compatibilitySuites: suitePolicy },
    now: f.x.now,
  });
  // GitHub provenance is simulated here. The business suite itself actually executes the archived code.
  const report = produceFunctionCompatibilityReport({
    target: f.x.target,
    baselines: [f.x.baseline],
    observation: f.x.observation,
    evidence,
    suitePolicy,
    now: f.x.now,
    source: {
      verified: true,
      event: 'workflow_dispatch',
      manifestSha256: 'e'.repeat(64),
      headSha: B,
      artifactId: '21',
    },
  });
  const temp = mkdtempSync(join(tmpdir(), 'dummy-recovery-proof-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const directory = join(temp, 'report');
  const payload = writeFunctionReportArtifact({
    directory,
    report,
    target: f.x.target,
    codeSha: B,
    releaseId: 'dummy-proof-B',
    now: f.x.now,
  });
  const artifact = {
    ...f.x.compatibilityInput.envelope.artifact,
    manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
  };
  const input = { ...f.x.compatibilityInput, directory, envelope: { ...payload, artifact } };
  f.args.loadCompatibility = async () => input;
  return evidence;
}

test('dummy packages are deterministic, dependency-free and restricted to the reserved function', () => {
  const a = buildDummyFunction({ version: 'A', codeSha: A });
  assert.deepEqual(a, buildDummyFunction({ version: 'A', codeSha: A }));
  assert.notDeepEqual(a, buildDummyFunction({ version: 'B', codeSha: B }));
  assert.equal(dummyRecoveryScope.functionName, name);
  assert.throws(() => buildDummyFunction({ version: 'C', codeSha: A }));
  assert.throws(() => buildDummyFunction({ version: 'A', codeSha: 'not-a-sha' }));
  const production = JSON.parse(
    readFileSync(`${root}scripts/release/function-recovery-policy.json`),
  );
  assert.equal(production.enabled, false);
  assert(!production.functions.includes(name));
  assert.deepEqual(production.compatibilitySuites, []);
});

test('dummy handler rejects business IDs, foreign records, replacement writes and resurrection', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.call({ action: 'create', id: 'real-product', label: 'test' }));
  await assert.rejects(f.call({ action: 'replace', id }));
  await assert.rejects(f.call({ action: 'update', id, patch: { label: 'test' } }));
  await f.call({ action: 'create', id, label: 'test' });
  await assert.rejects(f.call({ action: 'create', id, label: 'duplicate' }));
  await assert.rejects(f.call({ action: 'update', id, patch: { _id: 'different' } }));
  await f.call({ action: 'delete', id });
  await assert.rejects(f.call({ action: 'update', id, patch: { label: 'revive' } }));
  assert.equal(f.records.get(id).deleted, true);
});

test('fixed compatibility suites execute the archived A handler against both dummy data and client versions', async (t) => {
  const f = await setup(t);
  const result = certify(t, f);
  assert.equal(result.status, 'passed');
  assert.equal(result.components[0].name, name);
  assert.equal(result.components[0].suites.length, 4);
  assert(result.components[0].suites.every((x) => x.totalTests >= 4));
});

test('an old handler that loses a new field cannot earn compatibility evidence', async (t) => {
  const f = await setup(t);
  const bad = functionZip(`exports.main = async e => e.action === 'health'
    ? { purpose: ${JSON.stringify(dummyRecoveryScope.purpose)}, version: 'A', codeSha: '${A}' }
    : e.action === 'read' ? { record: e.record }
    : { record: { _id: e.id, purpose: e.record.purpose, label: e.patch.label, revision: e.record.revision + 1, deleted: false } };`);
  const { writeFileSync } = await import('node:fs');
  const baseline = { ...f.x.baseline, sha256: sha256(bad) };
  writeFileSync(`${f.x.baselineInput.directory}/${baseline.packagePath}`, bad);
  assert.throws(
    () =>
      runFunctionCompatibilityTests({
        root,
        directory: f.x.baselineInput.directory,
        baselines: [baseline],
        observation: f.x.observation,
        policy: { compatibilitySuites: dummySuitePolicy(root) },
        now: f.x.now,
      }),
    /suite execution failed/,
  );
  assert.equal(f.sdk.state.updates, 0);
});

test('D1 restores the explicitly accepted A bytes, preserves B data and proves the running A handler works', async (t) => {
  const f = await setup(t);
  const acceptedA = loadDummyFunction(f.a);
  t.after(acceptedA.close);
  assert.equal((await acceptedA.main({ action: 'health' })).version, 'A');
  f.records.set(
    id,
    (await acceptedA.main({ action: 'create', id, label: 'created with A' })).record,
  );
  await f.call({ action: 'update', id, patch: { label: 'edited with B', note: 'new B field' } });
  await f.call({ action: 'create', id: 'seo-drill-created-after-a', label: 'keep me' });
  await f.call({ action: 'create', id: 'seo-drill-deleted', label: 'deleted with B' });
  await f.call({ action: 'delete', id: 'seo-drill-deleted' });
  const dataBefore = structuredClone([...f.records]);
  const staticBefore = (await f.client.runStatus('baseline-B')).composition.static;
  certify(t, f);
  const preview = await planManualFunctionRecovery(f.args);
  assert.equal(f.sdk.state.updates, 0);
  const result = await executeManualFunctionRecovery({ ...f.args, token: preview.review.token });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(f.sdk.state.bytes, f.a);
  assert.equal((await f.call({ action: 'health' })).version, 'A');
  assert.deepEqual([...f.records], dataBefore);
  const updated = await f.call({
    action: 'update',
    id,
    patch: { label: 'updated after recovery' },
  });
  assert.equal(updated.record.note, 'new B field');
  assert.equal(f.records.get('seo-drill-created-after-a').label, 'keep me');
  assert.equal(f.records.get('seo-drill-deleted').deleted, true);
  const accepted = await f.client.runStatus('restore-A');
  assert.deepEqual(accepted.composition.static, staticBefore);
  assert.equal(accepted.composition[`function:${name}`].contentSha256, sha256(f.a));
  assert.equal(result.databaseRestore, 'not-run');
  assert.equal(result.searchNotifications, 0);
});

test('dummy recovery rechecks data and client changes before any code update', async (t) => {
  for (const change of [
    (value) => {
      value.data.revision = 'changed-after-review';
    },
    (value) => {
      value.exposedClientContracts.push('dummy-ui-v3');
    },
  ]) {
    const f = await setup(t);
    certify(t, f);
    const preview = await planManualFunctionRecovery(f.args);
    f.changeObservation(change);
    await assert.rejects(executeManualFunctionRecovery({ ...f.args, token: preview.review.token }));
    assert.equal(f.sdk.state.updates, 0);
  }
});

for (const failure of ['lost-ack', 'wrong-bytes', 'failed-state', 'missing-receipt']) {
  test(`dummy recovery stops on ${failure} and cannot silently retry`, async (t) => {
    const f = await setup(t, { failure });
    const preview = await planManualFunctionRecovery(f.args);
    await assert.rejects(executeManualFunctionRecovery({ ...f.args, token: preview.review.token }));
    assert.equal(f.sdk.state.updates, 1);
    assert.notEqual((await f.client.runStatus('restore-A')).state, 'SUCCEEDED');
    await assert.rejects(executeManualFunctionRecovery({ ...f.args, token: preview.review.token }));
    assert.equal(f.sdk.state.updates, 1);
  });
}

test('dummy preview refuses an unaccepted or different requested source without cloud updates', async (t) => {
  const f = await setup(t);
  for (const restoreRunId of ['missing-version', 'baseline-B']) {
    await assert.rejects(
      planManualFunctionRecovery({
        ...f.args,
        request: { ...f.args.request, restoreRunId },
      }),
    );
  }
  assert.equal(f.sdk.state.updates, 0);
});

test('the offline rehearsal is absent from normal deployment commands', () => {
  for (const path of ['.github/workflows/deploy-test.yml', 'scripts/deploy-cloudbase-test.mjs']) {
    const source = readFileSync(`${root}${path}`, 'utf8');
    assert(!source.includes('run-recovery-drill'));
    assert(!source.includes('runFunctionCompatibilityTests'));
    assert(!source.includes('dummy-recovery-fixture'));
  }
});
