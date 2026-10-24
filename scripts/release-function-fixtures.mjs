import { join } from 'node:path';
import { digest, fixture } from './release-fixtures.mjs';
import { functionRecoveryContext } from './release/function-compatibility.mjs';
import { identity } from './release/input.mjs';
import { normalizePolicy } from './release/ledger.mjs';
const hash = (c) => c.repeat(64);
const code = (c) => c.repeat(40);
export function compatibilityFixture({
  name = 'public-api',
  formats = ['catalog-v1', 'catalog-v2'],
  apiContracts = ['catalog-ui-v1', 'catalog-ui-v2'],
} = {}) {
  const target = { envId: 'fixture-env', siteOrigin: 'https://fixture.example' };
  const baseline = {
    name,
    codeSha: code('a'),
    sha256: hash('a'),
    packagePath: `functions/${name}.zip`,
    runtime: 'Nodejs20.19',
    handler: 'index.main',
    role: 'fixture-role',
    layers: [],
    requiredConfigKeys: ['JWT_SECRET'],
  };
  const observation = {
    target: structuredClone(target),
    observedAt: 1792540800000,
    data: {
      revision: 'data-r2',
      formats: [...formats],
      constraintsSha256: hash('c'),
    },
    exposedClientContracts: [...apiContracts],
    functions: [
      {
        name,
        codeSha: code('b'),
        packageSha256: hash('b'),
        status: 'Active',
        availableStatus: 'Available',
        runtime: 'Nodejs20.19',
        handler: 'index.main',
        role: 'fixture-role',
        layers: [],
        configuration: {
          revision: 'config-r2',
          references: [{ name: 'JWT_SECRET', version: 'key-v2' }],
        },
      },
    ],
  };
  const report = {
    name,
    contextSha256: functionRecoveryContext({
      target,
      baseline,
      observation,
      now: observation.observedAt,
    }).sha256,
    readerFormats: [...formats],
    writerFormats: [...formats],
    apiContracts: [...apiContracts],
    preservesUnknownFields: true,
    checks: ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'].map((kind) => ({
      kind,
      status: 'passed',
      testRef: `scripts/compat.test.mjs:${kind}`,
    })),
  };
  return { target, baseline, observation, report, now: observation.observedAt };
}

// Synthetic archives and metadata; these are not evidence about production function compatibility.
export function functionRecoveryFixture(t, { changeReport, packageA, packageB, ...contract } = {}) {
  const x = compatibilityFixture(contract);
  const bodyA = packageA ?? 'archived-A-function-bytes';
  const bodyB = packageB ?? 'archived-B-function-bytes';
  x.baseline.sha256 = digest(bodyA);
  x.observation.functions[0].packageSha256 = digest(bodyB);
  x.report.contextSha256 = functionRecoveryContext(x).sha256;
  if (changeReport) changeReport(x.report);
  const build = (label, packageBody, compatibility) => {
    const codeSha = label.toLowerCase().repeat(40);
    const descriptor = { ...x.baseline, sha256: digest(packageBody) };
    descriptor.codeSha = undefined;
    const files = {
      'index.html': 'home',
      'snapshot.json': '{"products":[]}',
      'compatibility.json': JSON.stringify(compatibility),
      [descriptor.packagePath]: packageBody,
    };
    const entry = (path) => ({
      path,
      bytes: Buffer.byteLength(files[path]),
      sha256: digest(files[path]),
    });
    const configuration = { fixture: true };
    files['static-manifest.json'] = JSON.stringify({
      schemaVersion: 2,
      purpose: 'static-release',
      configuration,
      configurationSha256: digest(JSON.stringify(configuration)),
      entries: [entry('index.html')],
    });
    const payload = {
      schemaVersion: 2,
      purpose: 'release-payload',
      releaseId: `release-${label}`,
      codeSha,
      target: x.target,
      scope: { kind: 'site' },
      createdAt: new Date(x.now - 1000).toISOString(),
      staticManifestPath: 'static-manifest.json',
      snapshotPath: 'snapshot.json',
      functions: [descriptor],
      compatibilityRef: { path: 'compatibility.json', sha256: entry('compatibility.json').sha256 },
      entries: Object.keys(files).map(entry),
    };
    files['payload-manifest.json'] = JSON.stringify(payload);
    const f = fixture(t, files);
    const runId = label === 'A' ? '10' : '11';
    const artifactId = label === 'A' ? '20' : '21';
    const expiresAt = new Date(x.now + 86400000).toISOString();
    const artifact = {
      repository: 'fixture/channel',
      workflowPath: '.github/workflows/release.yml',
      runId,
      artifactId,
      manifestSha256: digest(files['payload-manifest.json']),
      expiresAt,
    };
    const envelope = { ...payload, artifact };
    const policy = {
      repository: artifact.repository,
      workflowPath: artifact.workflowPath,
      event: 'push',
      ref: 'refs/heads/test',
      target: x.target,
      scope: { kind: 'site' },
    };
    const run = {
      repository: artifact.repository,
      workflowPath: artifact.workflowPath,
      event: 'push',
      ref: policy.ref,
      headSha: codeSha,
      runId,
      artifact: { id: artifactId, runId, expired: false, expiresAt },
    };
    const acceptedSeal = {
      schemaVersion: 1,
      activationId: `activation-${label}`,
      releaseId: payload.releaseId,
      codeSha,
      artifact,
      target: x.target,
      scope: { kind: 'site' },
    };
    return { directory: f.directory, envelope, policy, run, acceptedSeal, now: x.now };
  };
  const baselineInput = build('A', bodyA, { schemaVersion: 1, purpose: 'baseline-contract' });
  const compatibilityInput = build('B', bodyB, {
    schemaVersion: 1,
    purpose: 'function-recovery-compatibility',
    components: [x.report],
  });
  const part = {
    releaseId: 'release-A',
    codeSha: baselineInput.envelope.codeSha,
    contentSha256: x.baseline.sha256,
    artifact: baselineInput.envelope.artifact,
  };
  const composition = { static: { ...part }, [`function:${x.baseline.name}`]: part };
  const acceptedRun = {
    state: 'SUCCEEDED',
    targetId: normalizePolicy({ repository: baselineInput.policy.repository, ...x.target })
      .targetId,
    scope: { kind: 'site' },
    compositionHash: identity(composition),
    scopeKey: 'site',
    runId: 'accepted-A',
    composition,
    accepted: {
      sourceRunId: 'accepted-A',
      compositionHash: identity(composition),
      seals: { [`function:${x.baseline.name}`]: baselineInput.acceptedSeal },
    },
  };
  return {
    ...x,
    baselineInput,
    compatibilityInput,
    acceptedRun,
    policy: baselineInput.policy,
    names: [x.baseline.name],
  };
}
