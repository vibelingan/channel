import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from '../blog/site-baseline.mjs';
import { createCanaryProvider } from '../release/canary-provider.mjs';
import { dummySuitePolicy } from '../release/dummy-recovery-fixture.mjs';
import { checkFunctionArchive } from '../release/function-archive.mjs';
import { verifyFunctionBaseline, writeFunctionBaseline } from '../release/function-baseline.mjs';
import { createFunctionGithubSource } from '../release/function-github-source.mjs';
import {
  executeManualFunctionRecovery,
  planManualFunctionRecovery,
} from '../release/function-orchestrator.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { writeFunctionReportArtifact } from '../release/function-report-artifact.mjs';
import { produceFunctionCompatibilityReport } from '../release/function-report.mjs';
import { runFunctionCompatibilityTests } from '../release/function-test-runner.mjs';
import { createGithubReadClient } from '../release/github-read.mjs';
import { createGithubSource } from '../release/github-source.mjs';
import { identity, sha256 } from '../release/input.mjs';
import { SITE_DELIVERY_POLICY } from '../release/site-policy.mjs';
import { createReleaseCoordinator } from '../release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from '../release/store-cloudbase.mjs';
import { buildLiveDummyFunction } from './build-function.mjs';
import { cleanupDummyResources } from './cleanup.mjs';
import { journalDummyDelivery } from './journal.mjs';
import { readDummyFixtures } from './read-fixtures.mjs';
import { readbackDummyStatic } from './readback.mjs';
import { prepareDummyInitialization } from './resources.mjs';
import { createDummyInvoker, dummyFunctionConfiguration, readDummyInvocation } from './runtime.mjs';
import { createDummyStaticLoader, exerciseDummyStatic } from './static.mjs';

const env = process.env;
const { codeSha, runId: githubRun } = readDummyInvocation(env);
const operation = env.DUMMY_OPERATION;
if (
  !['initialize', 'publish', 'restore', 'readback', 'cleanup'].includes(operation) ||
  !env.GITHUB_TOKEN ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY
)
  throw Error('Explicit drill operation and existing deployment credentials required');
const name = 'seo-release-dummy';
const functionKey = `function:${name}`;
const policy = { ...SITE_DELIVERY_POLICY, enabled: true, functions: [name] };
const target = { envId: policy.envId, siteOrigin: policy.siteOrigin };
const credentials = {
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
};
const manager = new CloudBase(credentials);
const db = createCloudbaseReleaseDatabase({ ...credentials, env: policy.envId });
const coordinator = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({ db, envId: policy.envId, profile: 'drill' }),
  policy,
});
const production = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
  policy: SITE_DELIVERY_POLICY,
});
const source = createFunctionGithubSource({ policy, token: env.GITHUB_TOKEN });
await source.requireCI(codeSha);
await createCanaryProvider({ manager, policy }).controlPlane({ execute: true });
const siteBefore = await readBlogSiteBaseline();
const productionBefore = await production.status({ scopeKey: 'site' });
if (
  productionBefore.state !== 'idle' ||
  productionBefore.target?.dirtyRunId ||
  productionBefore.pendingStep ||
  !productionBefore.scope.baseline
)
  throw Error('Finish the existing website delivery before the isolated drill');
const output = resolve('output/recovery-drill');
await mkdir(output, { recursive: true });
const record = {
  purpose: 'channel-live-dummy-recovery-v1',
  operation,
  codeSha,
  githubRun,
  target,
  websiteWrites: 0,
  businessWrites: 0,
  databaseRestore: 'not-run',
  searchNotifications: 0,
  status: 'preflight',
  steps: [],
};
const save = () => writeFile(join(output, 'result.json'), JSON.stringify(record, null, 2));
const owner = {
  ownerRunId: `dummy-${githubRun}-${env.GITHUB_RUN_ATTEMPT}`,
  runnerRef: `github:${policy.repository}:${githubRun}:attempt-${env.GITHUB_RUN_ATTEMPT}:drill`,
};
const provider = createCloudbaseFunctionProvider({
  manager,
  target,
  region: policy.region,
  names: [name],
  configurationKey: createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
    .update('channel-dummy-configuration-v1')
    .digest(),
});
const artifactClient = new DefaultArtifactClient();
async function archive(directory, prefix, kind = 'payload') {
  const walk = async (dir) =>
    (
      await Promise.all(
        (
          await readdir(dir, { withFileTypes: true })
        ).map((x) => (x.isDirectory() ? walk(join(dir, x.name)) : join(dir, x.name))),
      )
    ).flat();
  const result = await artifactClient.uploadArtifact(
    `${prefix}-${githubRun}-${env.GITHUB_RUN_ATTEMPT}`,
    await walk(directory),
    directory,
    { retentionDays: 90 },
  );
  if (!result.id || !result.digest) throw Error('Drill archive was not durably stored');
  const input = await source.download(String(result.id), `${directory}-verified`, kind, {
    allowCurrentRunId: githubRun,
  });
  return {
    ...input,
    envelope: {
      ...input.body,
      artifact: {
        repository: policy.repository,
        workflowPath: policy.workflowPath,
        runId: input.run.runId,
        artifactId: String(result.id),
        expiresAt: input.run.artifact.expiresAt,
        manifestSha256: input.manifestSha256,
      },
    },
    policy: {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      target,
      scope: { kind: 'site' },
    },
  };
}
let invoke;
let seedRun;
let token;
function bind(run) {
  if (!/^[1-9][0-9]{0,19}$/.test(run)) throw Error('Unknown dummy owner');
  seedRun = run;
  token = createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
    .update(`channel-live-dummy:v1:${policy.envId}:${run}`)
    .digest('hex');
  invoke = createDummyInvoker({
    manager,
    token,
    onResponse: (value) => {
      record.invocations ??= [];
      record.invocations.push(value);
    },
  });
}
const id = (suffix) => `seo-drill-${seedRun}-${suffix}`;
async function health() {
  const value = await invoke({ action: 'health' });
  if (
    value.purpose !== 'channel-recovery-dummy-v1' ||
    value.runId !== seedRun ||
    !['A', 'B'].includes(value.version) ||
    !/^[a-f0-9]{40}$/.test(value.codeSha)
  )
    throw Error('Actual dummy program identity differs');
  return value;
}
async function ready(version, expectedCode, hash, configurationToken) {
  const deadline = Date.now() + 120000;
  let stable = 0;
  for (;;) {
    const snapshot = await provider.inspect(name);
    if (configurationToken && snapshot.configurationToken !== configurationToken)
      throw Error('Dummy configuration changed');
    if (snapshot.status === 'Active' && snapshot.availableStatus === 'Available') {
      if (hash && snapshot.packageSha256 !== hash) throw Error('Unexpected dummy program package');
      const actual = await health();
      if (actual.version === version && actual.codeSha === expectedCode) stable++;
      else stable = 0;
      if (stable === 2) return snapshot;
    }
    if (Date.now() >= deadline) throw Error('Dummy program did not become ready');
    await pause(1000);
  }
}
const readFixtures = () => readDummyFixtures(db, seedRun);

async function loadAccepted(run) {
  if (
    run?.state !== 'SUCCEEDED' ||
    !run.accepted ||
    run.scopeKey !== 'site' ||
    !run.composition[functionKey]
  )
    throw Error('An accepted dummy A is required');
  const part = run.composition[functionKey];
  const directory = join(output, `source-${run.runId}`);
  await source.requireCI(part.codeSha);
  const item = await source.download(part.artifact.artifactId, directory, 'payload', {
    acceptedSeal: run.accepted.seals[functionKey],
  });
  const input = {
    ...item,
    envelope: { ...item.body, artifact: part.artifact },
    acceptedSeal: run.accepted.seals[functionKey],
    policy: {
      repository: policy.repository,
      workflowPath: policy.workflowPath,
      event: 'workflow_dispatch',
      ref: policy.trustedRef,
      target,
      scope: { kind: 'site' },
    },
  };
  const verified = verifyFunctionBaseline(input);
  if (
    verified.envelope.functions.length !== 1 ||
    verified.envelope.functions[0].name !== name ||
    !/^dummy-[1-9][0-9]*-A$/.test(verified.envelope.releaseId)
  )
    throw Error('Only the actual accepted dummy A may be restored');
  return input;
}
await save();
try {
  if (operation === 'cleanup') {
    const sourceA = await coordinator.runStatus(env.DUMMY_RESTORE_RUN_ID);
    const baseline = await loadAccepted(sourceA);
    bind(/^dummy-([1-9][0-9]*)-A$/.exec(sourceA.runId)?.[1]);
    record.stage = 'remove-finished-dummy-only';
    await save();
    record.cleanup = await cleanupDummyResources({
      manager,
      db,
      coordinator,
      provider,
      canaryProvider: createCanaryProvider({ manager, policy }),
      health,
      baseline,
      seedRun,
      expectedActivationId: env.DUMMY_EXPECTED_ACTIVATION,
      output,
      artifactClient,
      githubRun,
      attempt: env.GITHUB_RUN_ATTEMPT,
      policy,
      loadStatic: createDummyStaticLoader({
        source: createGithubSource({ policy, token: env.GITHUB_TOKEN }),
        policy,
        output,
      }),
    });
    record.websiteWrites = record.cleanup.fileDeletes;
  } else if (operation === 'readback') {
    const functionStatus = await coordinator.status({ scopeKey: 'site' });
    assert.equal(functionStatus.scope.active.activationId, env.DUMMY_EXPECTED_ACTIVATION);
    record.stage = 'readback-interrupted-static-A';
    await save();
    record.readback = await readbackDummyStatic({
      coordinator,
      provider: createCanaryProvider({ manager, policy }),
      policy,
      github: createGithubReadClient({ policy, token: env.GITHUB_TOKEN }),
      loadAccepted: createDummyStaticLoader({
        source: createGithubSource({ policy, token: env.GITHUB_TOKEN }),
        policy,
        output,
      }),
      runId: env.DUMMY_RESTORE_RUN_ID,
    });
  } else if (operation === 'initialize') {
    record.stage = 'prepare-fixed-test-resources';
    record.collections = await prepareDummyInitialization(manager, coordinator);
    await save();
    bind(githubRun);
    const built = await buildLiveDummyFunction({
      directory: join(output, 'build-A'),
      version: 'A',
      codeSha,
    });
    checkFunctionArchive(built.bytes, { smoke: true });
    record.stage = 'create-private-dummy-A';
    record.status = 'creating-dummy';
    await save();
    await manager.functions.createFunction({
      func: dummyFunctionConfiguration(seedRun, sha256(token)),
      base64Code: built.bytes.toString('base64'),
      deployMode: 'zip',
    });
    record.stage = 'verify-private-dummy-A';
    await save();
    await ready('A', codeSha);
    let denied;
    await assert.rejects(
      createDummyInvoker({
        manager,
        token: '0'.repeat(64),
        onResponse: (value) => {
          denied = value;
        },
      })({ action: 'health' }),
    );
    assert(
      denied?.platformRequestId && denied.authenticationRejected,
      'A network failure is not proof of rejected authentication',
    );
    await invoke({
      action: 'create',
      id: id('existing'),
      requestId: `${githubRun}:initial`,
      label: 'Harmless recovery fixture',
    });
    const updated = await invoke({
      action: 'update',
      id: id('existing'),
      requestId: `${githubRun}:initial-update`,
      expectedRevision: 1,
      patch: { label: 'A confirmed database write' },
    });
    assert.equal(updated.record.revision, 2);
    const capture = await provider.capture(name);
    assert.deepEqual(
      checkFunctionArchive(capture.bytes).contentSha256,
      checkFunctionArchive(built.bytes).contentSha256,
    );
    const descriptor = {
      name,
      packagePath: `functions/${name}.zip`,
      sha256: sha256(capture.bytes),
      runtime: capture.snapshot.runtime,
      handler: capture.snapshot.handler,
      role: capture.snapshot.role,
      layers: capture.snapshot.layers,
      requiredConfigKeys: ['DUMMY_RUN_ID', 'DUMMY_TOKEN_DIGEST'],
    };
    const directory = join(output, 'baseline-A');
    record.stage = 'archive-working-A';
    await save();
    writeFunctionBaseline({
      directory,
      target,
      codeSha,
      releaseId: `dummy-${githubRun}-A`,
      functions: [{ descriptor, bytes: capture.bytes }],
    });
    const input = await archive(directory, 'function-release-payload');
    verifyFunctionBaseline({ ...input, mode: 'candidate' });
    const realSite = await production.runStatus(productionBefore.scope.baseline.sourceRunId);
    const composition = {
      static: realSite.composition.static,
      [functionKey]: {
        releaseId: input.envelope.releaseId,
        codeSha,
        contentSha256: descriptor.sha256,
        artifact: input.envelope.artifact,
      },
    };
    const runId = `dummy-${githubRun}-A`;
    await journalDummyDelivery({
      coordinator,
      owner,
      runId,
      composition,
      adopt: true,
      verify: async () => {
        await ready('A', codeSha, descriptor.sha256, capture.snapshot.configurationToken);
        await checkBlogSiteBaseline(siteBefore);
      },
    });
    record.acceptedRunId = runId;
    record.sourceArtifact = input.envelope.artifact;
    record.steps.push(
      'Actual A creates and updates an isolated CloudBase record; working package archived and accepted',
    );
  } else {
    const state = await coordinator.status({ scopeKey: 'site' });
    if (state.state !== 'idle' || state.pendingStep || state.target.dirtyRunId)
      throw Error('Earlier drill requires readback');
    if (state.scope.active?.activationId !== env.DUMMY_EXPECTED_ACTIVATION)
      throw Error('Dummy activation changed');
    const detail = await manager.functions.getFunctionDetail(name);
    const variables = Object.fromEntries(
      detail.Environment.Variables.map(({ Key, Value }) => [Key, Value]),
    );
    bind(variables.DUMMY_RUN_ID);
    if (variables.DUMMY_TOKEN_DIGEST !== sha256(token))
      throw Error('Dummy authentication configuration changed');
    const before = await provider.read(name);
    const active = await coordinator.runStatus(state.scope.baseline.sourceRunId);
    if (
      active.composition[functionKey].contentSha256 !== before.packageSha256 ||
      active.composition[functionKey].codeSha !== (await health()).codeSha
    )
      throw Error('The actual dummy differs from its accepted version');
    if (operation === 'publish') {
      record.stage = 'archive-candidate-B';
      await save();
      assert.equal((await health()).version, 'A');
      const built = await buildLiveDummyFunction({
        directory: join(output, 'build-B'),
        version: 'B',
        codeSha,
      });
      const descriptor = {
        name,
        packagePath: `functions/${name}.zip`,
        sha256: sha256(built.bytes),
        runtime: before.runtime,
        handler: before.handler,
        role: before.role,
        layers: before.layers,
        requiredConfigKeys: ['DUMMY_RUN_ID', 'DUMMY_TOKEN_DIGEST'],
      };
      const directory = join(output, 'candidate-B');
      writeFunctionBaseline({
        directory,
        target,
        codeSha,
        releaseId: `dummy-${githubRun}-B`,
        functions: [{ descriptor, bytes: built.bytes }],
      });
      const input = await archive(directory, 'function-release-payload');
      verifyFunctionBaseline({ ...input, mode: 'candidate' });
      const runId = `dummy-${githubRun}-B`;
      record.stage = 'deploy-dummy-B';
      await save();
      await journalDummyDelivery({
        coordinator,
        owner,
        runId,
        composition: {
          [functionKey]: {
            releaseId: input.envelope.releaseId,
            codeSha,
            contentSha256: descriptor.sha256,
            artifact: input.envelope.artifact,
          },
        },
        write: () =>
          provider.updateCode({
            name,
            runtime: before.runtime,
            handler: before.handler,
            bytes: built.bytes,
            sha256: descriptor.sha256,
            expectedSnapshot: before,
          }),
        verify: async () => {
          await ready('B', codeSha, descriptor.sha256, before.configurationToken);
          await checkBlogSiteBaseline(siteBefore);
        },
      });
      const existing = (await invoke({ action: 'read', id: id('existing') })).record;
      record.stage = 'test-real-B-record-writes';
      await save();
      await invoke({
        action: 'update',
        id: id('existing'),
        requestId: `${githubRun}:note`,
        expectedRevision: existing.revision,
        patch: { note: 'B optional field must survive recovery' },
      });
      await invoke({
        action: 'create',
        id: id('new-b'),
        requestId: `${githubRun}:new`,
        label: 'Created under B',
        note: 'Keep this record',
      });
      await invoke({
        action: 'create',
        id: id('deleted-b'),
        requestId: `${githubRun}:deleted-create`,
        label: 'Must stay withdrawn',
        note: 'Keep tombstone',
      });
      await invoke({
        action: 'delete',
        id: id('deleted-b'),
        requestId: `${githubRun}:delete`,
        expectedRevision: 1,
      });
      record.acceptedRunId = runId;
      record.steps.push(
        'B deployed with a real function code update; optional field, new record and tombstone written through the live function',
      );
    } else {
      record.stage = 'prove-archived-A-compatibility';
      await save();
      const accepted = await coordinator.runStatus(env.DUMMY_RESTORE_RUN_ID);
      const baseline = await loadAccepted(accepted);
      const descriptor = { ...baseline.envelope.functions[0], codeSha: baseline.envelope.codeSha };
      const archivedHealth = checkFunctionArchive(
        await readFile(join(baseline.directory, descriptor.packagePath)),
      );
      if (!archivedHealth.contentSha256) throw Error('Invalid archived dummy A');
      const rowsBefore = await readFixtures();
      const observe = async () => {
        const first = await provider.read(name);
        const actual = await health();
        const rows = await readFixtures();
        const after = await provider.read(name);
        if (
          first.packageSha256 !== after.packageSha256 ||
          first.configurationToken !== after.configurationToken ||
          first.versionToken !== after.versionToken
        )
          throw Error('Dummy changed during observation');
        return {
          target,
          observedAt: Date.now(),
          data: {
            revision: identity(rows),
            formats: rows.some((r) => Object.hasOwn(r, 'note'))
              ? ['dummy-v1', 'dummy-v2']
              : ['dummy-v1'],
            constraintsSha256: identity({
              collection: 'seoReleaseDrillFixtures',
              purpose: 'channel-recovery-dummy-v1',
              seedRun,
            }),
          },
          exposedClientContracts: ['dummy-ui-v1', 'dummy-ui-v2'],
          functions: [
            {
              name,
              codeSha: actual.codeSha,
              packageSha256: after.packageSha256,
              status: after.status,
              availableStatus: after.availableStatus,
              runtime: after.runtime,
              handler: after.handler,
              role: after.role,
              layers: after.layers,
              configuration: {
                revision: after.configurationToken,
                references: after.configurationReferences,
              },
            },
          ],
        };
      };
      const observation = await observe();
      const suites = dummySuitePolicy(process.cwd());
      const tests = runFunctionCompatibilityTests({
        root: process.cwd(),
        directory: baseline.directory,
        baselines: [descriptor],
        observation,
        policy: { compatibilitySuites: suites },
      });
      const testsDirectory = join(output, 'compatibility-tests');
      await mkdir(testsDirectory);
      await writeFile(join(testsDirectory, 'test-results.json'), JSON.stringify(tests));
      const evidence = await archive(testsDirectory, 'function-compatibility-tests', 'tests');
      const report = produceFunctionCompatibilityReport({
        target,
        baselines: [descriptor],
        observation,
        evidence: evidence.body,
        source: evidence.evidenceSource,
        suitePolicy: suites,
      });
      const reportDirectory = join(output, 'compatibility-report');
      writeFunctionReportArtifact({
        directory: reportDirectory,
        report,
        target,
        codeSha,
        releaseId: `dummy-${githubRun}-proof`,
      });
      const proof = await archive(reportDirectory, 'function-release-payload');
      const args = {
        policy,
        coordinator,
        provider,
        observer: { observe },
        probe: async (_name, expected) => {
          const actual = await health();
          return {
            name,
            target,
            codeSha: actual.codeSha,
            status: actual.version === 'A' && actual.codeSha === expected ? 'healthy' : 'unhealthy',
          };
        },
        loadAccepted: async (run) => {
          if (run.runId !== accepted.runId) throw Error('Unexpected restore source');
          return baseline;
        },
        loadCompatibility: async (id) => {
          if (id !== proof.envelope.artifact.artifactId)
            throw Error('Unexpected compatibility source');
          return proof;
        },
        request: {
          names: [name],
          restoreRunId: accepted.runId,
          expectedActivationId: state.scope.active.activationId,
          compatibilityArtifactId: proof.envelope.artifact.artifactId,
          reason: 'Explicit isolated real-cloud restore to the archived working A',
        },
        executorSha: codeSha,
        runId: `dummy-${githubRun}-restore-A`,
        owner,
      };
      const prepared = await planManualFunctionRecovery(args);
      record.stage = 'restore-exact-archived-A';
      await save();
      const restored = await executeManualFunctionRecovery({
        ...args,
        token: prepared.review.token,
      });
      assert.equal(restored.status, 'accepted');
      record.stage = 'check-records-and-writes-after-recovery';
      await save();
      assert.deepEqual(await readFixtures(), rowsBefore);
      const current = (await invoke({ action: 'read', id: id('existing') })).record;
      const updated = await invoke({
        action: 'update',
        id: id('existing'),
        requestId: `${githubRun}:after-restore`,
        expectedRevision: current.revision,
        patch: { label: 'A still writes after recovery' },
      });
      assert.equal(updated.record.note, current.note);
      const replay = await invoke({
        action: 'update',
        id: id('existing'),
        requestId: `${githubRun}:after-restore`,
        expectedRevision: current.revision,
        patch: { label: 'A still writes after recovery' },
      });
      assert.equal(replay.record.revision, updated.record.revision);
      if (rowsBefore.some((r) => r.deleted))
        await assert.rejects(
          invoke({
            action: 'update',
            id: id('deleted-b'),
            requestId: `${githubRun}:must-not-revive`,
            expectedRevision: 2,
            patch: { label: 'wrong' },
          }),
        );
      record.acceptedRunId = args.runId;
      record.sourceArtifact = baseline.envelope.artifact;
      record.steps.push(
        'C2 restored exact archived A; real records unchanged by recovery; A writes preserve newer fields; retries do not duplicate writes; tombstones cannot be revived',
      );
    }
  }
  if (!['readback', 'cleanup'].includes(operation)) {
    record.stage = 'exercise-private-static-file';
    await save();
    record.websiteWrites = null;
    await save();
    record.static = await exerciseDummyStatic({
      provider: createCanaryProvider({ manager, policy }),
      coordinator,
      policy,
      artifactClient,
      owner,
      codeSha,
      githubRun,
      attempt: env.GITHUB_RUN_ATTEMPT,
      seedRun,
      operation,
      output,
      token: env.GITHUB_TOKEN,
    });
    record.websiteWrites = record.static.fileWrites;
  }
  record.rootPageWrites = 0;
  await checkBlogSiteBaseline(siteBefore);
  const productionAfter = await production.status({ scopeKey: 'site' });
  assert.equal(identity(productionAfter), identity(productionBefore));
  const final = await coordinator.status({ scopeKey: 'site' });
  assert.equal(final.state, 'idle');
  record.activationId = operation === 'cleanup' ? null : final.scope.active.activationId;
  record.status = 'passed';
  record.stage = 'complete';
  record.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      operation,
      status: record.status,
      acceptedRunId: record.acceptedRunId,
      activationId: record.activationId,
      websiteWrites: record.websiteWrites,
      rootPageWrites: 0,
      businessWrites: 0,
    }),
  );
} catch (error) {
  record.status = 'stopped';
  record.error = error?.code ?? 'DUMMY_UNCONFIRMED';
  if (/^[a-z-]{1,80}$/.test(error?.stage ?? '')) record.providerStage = error.stage;
  if (/^[A-Z][A-Z0-9_]{0,80}$/.test(error?.causeCode ?? ''))
    record.providerCauseCode = error.causeCode;
  if (['TimeoutError', 'AbortError'].includes(error?.errorClass))
    record.providerErrorClass = error.errorClass;
  if (error?.ledgerStage) record.ledgerStage = error.ledgerStage;
  if (/^[A-Za-z0-9_-]{1,128}$/.test(error?.requestId ?? ''))
    record.databaseRequestId = error.requestId;
  await save();
  throw Error(
    'Isolated recovery stopped; inspect its retained result and the named test resources before another write',
  );
}
