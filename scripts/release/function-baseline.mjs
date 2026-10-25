import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyReleaseArtifact } from './artifact.mjs';
import {
  assertHostingPath,
  checkEntries,
  freeze,
  identity,
  readJson,
  readObject,
  sha256,
} from './input.mjs';

/** Archive only actual function packages. Static files and database snapshots have separate owners. */
export function writeFunctionBaseline({
  directory,
  target,
  codeSha,
  releaseId,
  functions,
  now = Date.now(),
}) {
  if (!Array.isArray(functions) || !functions.length || functions.length > 32)
    throw Error('Explicit function packages required');
  const files = new Map();
  for (const { descriptor, bytes } of functions) {
    assertHostingPath(descriptor.packagePath);
    if (
      !descriptor.packagePath.startsWith('functions/') ||
      files.has(descriptor.packagePath) ||
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      sha256(bytes) !== descriptor.sha256
    )
      throw Error('Function package identity mismatch');
    files.set(descriptor.packagePath, bytes);
  }
  const body = {
    schemaVersion: 1,
    purpose: 'function-release-payload',
    releaseId,
    codeSha,
    target,
    scope: { kind: 'site' },
    createdAt: new Date(now).toISOString(),
    functions: functions.map(({ descriptor }) => structuredClone(descriptor)),
    entries: [...files].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  mkdirSync(directory, { recursive: false });
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes, { flag: 'wx', mode: 0o600 });
  }
  writeFileSync(join(directory, 'payload-manifest.json'), JSON.stringify(body), { flag: 'wx' });
  return body;
}

/** Legacy combined archives retain all their original checks. */
export function verifyFunctionBaseline(input) {
  if (input.envelope?.purpose !== 'function-release-payload') return verifyReleaseArtifact(input);
  const {
    directory,
    envelope,
    policy,
    run,
    acceptedSeal,
    mode = 'recovery',
    now = Date.now(),
  } = input;
  const { artifact: ref, ...body } = envelope;
  const payload = readJson(directory, 'payload-manifest.json');
  if (
    !['candidate', 'recovery'].includes(mode) ||
    !Number.isFinite(now) ||
    payload.schemaVersion !== 1 ||
    identity(payload) !== identity(body) ||
    Object.keys(payload).sort().join(',') !==
      [
        'schemaVersion',
        'purpose',
        'releaseId',
        'codeSha',
        'target',
        'scope',
        'createdAt',
        'functions',
        'entries',
      ]
        .sort()
        .join(',') ||
    identity(payload.target) !== identity(policy.target) ||
    identity(payload.scope) !== identity({ kind: 'site' }) ||
    identity(policy.scope) !== identity(payload.scope) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(payload.releaseId) ||
    !/^[a-f0-9]{40}$/.test(payload.codeSha) ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    Date.parse(payload.createdAt) > now + 300000 ||
    !ref ||
    ref.repository !== policy.repository ||
    ref.workflowPath !== policy.workflowPath ||
    !/^[1-9][0-9]*$/.test(ref.runId) ||
    !/^[1-9][0-9]*$/.test(ref.artifactId) ||
    !(Date.parse(ref.expiresAt) > now) ||
    ref.manifestSha256 !== sha256(readObject(directory, 'payload-manifest.json')) ||
    run?.repository !== ref.repository ||
    run.workflowPath !== ref.workflowPath ||
    run.event !== policy.event ||
    run.ref !== policy.ref ||
    run.headSha !== payload.codeSha ||
    run.runId !== ref.runId ||
    run.artifact?.id !== ref.artifactId ||
    run.artifact.runId !== ref.runId ||
    run.artifact.expired !== false ||
    run.artifact.expiresAt !== ref.expiresAt
  )
    throw Error('Untrusted function baseline archive');
  if (
    mode === 'recovery' &&
    (acceptedSeal?.schemaVersion !== 1 ||
      !acceptedSeal.activationId?.trim() ||
      acceptedSeal.releaseId !== payload.releaseId ||
      acceptedSeal.codeSha !== payload.codeSha ||
      identity(acceptedSeal.artifact) !== identity(ref) ||
      identity(acceptedSeal.target) !== identity(payload.target) ||
      identity(acceptedSeal.scope) !== identity(payload.scope))
  )
    throw Error('Matching accepted function seal required');
  checkEntries(payload.entries);
  const entries = new Map(payload.entries.map((entry) => [entry.path, entry]));
  if (
    !Array.isArray(payload.functions) ||
    !payload.functions.length ||
    payload.functions.length > 32 ||
    entries.size !== payload.functions.length ||
    new Set(payload.functions.map((f) => f.name)).size !== payload.functions.length ||
    new Set(payload.functions.map((f) => f.packagePath)).size !== payload.functions.length
  )
    throw Error('Explicit unique function inventory required');
  for (const descriptor of payload.functions) {
    const entry = entries.get(descriptor.packagePath);
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(descriptor.name) ||
      !descriptor.packagePath.startsWith('functions/') ||
      !entry ||
      descriptor.sha256 !== entry.sha256
    )
      throw Error('Undeclared function package');
    const bytes = readObject(directory, entry.path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw Error('Corrupt function package');
  }
  return freeze({ envelope: structuredClone(envelope), payload, mode });
}
