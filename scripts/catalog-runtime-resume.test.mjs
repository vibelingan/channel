import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { functionManagerFixture } from './release-function-manager-fixture.mjs';
import { setCatalogRuntimeFlags } from './release/catalog-runtime-config.mjs';
import {
  assertCatalogRuntimeProof,
  settleCatalogRuntimeRecovery,
} from './release/catalog-runtime-recovery.mjs';
import {
  assertCatalogRecoveryInvocation,
  assertRecoveredCatalogSite,
  createCatalogRecoveryRecords,
  enableRecoveredCatalogReadiness,
  resumeCatalogWriters,
} from './release/catalog-runtime-resume.mjs';
import { identity } from './release/input.mjs';

const target = {
  envId: 'fixture-env',
  region: 'ap-shanghai',
  siteOrigin: 'https://fixture.example',
};
const names = ['admin', 'alibaba-catalog-sync', 'public-api'];
const executorSha = 'd'.repeat(40);
const beforeAcceptedSite = {
  activationId: 'previous-activation',
  sourceRunId: 'site-90-1',
  compositionHash: '7'.repeat(64),
};
const original = {
  schemaVersion: 1,
  purpose: 'initial-catalog-runtime',
  siteOrigin: target.siteOrigin,
  codeSha: '0'.repeat(40),
  sourceRunId: '10',
  configurationHash: '1'.repeat(64),
  maximumTimeoutSeconds: 20,
  observedAt: 0,
  usableAfter: 140_000,
  accepted: true,
  acceptedAt: 140_000,
};
const vars = (detail) =>
  Object.fromEntries(detail.Environment.Variables.map(({ Key, Value }) => [Key, Value]));
function changeFlag(detail, key, value) {
  const entry = detail.Environment.Variables.find((entry) => entry.Key === key);
  assert.ok(entry, key);
  entry.Value = value;
}
function fingerprint(value) {
  const candidate = structuredClone(value);
  candidate.Environment?.Variables.sort((a, b) => a.Key.localeCompare(b.Key));
  return createHmac('sha256', 'private-fixture-configuration-key')
    .update(identity(candidate))
    .digest('hex');
}
function memoryStore() {
  const rows = new Map([['runtime-activation', { _id: 'runtime-activation', ...original }]]);
  const writes = [];
  const hooks = {};
  const get = async (collection, id) => {
    assert.equal(collection, 'catalogSeoBuilders');
    return structuredClone(rows.get(id) ?? null);
  };
  return {
    rows,
    writes,
    hooks,
    get,
    async transaction(fn) {
      hooks.beforeTransaction?.();
      const staged = new Map();
      await fn({
        get,
        set: async (collection, row) => {
          assert.equal(collection, 'catalogSeoBuilders');
          staged.set(row._id, structuredClone(row));
        },
      });
      for (const [id, row] of staged) {
        rows.set(id, row);
        writes.push(structuredClone(row));
      }
      if (hooks.loseNextReply) {
        hooks.loseNextReply = false;
        throw Error('lost transaction acknowledgement');
      }
    },
  };
}
function fixture() {
  const functions = Object.fromEntries(
    names.map((name, index) => {
      const item = functionManagerFixture({ name, bytes: Buffer.from(`unchanged-${name}`) });
      item.releaseId = ['a', 'b', 'c'][index].repeat(40);
      item.state.detail.Timeout = name === 'alibaba-catalog-sync' ? 900 : 20;
      item.state.detail.Environment.Variables.push(
        { Key: 'TCB_ENV', Value: target.envId },
        { Key: 'CATALOG_DETAIL_APPROVAL_ENABLED', Value: '1' },
        { Key: 'CATALOG_SEO_SITE_ORIGIN', Value: target.siteOrigin },
        {
          Key: name === 'public-api' ? 'CATALOG_SEO_PAGE_READINESS' : 'CATALOG_SEO_RECORDING',
          Value: '0',
        },
        { Key: 'SALES_AGENT_ENABLED', Value: '1' },
        { Key: 'SALES_AGENT_SECRET', Value: 'must-remain-private-and-unchanged' },
      );
      return [name, item];
    }),
  );
  const store = memoryStore();
  const records = createCatalogRecoveryRecords(store, executorSha);
  const calls = [];
  const events = [];
  let time = 2_000_000;
  let clockEnabled = false;
  let websiteChanged = false;
  let programAccepted = true;
  let readCount = 0;
  const ports = {
    target,
    executorSha,
    sourceRunId: '100',
    beforeAcceptedSite,
    records,
    fingerprint,
    readFunctions: async () => {
      readCount++;
      return Object.fromEntries(
        await Promise.all(
          names.map(async (name) => {
            const detail = await functions[name].manager.functions.getFunctionDetail(name);
            return [
              name,
              {
                detail,
                health: {
                  releaseId: functions[name].releaseId,
                  catalogSeoRecording: vars(detail).CATALOG_SEO_RECORDING === '1',
                  catalogSeoPageReadiness: vars(detail).CATALOG_SEO_PAGE_READINESS === '1',
                },
              },
            ];
          }),
        ),
      );
    },
    assertClockStopped: async () => {
      if (clockEnabled) throw Error('Clock must remain disabled');
    },
    assertWebsiteUnchanged: async () => {
      if (websiteChanged) throw Error('Website baseline changed');
    },
    requireAncestor: async ({ beforeVersion, sourceSha }) => {
      calls.push({ operation: 'ancestry', beforeVersion, sourceSha });
      assert.equal(sourceSha, executorSha);
    },
    setFlags: async ({ name, phase, before }) => {
      calls.push({ operation: 'flags', name, phase });
      return setCatalogRuntimeFlags({
        manager: functions[name].manager,
        target,
        name,
        phase,
        before,
        wait: async () => {},
      });
    },
    settle: (args) =>
      settleCatalogRuntimeRecovery({
        ...args,
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
      }),
    report: (event) => events.push(event),
    assertAcceptedProgram: async ({ preparation, proof }) => {
      const accepted = acceptedSite(proof);
      if (!programAccepted) {
        // Reproduce the old bug: active and baseline match, but both are the pre-recovery site.
        accepted.status.scope.baseline = structuredClone(beforeAcceptedSite);
        accepted.active.acceptedRunId = beforeAcceptedSite.sourceRunId;
      }
      return assertRecoveredCatalogSite({
        ...accepted,
        beforeAcceptedSite: preparation.beforeAcceptedSite,
        executorSha,
        proof,
        target,
      });
    },
    assertRecoveryProof: assertCatalogRuntimeProof,
  };
  return {
    functions,
    store,
    records,
    calls,
    events,
    ports,
    get time() {
      return time;
    },
    get readCount() {
      return readCount;
    },
    set clockEnabled(value) {
      clockEnabled = value;
    },
    set websiteChanged(value) {
      websiteChanged = value;
    },
    set programAccepted(value) {
      programAccepted = value;
    },
  };
}

function acceptedSite(proof) {
  const runId = 'site-101-1';
  const activationId = 'new-activation';
  const artifact = { repository: 'fixture/repository', manifestSha256: '9'.repeat(64) };
  const composition = {
    static: { codeSha: executorSha, releaseId: runId, contentSha256: '8'.repeat(64), artifact },
  };
  const pointer = { activationId, sourceRunId: runId, compositionHash: identity(composition) };
  return {
    status: {
      state: 'idle',
      targetId: 'fixture-target',
      target: {
        lease: null,
        currentRunId: null,
        dirtyRunId: null,
        unresolvedOperation: null,
      },
      pendingStep: null,
      scope: { scopeKey: 'site', baseline: pointer },
    },
    run: {
      runId,
      state: 'SUCCEEDED',
      scopeKey: 'site',
      targetId: 'fixture-target',
      composition,
      compositionHash: pointer.compositionHash,
      createdAt: proof.acceptedAt + 1,
      completedAt: proof.acceptedAt + 3,
      accepted: {
        ...pointer,
        acceptedAt: proof.acceptedAt + 2,
        seals: { static: { ...composition.static, activationId, target } },
      },
    },
    active: {
      acceptedRunId: runId,
      codeSha: executorSha,
      executorSha,
      executorRef: 'feat/seo-foundation',
      manifestSha256: '6'.repeat(64),
      catalogTracked: true,
    },
    approved: {
      schemaVersion: 1,
      inputSchema: 1,
      codeSha: executorSha,
      manifestSha256: '6'.repeat(64),
    },
  };
}
function codeAndSalesUnchanged(x) {
  for (const name of names) {
    const item = x.functions[name];
    assert.equal(item.state.updates, 0, `${name}: no function code update`);
    assert.deepEqual(item.state.bytes, Buffer.from(`unchanged-${name}`));
    assert.equal(vars(item.state.detail).SALES_AGENT_ENABLED, '1');
    assert.equal(vars(item.state.detail).SALES_AGENT_SECRET, 'must-remain-private-and-unchanged');
    assert.ok(item.state.calls.every((call) => call.action !== 'UpdateFunctionCode'));
  }
}

test('only the exact manual SEO workflow identity can enter either recovery phase', () => {
  const policy = {
    repository: 'fixture/repository',
    trustedRef: 'refs/heads/feat/seo-foundation',
    workflowPath: '.github/workflows/seo-static-canary.yml',
    envId: target.envId,
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: policy.repository,
    GITHUB_REF: policy.trustedRef,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}`,
    GITHUB_SHA: executorSha,
    GITHUB_RUN_ID: '100',
    TCB_ENV_ID: target.envId,
    CATALOG_RUNTIME_ACTION: 'resume',
  };
  for (const phase of ['resume', 'resume-readiness'])
    assert.deepEqual(
      assertCatalogRecoveryInvocation({ ...env, CATALOG_RUNTIME_ACTION: phase }, policy),
      { executorSha, sourceRunId: '100' },
    );
  for (const invalid of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_REPOSITORY: 'other/repository' },
    { GITHUB_REF: 'refs/heads/test' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'unreviewed-workflow' },
    { TCB_ENV_ID: 'other-app' },
    { GITHUB_SHA: 'HEAD' },
    { GITHUB_RUN_ID: '0' },
    { CATALOG_RUNTIME_ACTION: 'record' },
    { CATALOG_RUNTIME_SHA: 'e'.repeat(40) },
  ])
    assert.throws(() => assertCatalogRecoveryInvocation({ ...env, ...invalid }, policy));
});

test('real SDK configuration port enables only two writers, preserves Sales and archives a fresh 1020-second proof', async () => {
  const x = fixture();
  const result = await resumeCatalogWriters(x.ports);
  assert.equal(x.time, 3_020_000);
  assert.equal(x.readCount, 3, 'initial observation plus two actual state checks; no wait polling');
  assert.equal(result.proof.schemaVersion, 2);
  assert.equal(result.proof.accepted, true);
  assert.equal(result.proof.maximumTimeoutSeconds, 900);
  assert.equal(result.proof.previousActivationHash, identity(original));
  assert.deepEqual(
    result.proof.writerVersions,
    names.slice(0, 2).map((name) => ({ name, releaseId: x.functions[name].releaseId })),
  );
  assert.equal(x.functions.admin.state.configUpdates, 1);
  assert.equal(x.functions['alibaba-catalog-sync'].state.configUpdates, 1);
  assert.equal(x.functions['public-api'].state.configUpdates ?? 0, 0);
  assert.equal(vars(x.functions['public-api'].state.detail).CATALOG_SEO_PAGE_READINESS, '0');
  const saved = await x.records.getPreparation();
  assert.deepEqual(saved.previousActivation, original);
  assert.deepEqual(
    saved.functions.map((row) => row.previousFlags.CATALOG_SEO_RECORDING),
    ['0', '0', undefined],
  );
  assert.deepEqual(await x.records.registry.getHistory(identity(original)), original);
  for (const value of [saved, result, x.store.writes, x.events])
    for (const secret of ['must-remain-private-and-unchanged', 'sdk-fixture-secret'])
      assert.equal(JSON.stringify(value).includes(secret), false);
  assert.deepEqual(
    x.calls.filter((call) => call.operation === 'flags'),
    names.slice(0, 2).map((name) => ({ operation: 'flags', name, phase: 'record' })),
  );
  assert.equal(result.websiteWrites + result.businessWrites + result.functionCodeWrites, 0);
  codeAndSalesUnchanged(x);
});

test('a new workflow run resumes its saved proof without resetting the wait or repeating configuration writes', async () => {
  const x = fixture();
  const first = await resumeCatalogWriters(x.ports);
  const writeCount = x.store.writes.length;
  const second = await resumeCatalogWriters({ ...x.ports, sourceRunId: '101' });
  assert.deepEqual(second.proof, first.proof);
  assert.equal(second.proof.sourceRunId, '100');
  assert.equal(x.store.writes.length, writeCount);
  assert.equal(x.time, 3_020_000);
  assert.equal(x.functions.admin.state.configUpdates, 1);
  assert.equal(x.functions['alibaba-catalog-sync'].state.configUpdates, 1);
});

test('partial writer update retains the original preparation and can safely continue', async () => {
  const x = fixture();
  await assert.rejects(
    resumeCatalogWriters({
      ...x.ports,
      setFlags: async (args) => {
        if (args.name === 'alibaba-catalog-sync') throw Error('stop before second writer update');
        return x.ports.setFlags(args);
      },
    }),
  );
  assert.equal(
    (await x.records.getPreparation()).functions[0].previousFlags.CATALOG_SEO_RECORDING,
    '0',
  );
  assert.deepEqual(await x.records.registry.get(), original);
  const recovered = await resumeCatalogWriters({ ...x.ports, sourceRunId: '101' });
  assert.equal(recovered.proof.accepted, true);
  assert.equal(x.functions.admin.state.configUpdates, 1);
  assert.equal(x.functions['alibaba-catalog-sync'].state.configUpdates, 1);
  codeAndSalesUnchanged(x);
});

test('clock, website, invalid old proof, ancestry, masked settings and foreign environment stop before function writes', async () => {
  for (const prepare of [
    (x) => {
      x.clockEnabled = true;
    },
    (x) => {
      x.websiteChanged = true;
    },
    (x) => {
      x.store.rows.get('runtime-activation').accepted = false;
    },
    (x) => {
      x.ports.requireAncestor = async () => {
        throw Error('source not an ancestor');
      };
    },
    (x) => {
      changeFlag(x.functions.admin.state.detail, 'JWT_SECRET', '***');
    },
    (x) => {
      x.functions.admin.state.detail.Namespace = 'other-app';
    },
  ]) {
    const x = fixture();
    prepare(x);
    await assert.rejects(resumeCatalogWriters(x.ports));
    assert.ok(names.every((name) => !x.functions[name].state.configUpdates));
    assert.ok(names.every((name) => !x.functions[name].state.updates));
  }
});

test('changed source or unrelated settings during the drain never become an accepted proof', async () => {
  for (const mutate of [
    (x) => {
      x.functions.admin.releaseId = 'e'.repeat(40);
    },
    (x) => {
      changeFlag(x.functions.admin.state.detail, 'SALES_AGENT_ENABLED', '0');
    },
  ]) {
    const x = fixture();
    let time = x.time;
    x.ports.settle = (args) =>
      settleCatalogRuntimeRecovery({
        ...args,
        now: () => time,
        wait: async (ms) => {
          time += ms;
          mutate(x);
        },
      });
    await assert.rejects(resumeCatalogWriters(x.ports));
    const row = await x.records.registry.get();
    assert.equal(row.accepted, false);
    await assert.rejects(resumeCatalogWriters(x.ports));
    assert.equal(x.functions['public-api'].state.configUpdates ?? 0, 0);
  }
});

test('a disabled running writer cannot get a drain proof merely from an SDK update receipt', async () => {
  const x = fixture();
  const read = x.ports.readFunctions;
  x.ports.readFunctions = async () => {
    const current = await read();
    current.admin.health.catalogSeoRecording = false;
    return current;
  };
  await assert.rejects(resumeCatalogWriters(x.ports), /has not confirmed recording/);
  assert.deepEqual(await x.records.registry.get(), original);
});

test('control-record CAS rejects a changed activation, and immutable preparation settles a lost acknowledgement', async () => {
  const x = fixture();
  await x.records.registry.get();
  x.store.rows.set('runtime-activation', {
    _id: 'runtime-activation',
    ...original,
    sourceRunId: '11',
  });
  await assert.rejects(x.records.registry.set({ ...original, sourceRunId: '12' }), /changed/);
  assert.equal(x.store.rows.get('runtime-activation').sourceRunId, '11');
  x.store.hooks.loseNextReply = true;
  await x.records.putPreparation({ schemaVersion: 1, harmless: 'fixture' });
  assert.deepEqual(await x.records.getPreparation(), { schemaVersion: 1, harmless: 'fixture' });
  await assert.rejects(x.records.putPreparation({ schemaVersion: 1, harmless: 'different' }));
  assert.throws(() =>
    x.records.registry.putHistory(identity(original), { ...original, sourceRunId: '12' }),
  );
  const fresh = createCatalogRecoveryRecords(x.store, executorSha);
  await assert.rejects(fresh.registry.set(original), /Observe/);
});

test('readiness waits for the accepted current renderer, then changes only public-api configuration', async () => {
  const x = fixture();
  await resumeCatalogWriters(x.ports);
  x.programAccepted = false;
  await assert.rejects(enableRecoveredCatalogReadiness(x.ports), /new current-program/);
  assert.equal(x.functions['public-api'].state.configUpdates ?? 0, 0);
  x.programAccepted = true;
  const result = await enableRecoveredCatalogReadiness(x.ports);
  assert.equal(result.changed, true);
  assert.equal(x.functions['public-api'].state.configUpdates, 1);
  assert.equal(x.functions.admin.state.configUpdates, 1);
  assert.equal(x.functions['alibaba-catalog-sync'].state.configUpdates, 1);
  assert.equal(vars(x.functions['public-api'].state.detail).CATALOG_SEO_PAGE_READINESS, '1');
  assert.equal(result.websiteWrites + result.businessWrites + result.functionCodeWrites, 0);
  codeAndSalesUnchanged(x);
  assert.equal((await enableRecoveredCatalogReadiness(x.ports)).changed, false);
  assert.equal(x.functions['public-api'].state.configUpdates, 1);
  assert.equal((await resumeCatalogWriters(x.ports)).proof.accepted, true);
});

test('fresh accepted website evidence binds actual run, activation, renderer and post-recovery timing', async () => {
  const x = fixture();
  const { proof } = await resumeCatalogWriters(x.ports);
  const validate = (observed) =>
    assertRecoveredCatalogSite({ ...observed, beforeAcceptedSite, proof, executorSha, target });
  assert.deepEqual(validate(acceptedSite(proof)), acceptedSite(proof).status.scope.baseline);
  for (const mutate of [
    (observed) => {
      observed.run.state = 'FAILED';
    },
    (observed) => {
      observed.run.createdAt = proof.acceptedAt - 1;
    },
    (observed) => {
      observed.run.accepted.acceptedAt = proof.acceptedAt - 1;
    },
    (observed) => {
      observed.run.accepted.activationId = 'other-activation';
    },
    (observed) => {
      observed.run.compositionHash = '0'.repeat(64);
    },
    (observed) => {
      observed.run.accepted.seals.static.codeSha = '0'.repeat(40);
    },
    (observed) => {
      observed.active.codeSha = '0'.repeat(40);
    },
    (observed) => {
      observed.active.executorSha = '0'.repeat(40);
    },
    (observed) => {
      observed.approved.manifestSha256 = '0'.repeat(64);
    },
  ]) {
    const observed = acceptedSite(proof);
    mutate(observed);
    assert.throws(() => validate(observed));
  }
});

test('once a recovery proof exists, re-disabled writers cannot reuse its old waiting deadline', async () => {
  for (const accepted of [false, true]) {
    const x = fixture();
    await resumeCatalogWriters(x.ports);
    if (!accepted) {
      const { acceptedAt: _acceptedAt, ...row } = x.store.rows.get('runtime-activation');
      x.store.rows.set('runtime-activation', { ...row, accepted: false });
    }
    const count = x.functions.admin.state.configUpdates;
    changeFlag(x.functions.admin.state.detail, 'CATALOG_SEO_RECORDING', '0');
    await assert.rejects(resumeCatalogWriters(x.ports), /new recovery epoch/);
    assert.equal(x.functions.admin.state.configUpdates, count);
    assert.equal(vars(x.functions.admin.state.detail).CATALOG_SEO_RECORDING, '0');
  }
});

test('old proof, changed executor, source drift or disabled writer prevents enabling readiness', async () => {
  for (const mutate of [
    (x) => {
      x.store.rows.set('runtime-activation', { _id: 'runtime-activation', ...original });
    },
    (x) => {
      x.store.rows.get('runtime-activation').executorSha = 'e'.repeat(40);
    },
    (x) => {
      x.functions.admin.releaseId = 'e'.repeat(40);
    },
    (x) => {
      changeFlag(x.functions.admin.state.detail, 'CATALOG_SEO_RECORDING', '0');
    },
  ]) {
    const x = fixture();
    await resumeCatalogWriters(x.ports);
    mutate(x);
    await assert.rejects(enableRecoveredCatalogReadiness(x.ports));
    assert.equal(x.functions['public-api'].state.configUpdates ?? 0, 0);
  }
});

test('workflow routes only the new phases to the config-only entry and keeps old staging requirements', async () => {
  const path = new URL('../.github/workflows/seo-static-canary.yml', import.meta.url);
  const workflow = parse(readFileSync(path, 'utf8'));
  const job = workflow.jobs.catalog_runtime;
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.catalog_runtime_action.options, [
    'stage',
    'record',
    'readiness',
    'resume',
    'resume-readiness',
  ]);
  assert.equal(workflow.concurrency.group, 'cloudbase-deploy-test');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(job.environment, 'test');
  assert.ok(job['timeout-minutes'] >= 30);
  const entry = job.steps.find((step) => step.with?.script?.includes('stage-catalog-runtime.ts'));
  assert.ok(entry);
  for (const phase of ['stage', 'record', 'readiness', 'resume', 'resume-readiness']) {
    const spawned = [];
    await runInNewContext(`(async () => { ${entry.with.script} })()`, {
      process: { env: { CATALOG_RUNTIME_ACTION: phase } },
      require: (name) => {
        assert.equal(name, 'node:child_process');
        return {
          spawn: (executable, args, options) => {
            spawned.push({ executable, args: [...args], environment: options.env });
            return { once: (event, callback) => event === 'exit' && callback(0) };
          },
        };
      },
    });
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, [
      ['resume', 'resume-readiness'].includes(phase)
        ? 'scripts/resume-catalog-runtime.ts'
        : 'scripts/stage-catalog-runtime.ts',
    ]);
    for (const step of job.steps.filter((step) =>
      [step.run, step.name].some((value) =>
        /package:functions|actual function runtime/.test(value ?? ''),
      ),
    )) {
      assert.equal(step.if, "${{ inputs.catalog_runtime_action == 'stage' }}");
    }
  }
});
