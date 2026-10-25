import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { functionRecoveryFixture } from './release-function-fixtures.mjs';
import { verifyFunctionBaseline, writeFunctionBaseline } from './release/function-baseline.mjs';
import { planFunctionRecovery } from './release/function-recovery.mjs';
import { identity, sha256 } from './release/input.mjs';

function fixture(t) {
  const x = functionRecoveryFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'function-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'payload');
  const { codeSha: _, ...descriptor } = x.baseline;
  const bytes = readFileSync(join(x.baselineInput.directory, descriptor.packagePath));
  const body = writeFunctionBaseline({
    directory,
    target: x.target,
    codeSha: x.baseline.codeSha,
    releaseId: 'release-A',
    functions: [{ descriptor, bytes }],
    now: x.now,
  });
  const artifact = {
    ...x.baselineInput.envelope.artifact,
    manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
  };
  const input = {
    ...x.baselineInput,
    directory,
    envelope: { ...body, artifact },
    acceptedSeal: { ...x.baselineInput.acceptedSeal, artifact },
  };
  return { x, input };
}

test('a function archive proves its real packages without inventing a website or snapshot', (t) => {
  const { x, input } = fixture(t);
  const verified = verifyFunctionBaseline(input);
  assert.equal(verified.envelope.purpose, 'function-release-payload');
  assert.equal(verified.staticManifest, undefined);
  x.baselineInput = input;
  x.acceptedRun.composition['function:public-api'].artifact = input.envelope.artifact;
  x.acceptedRun.accepted.seals['function:public-api'] = input.acceptedSeal;
  x.acceptedRun.compositionHash = identity(x.acceptedRun.composition);
  x.acceptedRun.accepted.compositionHash = x.acceptedRun.compositionHash;
  assert.equal(planFunctionRecovery(x).functions[0].baseline.sha256, x.baseline.sha256);
});

test('a signed manifest cannot hide an unused package behind duplicate descriptor paths', (t) => {
  const { input } = fixture(t);
  const { artifact, ...body } = input.envelope;
  body.functions.push({ ...body.functions[0], name: 'another-dummy' });
  const bytes = Buffer.from('undeclared package');
  writeFileSync(join(input.directory, 'functions/unused.zip'), bytes);
  body.entries.push({ path: 'functions/unused.zip', bytes: bytes.length, sha256: sha256(bytes) });
  writeFileSync(join(input.directory, 'payload-manifest.json'), JSON.stringify(body));
  input.envelope = {
    ...body,
    artifact: {
      ...artifact,
      manifestSha256: sha256(readFileSync(join(input.directory, 'payload-manifest.json'))),
    },
  };
  input.acceptedSeal = { ...input.acceptedSeal, artifact: input.envelope.artifact };
  assert.throws(() => verifyFunctionBaseline(input));
});

for (const [name, change] of [
  [
    'corrupt package',
    (input) =>
      writeFileSync(join(input.directory, input.envelope.functions[0].packagePath), 'wrong'),
  ],
  [
    'wrong environment',
    (input) => {
      input.policy = { ...input.policy, target: { ...input.policy.target, envId: 'foreign' } };
    },
  ],
  [
    'wrong source',
    (input) => {
      input.run = { ...input.run, headSha: 'f'.repeat(40) };
    },
  ],
  [
    'unaccepted source',
    (input) => {
      input.acceptedSeal = null;
    },
  ],
  [
    'expired archive',
    (input) => {
      input.envelope.artifact.expiresAt = new Date(input.now - 1).toISOString();
    },
  ],
  [
    'manifest changed',
    (input) => writeFileSync(join(input.directory, 'payload-manifest.json'), '{}'),
  ],
])
  test(`function-only recovery refuses ${name}`, (t) => {
    const { input } = fixture(t);
    change(input);
    assert.throws(() => verifyFunctionBaseline(input));
  });
