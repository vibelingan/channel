import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compatibilityFixture } from './release-function-fixtures.mjs';
import { functionZip } from './release-function-manager-fixture.mjs';
import {
  verifyFunctionReportArtifact,
  writeFunctionReportArtifact,
} from './release/function-report-artifact.mjs';
import { produceFunctionCompatibilityReport } from './release/function-report.mjs';
import { runFunctionCompatibilityTests } from './release/function-test-runner.mjs';
import { sha256 } from './release/input.mjs';
const source = {
  verified: true,
  event: 'workflow_dispatch',
  manifestSha256: 'a'.repeat(64),
  headSha: 'b'.repeat(40),
  artifactId: '22',
};
function setup() {
  const x = compatibilityFixture();
  const evidence = {
    schemaVersion: 1,
    purpose: 'function-compatibility-test-results',
    status: 'passed',
    components: [
      {
        ...x.report,
        suites: x.report.checks.map((check) => ({
          ...check,
          suiteSha256: 'a'.repeat(64),
          tests: [{ name: 'actual-contract', status: 'passed', count: 1 }],
        })),
      },
    ],
  };
  const suitePolicy = evidence.components[0].suites.map((s) => ({
    name: 'public-api',
    kind: s.kind,
    testRef: s.testRef,
    suiteSha256: s.suiteSha256,
    requiredTests: ['actual-contract'],
    covers: s.kind === 'api-clients' ? x.report.apiContracts : x.report.readerFormats,
  }));
  return { ...x, evidence, source, suitePolicy, baselines: [x.baseline] };
}
test('production report derives checks only from complete successful, context-bound CI test evidence', () => {
  const x = setup();
  const report = produceFunctionCompatibilityReport(x);
  assert.deepEqual(report.components[0], x.report);
  assert.equal(report.purpose, 'function-recovery-compatibility');
});
for (const [name, change] of [
  [
    'untrusted source',
    (x) => {
      x.source = { ...source, verified: false };
    },
  ],
  [
    'missing check',
    (x) => {
      x.evidence.components[0].suites.pop();
    },
  ],
  [
    'skipped test',
    (x) => {
      x.evidence.components[0].suites[0].tests[0].status = 'skipped';
    },
  ],
  [
    'empty suite',
    (x) => {
      x.evidence.components[0].suites[0].tests = [];
    },
  ],
  [
    'different data',
    (x) => {
      x.observation.data.revision = 'r-new';
    },
  ],
  [
    'unknown field loss',
    (x) => {
      x.evidence.components[0].preservesUnknownFields = false;
    },
  ],
  [
    'new client unsupported',
    (x) => {
      x.evidence.components[0].apiContracts.pop();
    },
  ],
  [
    'manual evidence',
    (x) => {
      x.evidence.status = 'manual-required';
    },
  ],
])
  test(`report refuses ${name}`, () => {
    const x = setup();
    change(x);
    assert.throws(() => produceFunctionCompatibilityReport(x));
  });
test('report artifact has no fake homepage and authenticates exact stored JSON bytes and source', (t) => {
  const x = setup();
  const root = mkdtempSync(join(tmpdir(), 'report-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'payload');
  const body = writeFunctionReportArtifact({
    directory,
    report: produceFunctionCompatibilityReport(x),
    target: x.target,
    codeSha: source.headSha,
    releaseId: 'proof',
    now: x.now,
  });
  const artifact = {
    repository: 'fixture/channel',
    workflowPath: '.github/workflows/recovery.yml',
    runId: '11',
    artifactId: '22',
    expiresAt: new Date(x.now + 10000).toISOString(),
    manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
  };
  const run = {
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    event: 'workflow_dispatch',
    ref: 'refs/heads/seo',
    headSha: source.headSha,
    runId: '11',
    artifact: { id: '22', runId: '11', expired: false, expiresAt: artifact.expiresAt },
  };
  const input = { directory, envelope: { ...body, artifact }, run };
  const policy = {
    repository: artifact.repository,
    workflowPath: artifact.workflowPath,
    event: run.event,
    ref: run.ref,
    target: x.target,
  };
  verifyFunctionReportArtifact(input, policy, x.now);
  assert.equal(body.staticManifestPath, undefined);
  writeFileSync(join(directory, 'compatibility.json'), '{}');
  assert.throws(() => verifyFunctionReportArtifact(input, policy, x.now));
});
test('reviewed test runner executes pinned checkout tests with context and no cloud secrets', (t) => {
  const x = setup();
  const root = mkdtempSync(join(tmpdir(), 'compat-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/compatibility'), { recursive: true });
  mkdirSync(join(root, 'functions'));
  const zip = functionZip();
  writeFileSync(join(root, x.baseline.packagePath), zip);
  x.baseline.sha256 = sha256(zip);
  const content =
    "import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';test('actual bound fixture',()=>{const c=JSON.parse(readFileSync(process.env.RELEASE_COMPATIBILITY_CONTEXT));assert.equal(c.context.name,'public-api');assert.equal(process.env.TENCENTCLOUD_SECRETKEY,undefined);assert(readFileSync(c.baselinePackagePath).length>0);});";
  const specs = ['reader', 'writer-preserves-unknown', 'api-clients', 'configuration'].map(
    (kind) => ({
      name: 'public-api',
      kind,
      testRef: `scripts/compatibility/${kind}.test.mjs`,
      suiteSha256: sha256(content),
      requiredTests: ['actual bound fixture'],
      covers:
        kind === 'api-clients' ? x.observation.exposedClientContracts : x.observation.data.formats,
    }),
  );
  for (const spec of specs) writeFileSync(join(root, spec.testRef), content);
  const evidence = runFunctionCompatibilityTests({
    root,
    directory: root,
    baselines: [x.baseline],
    observation: x.observation,
    policy: { compatibilitySuites: specs },
    now: x.now,
  });
  assert.equal(evidence.status, 'passed');
  const report = produceFunctionCompatibilityReport({ ...x, evidence, suitePolicy: specs });
  assert.equal(report.components.length, 1);
  const unsupported = runFunctionCompatibilityTests({
    root,
    directory: root,
    baselines: [x.baseline],
    observation: x.observation,
    policy: { compatibilitySuites: [] },
    now: x.now,
  });
  assert.equal(unsupported.status, 'manual-required');
  writeFileSync(join(root, specs[0].testRef), `${content}\n`);
  assert.throws(
    () =>
      runFunctionCompatibilityTests({
        root,
        directory: root,
        baselines: [x.baseline],
        observation: x.observation,
        policy: { compatibilitySuites: specs },
        now: x.now,
      }),
    /pinned/,
  );
});

for (const [label, content] of [
  ['skipped', "import test from 'node:test';test('required case',{skip:true},()=>{});"],
  ['empty', ''],
])
  test(`runner refuses ${label} tests even when the source is pinned`, (t) => {
    const x = setup();
    const root = mkdtempSync(join(tmpdir(), 'compat-negative-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts/compatibility'), { recursive: true });
    mkdirSync(join(root, 'functions'));
    const zip = functionZip();
    writeFileSync(join(root, x.baseline.packagePath), zip);
    x.baseline.sha256 = sha256(zip);
    const compatibilitySuites = [
      'reader',
      'writer-preserves-unknown',
      'api-clients',
      'configuration',
    ].map((kind) => ({
      name: 'public-api',
      kind,
      testRef: `scripts/compatibility/${kind}.test.mjs`,
      suiteSha256: sha256(content),
      requiredTests: ['required case'],
      covers: x.observation.data.formats,
    }));
    for (const spec of compatibilitySuites) writeFileSync(join(root, spec.testRef), content);
    assert.throws(() =>
      runFunctionCompatibilityTests({
        root,
        directory: root,
        baselines: [x.baseline],
        observation: x.observation,
        policy: { compatibilitySuites },
        now: x.now,
      }),
    );
  });
