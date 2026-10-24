import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeze, identity, readJson, readObject, sha256 } from './input.mjs';

/** A report archive contains data only; it does not pretend to be a deployable website. */
export function writeFunctionReportArtifact({
  directory,
  report,
  target,
  codeSha,
  releaseId,
  now = Date.now(),
}) {
  if (
    report?.purpose !== 'function-recovery-compatibility' ||
    !/^[a-f0-9]{40}$/.test(codeSha) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(releaseId)
  )
    throw new Error('Invalid function report identity');
  const bytes = Buffer.from(JSON.stringify(report));
  const payload = {
    schemaVersion: 1,
    purpose: 'function-compatibility-payload',
    releaseId,
    codeSha,
    target,
    scope: { kind: 'site' },
    createdAt: new Date(now).toISOString(),
    compatibilityRef: { path: 'compatibility.json', sha256: sha256(bytes) },
  };
  mkdirSync(directory, { recursive: false });
  writeFileSync(join(directory, 'compatibility.json'), bytes, { flag: 'wx' });
  writeFileSync(join(directory, 'payload-manifest.json'), JSON.stringify(payload), { flag: 'wx' });
  return payload;
}

export function verifyFunctionReportArtifact(
  { envelope, directory, run },
  policy,
  now = Date.now(),
) {
  const payload = readJson(directory, 'payload-manifest.json');
  const ref = envelope?.artifact;
  const { artifact, ...body } = envelope ?? {};
  if (
    payload.schemaVersion !== 1 ||
    payload.purpose !== 'function-compatibility-payload' ||
    identity(body) !== identity(payload) ||
    identity(payload.target) !== identity(policy.target) ||
    identity(payload.scope) !== identity({ kind: 'site' }) ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(payload.releaseId) ||
    !/^[a-f0-9]{40}$/.test(payload.codeSha) ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    Date.parse(payload.createdAt) > now + 300000 ||
    ref?.repository !== policy.repository ||
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
    run.artifact.expiresAt !== ref.expiresAt ||
    payload.compatibilityRef?.path !== 'compatibility.json' ||
    payload.compatibilityRef.sha256 !== sha256(readObject(directory, 'compatibility.json'))
  )
    throw new Error('Untrusted function compatibility report artifact');
  return freeze({ envelope: structuredClone(envelope) });
}
