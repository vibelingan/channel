import { verifyReleaseArtifact } from './artifact.mjs';
import { evaluateCompatibility, functionRecoveryContext } from './function-compatibility.mjs';
import { freeze, identity, readObject, sha256 } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';

/** No SDK calls. The caller must authenticate platform metadata and read the B1 ledger before planning. */
export function planFunctionRecovery({
  baselineInput,
  compatibilityInput,
  acceptedRun,
  policy,
  observation,
  names,
  now = Date.now(),
}) {
  if (policy?.scope?.kind !== 'site')
    throw new Error('Function recovery requires explicit site policy');
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.length > 32 ||
    new Set(names).size !== names.length ||
    names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name))
  )
    throw new Error('Invalid requested function scope');
  const baseline = verifyReleaseArtifact({ ...baselineInput, policy, mode: 'recovery', now });
  const proof = verifyReleaseArtifact({ ...compatibilityInput, policy, mode: 'candidate', now });
  const reportBytes = readObject(
    compatibilityInput.directory,
    proof.envelope.compatibilityRef.path,
  );
  if (sha256(reportBytes) !== proof.envelope.compatibilityRef.sha256)
    throw new Error('Compatibility report changed after verification');
  const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reportBytes));
  if (
    report.schemaVersion !== 1 ||
    report.purpose !== 'function-recovery-compatibility' ||
    !Array.isArray(report.components) ||
    report.components.length > 32 ||
    new Set(report.components.map((x) => x.name)).size !== report.components.length
  )
    throw new Error('Invalid compatibility report artifact');
  const { targetId } = normalizePolicy({ repository: policy.repository, ...policy.target });
  if (
    acceptedRun?.state !== 'SUCCEEDED' ||
    acceptedRun.targetId !== targetId ||
    identity(acceptedRun.scope) !== identity(policy.scope) ||
    acceptedRun.compositionHash !== identity(acceptedRun.composition) ||
    acceptedRun.scopeKey !== 'site' ||
    acceptedRun.accepted?.sourceRunId !== acceptedRun.runId ||
    acceptedRun.accepted.compositionHash !== identity(acceptedRun.composition)
  )
    throw new Error('No accepted function ledger source');
  const functions = names.map((name) => {
    const descriptor = baseline.envelope.functions.find((f) => f.name === name);
    const key = `function:${name}`;
    if (!descriptor) throw new Error('Requested function absent from baseline artifact');
    const part = acceptedRun.composition[key];
    if (
      !part ||
      part.releaseId !== baseline.envelope.releaseId ||
      part.codeSha !== baseline.envelope.codeSha ||
      part.contentSha256 !== descriptor.sha256 ||
      identity(part.artifact) !== identity(baseline.envelope.artifact) ||
      identity(acceptedRun.accepted.seals[key]) !== identity(baselineInput.acceptedSeal)
    )
      throw new Error('Function was not accepted with these exact archived bytes');
    const candidate = { ...descriptor, codeSha: baseline.envelope.codeSha };
    const decision = evaluateCompatibility({
      target: policy.target,
      baseline: candidate,
      observation,
      now,
      report: report.components.find((f) => f.name === name),
    });
    if (decision.status !== 'allowed')
      throw Object.assign(new Error('Function recovery requires compatibility review'), {
        code: 'COMPATIBILITY_DENIED',
        reasons: decision.reasons,
      });
    const body = readObject(baselineInput.directory, candidate.packagePath);
    if (sha256(body) !== candidate.sha256)
      throw new Error('Function package changed after verification');
    const current = observation.functions.find((f) => f.name === name);
    return {
      baseline: candidate,
      bytes: body.length,
      contextSha256: decision.contextSha256,
      currentCodeSha: current.codeSha,
      configuration: decision.configuration,
    };
  });
  const body = {
    schemaVersion: 1,
    purpose: 'function-recovery-plan',
    target: structuredClone(policy.target),
    sourceRunId: acceptedRun.runId,
    sourceArtifact: baseline.envelope.artifact,
    compatibilityArtifact: proof.envelope.artifact,
    createdAt: now,
    expiresAt: Math.min(
      now + 300_000,
      Date.parse(baseline.envelope.artifact.expiresAt),
      Date.parse(proof.envelope.artifact.expiresAt),
    ),
    functions,
    execution: 'not-connected',
    configurationWrites: [],
    databaseWrites: [],
    functionDeletes: [],
  };
  return freeze({ ...body, planSha256: identity(body) });
}

/** Recheck immediately under the future execution lease; this is not authorization to call an SDK. */
export function assertFunctionRecoveryCurrent({ plan, observation, now = Date.now() }) {
  assertPlan(plan, now);
  for (const item of plan.functions) {
    const context = functionRecoveryContext({
      target: plan.target,
      baseline: item.baseline,
      observation,
      now,
    });
    if (context.sha256 !== item.contextSha256)
      throw new Error('Function recovery context changed after planning');
  }
}

export function readFunctionRecoveryPackage({ plan, name, directory, now = Date.now() }) {
  assertPlan(plan, now);
  const item = plan.functions.find((f) => f.baseline.name === name);
  if (!item) throw new Error('Unplanned recovery function');
  const bytes = readObject(directory, item.baseline.packagePath);
  if (bytes.length !== item.bytes || sha256(bytes) !== item.baseline.sha256)
    throw new Error('Function package changed after planning');
  return bytes;
}

function assertPlan(plan, now) {
  const { planSha256, ...body } = plan;
  if (
    body.schemaVersion !== 1 ||
    body.purpose !== 'function-recovery-plan' ||
    body.execution !== 'not-connected' ||
    !Number.isSafeInteger(now) ||
    now >= body.expiresAt ||
    identity(body) !== planSha256
  )
    throw new Error('Invalid or expired function recovery plan');
}
