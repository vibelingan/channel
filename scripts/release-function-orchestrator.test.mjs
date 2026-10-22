import assert from 'node:assert/strict';
import test from 'node:test';
import { setupFunctionExecution } from './release-function-execution-fixture.mjs';
import { policy as base, runner } from './release-state-fixtures.mjs';
import {
  executeManualFunctionRecovery,
  planManualFunctionRecovery,
} from './release/function-orchestrator.mjs';
async function setup(t, options = {}) {
  const f = await setupFunctionExecution(t, { ...options, start: false });
  const state = await f.client.status({ scopeKey: 'site' });
  const request = {
    names: ['public-api'],
    restoreRunId: 'baseline-A',
    expectedActivationId: state.scope.active.activationId,
    compatibilityArtifactId: '21',
    reason: 'Explicit fixture recovery',
  };
  const args = {
    policy: { ...base, enabled: true, functions: ['public-api'] },
    coordinator: f.client,
    provider: f.provider,
    observer: { observe: f.observe },
    probe: f.probe,
    loadAccepted: async () => f.x.baselineInput,
    loadCompatibility: async () => f.x.compatibilityInput,
    request,
    executorSha: 'c'.repeat(40),
    clock: () => f.x.now,
    adapterOptions: { pollIntervalMs: 1 },
    runId: 'restore-A',
    owner: runner('restore-operator'),
  };
  return { ...f, args };
}
test('D1 plans read-only, executes exact reviewed function restore and retains static B', async (t) => {
  const f = await setup(t);
  const commits = f.store.commits;
  const prepared = await planManualFunctionRecovery(f.args);
  assert.equal(f.store.commits, commits);
  assert.equal(f.sdk.state.updates, 0);
  const before = await f.client.runStatus('baseline-B');
  const result = await executeManualFunctionRecovery({ ...f.args, token: prepared.review.token });
  assert.equal(result.status, 'accepted');
  assert.equal(f.sdk.state.updates, 1);
  const accepted = await f.client.runStatus('restore-A');
  assert.deepEqual(accepted.composition.static, before.composition.static);
  assert.notEqual(accepted.accepted.activationId, before.accepted.activationId);
  assert.equal(result.searchNotifications, 0);
  assert.equal(result.databaseRestore, 'not-run');
});
for (const [label, change] of [
  [
    'disabled',
    (args) => {
      args.policy.enabled = false;
    },
  ],
  [
    'missing token',
    (args) => {
      args.token = undefined;
    },
  ],
  [
    'activation changed',
    (args) => {
      args.request.expectedActivationId = 'foreign';
    },
  ],
  [
    'scope widened',
    (args) => {
      args.request.names.push('admin');
    },
  ],
  [
    'proof changed',
    (args) => {
      args.request.compatibilityArtifactId = '99';
    },
  ],
  [
    'executor changed',
    (args) => {
      args.executorSha = 'd'.repeat(40);
    },
  ],
  [
    'reason changed',
    (args) => {
      args.request.reason = 'different';
    },
  ],
])
  test(`D1 refuses ${label} before an SDK write`, async (t) => {
    const f = await setup(t);
    const prepared = await planManualFunctionRecovery(f.args);
    const args = {
      ...f.args,
      policy: { ...f.args.policy },
      request: structuredClone(f.args.request),
      token: prepared.review.token,
    };
    change(args);
    await assert.rejects(executeManualFunctionRecovery(args));
    assert.equal(f.sdk.state.updates, 0);
  });
test('D1 rechecks plan under acquired lease and refuses context drift', async (t) => {
  const f = await setup(t);
  const prepared = await planManualFunctionRecovery(f.args);
  const acquire = f.client.acquire;
  const coordinator = {
    ...f.client,
    async acquire(owner) {
      const guard = await acquire(owner);
      f.changeObservation((x) => {
        x.data.revision = 'new';
      });
      return guard;
    },
  };
  await assert.rejects(
    executeManualFunctionRecovery({ ...f.args, coordinator, token: prepared.review.token }),
  );
  assert.equal(f.sdk.state.updates, 0);
});
test('D1 timeout or lost SDK acknowledgement keeps unknown and refuses another attempt', async (t) => {
  const f = await setup(t, { failure: 'lost-ack' });
  const prepared = await planManualFunctionRecovery(f.args);
  await assert.rejects(executeManualFunctionRecovery({ ...f.args, token: prepared.review.token }));
  assert.equal(f.sdk.state.updates, 1);
  const state = await f.client.status({ scopeKey: 'site' });
  assert(state.pendingStep);
  assert.notEqual((await f.client.runStatus('restore-A')).state, 'SUCCEEDED');
  await assert.rejects(executeManualFunctionRecovery({ ...f.args, token: prepared.review.token }));
  assert.equal(f.sdk.state.updates, 1);
});
test('D1 plan token expires without any cloud update', async (t) => {
  const f = await setup(t);
  const prepared = await planManualFunctionRecovery(f.args);
  await assert.rejects(
    executeManualFunctionRecovery({
      ...f.args,
      clock: () => f.x.now + 300001,
      token: prepared.review.token,
    }),
  );
  assert.equal(f.sdk.state.updates, 0);
});

test('real observation, standalone proof archive and D1 remain consistent through B to A', async (t) => {
  const { createFunctionObserver } = await import('./release/function-observation.mjs');
  const { produceFunctionCompatibilityReport } = await import('./release/function-report.mjs');
  const { functionRecoveryContext } = await import('./release/function-compatibility.mjs');
  const { writeFunctionReportArtifact } = await import('./release/function-report-artifact.mjs');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { sha256 } = await import('./release/input.mjs');
  const f = await setup(t);
  const root = mkdtempSync(join(tmpdir(), 'd1-standalone-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = {
    ...f.args.policy,
    writerInventorySha256: 'a'.repeat(64),
    clientInventorySha256: 'b'.repeat(64),
  };
  const state = {
    schemaVersion: 1,
    purpose: 'function-recovery-contract-state',
    target: f.x.target,
    revision: 'r1',
    data: f.x.observation.data,
    writers: {
      coverage: 'all',
      inventorySha256: policy.writerInventorySha256,
      functions: [{ name: 'public-api', codeShas: ['a'.repeat(40), 'b'.repeat(40)] }],
    },
    clients: {
      coverage: 'all-exposed',
      inventorySha256: policy.clientInventorySha256,
      revision: 'clients1',
      contracts: f.x.observation.exposedClientContracts,
    },
  };
  const observer = createFunctionObserver({
    policy,
    provider: f.provider,
    readContractState: async () => structuredClone(state),
    clock: () => f.x.now,
    readHealth: async (name) => ({
      name,
      status: 'healthy',
      target: f.x.target,
      codeSha: (f.sdk.state.bytes.equals(f.a) ? 'a' : 'b').repeat(40),
    }),
  });
  const observation = await observer.observe();
  const baseline = f.x.baseline;
  const contextSha256 = functionRecoveryContext({
    target: f.x.target,
    baseline,
    observation,
    now: f.x.now,
  }).sha256;
  // Synthetic suite receipts test plumbing only; they never certify production business behavior.
  const suitePolicy = ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'].map(
    (kind) => ({
      name: 'public-api',
      kind,
      testRef: `scripts/compatibility/${kind}.test.mjs`,
      suiteSha256: 'd'.repeat(64),
      requiredTests: ['fixture-case'],
      covers:
        kind === 'api-clients' ? observation.exposedClientContracts : observation.data.formats,
    }),
  );
  const evidence = {
    schemaVersion: 1,
    purpose: 'function-compatibility-test-results',
    status: 'passed',
    components: [
      {
        name: 'public-api',
        contextSha256,
        readerFormats: observation.data.formats,
        writerFormats: observation.data.formats,
        apiContracts: observation.exposedClientContracts,
        preservesUnknownFields: true,
        suites: suitePolicy.map((s) => ({
          ...s,
          tests: [{ name: 'fixture-case', status: 'passed' }],
        })),
      },
    ],
  };
  const report = produceFunctionCompatibilityReport({
    target: f.x.target,
    baselines: [baseline],
    observation,
    evidence,
    suitePolicy,
    source: {
      verified: true,
      event: 'workflow_dispatch',
      manifestSha256: 'e'.repeat(64),
      headSha: 'b'.repeat(40),
      artifactId: '21',
    },
    now: f.x.now,
  });
  const directory = join(root, 'report');
  const body = writeFunctionReportArtifact({
    directory,
    report,
    target: f.x.target,
    releaseId: 'proof-B',
    codeSha: 'b'.repeat(40),
    now: f.x.now,
  });
  const artifact = {
    ...f.x.compatibilityInput.envelope.artifact,
    manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
  };
  const compatibilityInput = {
    ...f.x.compatibilityInput,
    directory,
    envelope: { ...body, artifact },
  };
  const args = { ...f.args, policy, observer, loadCompatibility: async () => compatibilityInput };
  const prepared = await planManualFunctionRecovery(args);
  const result = await executeManualFunctionRecovery({ ...args, token: prepared.review.token });
  assert.equal(result.status, 'accepted');
  assert.equal((await observer.observe()).functions[0].codeSha, 'a'.repeat(40));
});
