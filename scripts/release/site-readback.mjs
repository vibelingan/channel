import { assertAcceptedHostingFiles } from '../hosting-delta.mjs';
import { inventoryIdentity, recoveryStateIdentity } from '../hosting-recovery.mjs';
import {
  assertHostingBatchMembers,
  assertHostingRemovals,
  hostingBatchHash,
  hostingRemovalHash,
  mapHostingBounded,
} from './hosting-batches.mjs';
import {
  assertSafeConfiguration,
  configurationStateHash,
  errorDocumentPath,
} from './hosting-configuration.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import { identity } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
/** Reconstruct the already-confirmed writes. This is evidence of ownership, not permission to write again. */
export function siteReadbackEvidence({ run, input, steps, policy }) {
  if (
    run?.state !== 'RUNNING' ||
    run.accepted ||
    run.kind !== 'publish' ||
    run.scopeKey !== 'site' ||
    run.targetId !== normalizePolicy(policy).targetId ||
    run.deliveredComponents?.join(',') !== 'static' ||
    run.verifiedSteps !== run.plan.stepCount - 1 ||
    run.verifiedWrites !== run.verifiedSteps ||
    !steps.length ||
    steps.length !== run.verifiedWrites ||
    steps.length > 1000 ||
    identity(run.composition.static.artifact) !== identity(input.envelope.artifact) ||
    run.composition.static.releaseId !== input.envelope.releaseId ||
    run.composition.static.codeSha !== input.envelope.codeSha
  )
    throw Error('Exact completed writes and their original candidate are required');
  const entries = new Map(input.staticManifest.entries.map((e) => [e.path, e]));
  const paths = new Set();
  const removals = new Set();
  for (const [index, step] of [...steps].sort((a, b) => a.sequence - b.sequence).entries()) {
    if (
      step.sequence !== index ||
      step.runId !== run.runId ||
      step.targetId !== run.targetId ||
      step.fence !== (run.writeFence ?? run.fence) ||
      step.kind !== 'write' ||
      step.component !== 'static' ||
      step.state !== 'verified' ||
      step.planSha256 !== run.plan.planSha256 ||
      step.receipt?.status !== 'verified' ||
      step.receipt.executionId !== step.executionId ||
      step.receipt.planSha256 !== step.planSha256 ||
      step.receipt.subject !== step.verifySubject ||
      step.receipt.observedHash !== step.afterHash ||
      step.receipt.expectedHash !== step.afterHash ||
      step.receipt.intentHash !== step.intentHash ||
      step.receipt.operationId !== step.operationId ||
      step.receipt.terminal !== true
    )
      throw Error('Unconfirmed original hosting write');
    if (step.members) {
      assertHostingBatchMembers(step.members);
      const hash = hostingBatchHash(step.members);
      if (
        step.removals ||
        hash !== step.afterHash ||
        step.subject !== `upload-batch:${hash}` ||
        step.verifySubject !== `read-batch:${hash}`
      )
        throw Error('Unknown upload batch proof');
      for (const member of step.members) {
        const e = entries.get(member.path);
        if (!e || e.sha256 !== member.sha256 || e.bytes !== member.bytes || paths.has(member.path))
          throw Error('Written file differs from original candidate');
        paths.add(member.path);
      }
    } else if (step.removals) {
      assertHostingRemovals(step.removals);
      const hash = hostingRemovalHash(step.removals.map((x) => x.path));
      if (
        step.afterHash !== hash ||
        step.subject !== `remove-batch:${hash}` ||
        step.verifySubject !== step.subject
      )
        throw Error('Unknown removal batch proof');
      for (const e of step.removals) {
        if (entries.has(e.path) || removals.has(e.path)) throw Error('Unexpected removal proof');
        removals.add(e.path);
      }
    } else throw Error('Only already verified file batches can continue final readback');
  }
  const target = { envId: policy.envId, site: policy.siteOrigin };
  const hash = recoveryStateIdentity({
    target,
    scope: { kind: 'site' },
    uploads: input.staticManifest.entries,
    deletes: [...removals],
    configurationSha256: input.staticManifest.configurationSha256,
  });
  if (hash !== run.plan.acceptanceHash || hash !== run.composition.static.contentSha256)
    throw Error('Original candidate acceptance identity differs');
  return {
    target,
    hash,
    uploads: [...paths].map((p) => entries.get(p)),
    removed: [...removals],
    errorDocument: entries.get(errorDocumentPath),
  };
}
/** Pure cloud read port. No upload, deletion, configuration or deployment callback is accepted. */
export async function verifySiteReadback({
  run,
  input,
  steps,
  policy,
  provider,
  request,
  postCheck = async () => {},
  signal,
}) {
  const evidence = siteReadbackEvidence({ run, input, steps, policy });
  assertSafeConfiguration(input.staticManifest.configuration, evidence.target);
  const inventory = await provider.readInventory();
  const configuration = await provider.readConfiguration();
  if (
    configurationStateHash(configuration) !==
    configurationStateHash(input.staticManifest.configuration)
  )
    throw Error('Hosting configuration changed outside this candidate');
  assertAcceptedHostingFiles({ source: input, inventory });
  const actual = new Set(inventory.map((e) => e.path));
  const owned = new Set(input.staticManifest.entries.map((e) => e.path));
  if (evidence.removed.some((path) => actual.has(path))) throw Error('A removed file reappeared');
  if (evidence.removed.length && !evidence.errorDocument)
    throw Error('Pinned error document required');
  await mapHostingBounded(evidence.uploads, 4, (entry) =>
    verifyHostingObject({
      target: evidence.target,
      entry,
      ...(request ? { request } : {}),
      signal,
    }),
  );
  await mapHostingBounded(evidence.removed, 4, (path) =>
    verifyHostingObject({
      target: evidence.target,
      entry: evidence.errorDocument,
      path,
      expectedStatus: 404,
      ...(request ? { request } : {}),
      signal,
    }),
  );
  await postCheck();
  const after = await provider.readInventory();
  if (
    identity(inventoryIdentity(after)) !== identity(inventoryIdentity(inventory)) ||
    configurationStateHash(await provider.readConfiguration()) !==
      configurationStateHash(configuration)
  )
    throw Error('Hosting changed during read-only acceptance');
  assertAcceptedHostingFiles({ source: input, inventory: after });
  return {
    observedHash: evidence.hash,
    verifiedUrls: evidence.uploads.length + evidence.removed.length,
    retainedObjects: input.staticManifest.entries.length - evidence.uploads.length,
    websiteWrites: 0,
    // The publisher owns candidate paths and its explicit removals, not every key in the bucket.
    preservedOutsideCandidate: inventory.filter((e) => !owned.has(e.path)).map((e) => e.path),
  };
}
