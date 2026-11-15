import { createRequire } from 'node:module';
import { fetchFully } from '../smoke-http.mjs';
import { verifyReleaseArtifact } from './artifact.mjs';
import { assertCatalogAcceptanceProof } from './catalog-proof.mjs';
import { assertStoppedCatalogReceipt } from './catalog-stopped-evidence.mjs';
import {
  assertHostingBatchMembers,
  hostingBatchBeforeHash,
  hostingBatchHash,
  mapHostingBounded,
} from './hosting-batches.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import { identity, isHash, readJson, readObject } from './input.mjs';
import { normalizePolicy } from './ledger.mjs';
import { assertJournaledSiteCandidate } from './site-recovery.mjs';
import { stoppedJobs, trustedWorkflow } from './site-stopped-reconcile.mjs';

const { require: tsxRequire } = createRequire(
  new URL('../../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { catalogRegionalReceiptId, catalogRegionalRequestHash } = tsxRequire(
  '../../packages/db/src/catalog-seo-regional.ts',
  import.meta.url,
);
const { CatalogSeoTaskSchema, catalogPublicRecordId } = tsxRequire(
  '../../packages/db/src/catalog-public-changes.ts',
  import.meta.url,
);
const { readCatalogSeoControl } = tsxRequire(
  '../../packages/db/src/catalog-seo-control.ts',
  import.meta.url,
);
const phases = ['leased', 'writing', 'needs-readback', 'control'];
const unproven = 'CATALOG_STOPPED_RECOVERY_UNPROVEN';
const changed = 'CATALOG_STOPPED_RECOVERY_CHANGED';
const uncertain = 'CATALOG_STOPPED_RECOVERY_NEEDS_READBACK';
const fail = (code = unproven) => {
  throw Object.assign(Error(code), { code });
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({
  status: 'not-required',
  stepIds: [],
  releasedTasks: 0,
  controlReleased: false,
  websiteWrites: 0,
  businessWrites: 0,
});

/** Clear only the catalog gate tied to a proved, stopped HTML write, before preparing a new run. */
export async function recoverStoppedCatalogDelivery({
  coordinator,
  regional,
  github,
  policy,
  readSteps,
  readReceipt,
  loadCandidate,
  loadEvidence,
  verifyQuiescence,
  readControl,
  readTasks,
  request = fetchFully,
  now = Date.now,
  onProgress = async (_progress) => {},
}) {
  let stage = 'starting';
  let attempted = false;
  try {
    const initial = await coordinator.status({ scopeKey: 'site' });
    const stoppedRunId = initial.target?.dirtyRunId;
    if (!stoppedRunId) return empty();
    const targetId = normalizePolicy(policy).targetId;
    const match = /^site-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(stoppedRunId);
    if (
      !match ||
      policy.repository !== 'vibelingan/channel' ||
      policy.workflowPath !== '.github/workflows/seo-static-canary.yml' ||
      !['refs/heads/feat/seo-foundation', 'refs/heads/test'].includes(policy.trustedRef) ||
      coordinator.targetId !== targetId
    )
      fail();
    assertNewOwner(initial, initial, targetId, stoppedRunId, now());
    const run = await coordinator.runStatus(stoppedRunId);
    if (
      run.state !== 'FAILED' ||
      run.accepted ||
      run.runId !== stoppedRunId ||
      run.targetId !== targetId ||
      run.scopeKey !== 'site' ||
      !['publish', 'reconcile'].includes(run.kind) ||
      run.ownerRunId !== stoppedRunId ||
      Object.keys(run.composition).join(',') !== 'static' ||
      run.deliveredComponents?.join(',') !== 'static'
    )
      fail();
    const immutable = identity(run);
    const check = async () => {
      assertNewOwner(
        await coordinator.status({ scopeKey: 'site' }),
        initial,
        targetId,
        stoppedRunId,
        now(),
      );
      if (identity(await coordinator.runStatus(stoppedRunId)) !== immutable) fail(changed);
    };
    const proof = run.reconciliation;
    if (proof?.cloud?.kind !== 'stopped-site-html-batch') {
      stage = 'known-failure-check';
      await assertKnownFailureIdle({
        readControl,
        readTasks,
        siteOrigin: policy.siteOrigin,
        stoppedRunId,
        now,
      });
      await check();
      return { ...empty(), status: 'not-required-known-failure', stoppedRunId };
    }
    if (
      proof.runnerRef !== `github:${policy.repository}:${match[1]}:attempt-${match[2]}` ||
      proof.job?.status !== 'completed' ||
      proof.cloud.status !== 'quiescent' ||
      !isHash(proof.cloud.observedHash)
    )
      fail();
    stage = 'github';
    const githubRun = await github.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
    if (
      String(githubRun.id) !== match[1] ||
      String(githubRun.run_attempt) !== match[2] ||
      !Number.isSafeInteger(githubRun.repository?.id) ||
      githubRun.repository.id < 1 ||
      githubRun.repository.id !== githubRun.head_repository?.id ||
      githubRun.repository.full_name !== policy.repository ||
      githubRun.head_repository.full_name !== policy.repository ||
      githubRun.path !== policy.workflowPath ||
      githubRun.head_branch !== policy.trustedRef.slice(11) ||
      githubRun.event !== 'workflow_dispatch' ||
      githubRun.status !== 'completed' ||
      !['success', 'failure', 'cancelled', 'timed_out'].includes(githubRun.conclusion) ||
      githubRun.head_sha !== run.composition.static.codeSha ||
      run.composition.static.artifact.runId !== match[1]
    )
      fail();
    const { job, stoppedAt } = await stoppedJobs(github, match[1], match[2], githubRun, now());
    await trustedWorkflow(github, githubRun.head_sha, policy);
    stage = 'step';
    const step = selectStep(await readSteps(stoppedRunId), run, targetId);
    stage = 'candidate';
    const input = await loadCandidate(run);
    assertJournaledSiteCandidate({ run, input, policy, dirtyRunId: stoppedRunId });
    const verified = verifyReleaseArtifact({ ...input, now: now() });
    if (
      verified.mode !== 'candidate' ||
      input.policy.repository !== policy.repository ||
      input.policy.ref !== policy.trustedRef ||
      input.policy.workflowPath !== policy.workflowPath ||
      verified.envelope.releaseId !== stoppedRunId ||
      verified.envelope.target.envId !== policy.envId ||
      verified.envelope.target.siteOrigin !== policy.siteOrigin ||
      verified.envelope.functions.length
    )
      fail();
    const entries = new Map(verified.staticManifest.entries.map((entry) => [entry.path, entry]));
    const products = step.members.map((member) => {
      const entry = entries.get(member.path);
      const product = /^products\/p-([A-Za-z0-9_-]{1,200})\/index\.html$/.exec(member.path);
      if (!product || !entry || entry.bytes !== member.bytes || entry.sha256 !== member.sha256)
        fail();
      return product[1];
    });
    if (new Set(products).size !== products.length) fail();
    const compatibility = readJson(input.directory, input.envelope.compatibilityRef.path);
    const originalWrites = assertCatalogAcceptanceProof(compatibility.catalog, {
      siteOrigin: policy.siteOrigin,
      snapshot: readObject(input.directory, input.envelope.snapshotPath),
    }).writes;
    const context = {
      runId: stoppedRunId,
      targetId,
      runnerRef: proof.runnerRef,
      codeSha: githubRun.head_sha,
      githubRunId: match[1],
      attempt: match[2],
      jobId: job.id,
      pendingOperationId: step.operationId,
      functionName: `seo-catalog-region-${match[1]}-${match[2]}`,
      stoppedAt,
      githubRun,
      job,
      artifactName: `site-delivery-evidence-${match[1]}-${match[2]}`,
      regionalPath: 'regional/result.json',
    };
    stage = 'receipts';
    const evidence = await loadEvidence(context);
    assertStoppedCatalogReceipt(evidence, context);
    const pair = await lookupPair({ evidence, run, products, originalWrites, policy, readReceipt });
    stage = 'quiescence';
    await quiet(verifyQuiescence, context, now);
    stage = 'http';
    await mapHostingBounded(step.members, 4, (entry) =>
      verifyHostingObject({
        target: { envId: policy.envId, site: policy.siteOrigin },
        entry,
        request,
      }),
    );
    await quiet(verifyQuiescence, context, now);
    await check();
    if (identity(selectStep(await readSteps(stoppedRunId), run, targetId)) !== identity(step))
      fail(changed);
    let cursor = { state: 'leased', cursor: null };
    let releasedTasks = 0;
    let controlReleased = false;
    const common = {
      stoppedRunId,
      stepId: step.stepId,
      beginRequestId: pair.beginRequestId,
      endRequestId: pair.endRequestId,
      originalWrites,
    };
    for (let round = 0; round < 50000; round++) {
      stage = 'clear';
      await check();
      await onProgress({
        status: 'clearing',
        ...common,
        round,
        ...cursor,
        releasedTasks,
        controlReleased,
        websiteWrites: 0,
        businessWrites: 0,
      });
      attempted = true;
      const result = await regional.recoverStoppedDeliveryStep({ ...common, ...cursor });
      if (
        !object(result) ||
        typeof result.done !== 'boolean' ||
        typeof result.controlReleased !== 'boolean' ||
        !Number.isSafeInteger(result.releasedTasks) ||
        result.releasedTasks < 0 ||
        result.releasedTasks > 2 ||
        (result.controlReleased && cursor.state !== 'control')
      )
        fail();
      await check();
      releasedTasks += result.releasedTasks;
      controlReleased ||= result.controlReleased;
      if (releasedTasks > 50000) fail();
      if (result.done) {
        if (cursor.state !== 'control' || result.next !== null) fail();
        const summary = {
          status: 'recovered',
          stoppedRunId,
          stepIds: [step.stepId],
          beginRequestId: pair.beginRequestId,
          endRequestId: pair.endRequestId,
          originalWrites,
          releasedTasks,
          controlReleased,
          websiteWrites: 0,
          businessWrites: 0,
        };
        await onProgress(summary);
        return summary;
      }
      const next = result.next;
      const before = phases.indexOf(cursor.state);
      const after = phases.indexOf(next?.state);
      if (
        !object(next) ||
        after < 0 ||
        (after !== before && after !== before + 1) ||
        (after === before &&
          (cursor.state === 'control' ||
            !isHash(next.cursor) ||
            (cursor.cursor !== null && next.cursor <= cursor.cursor))) ||
        (after !== before && next.cursor !== null)
      )
        fail();
      cursor = { state: next.state, cursor: next.cursor };
    }
    fail();
  } catch (cause) {
    const code = [unproven, changed, 'CATALOG_REGIONAL_UNCONFIRMED'].includes(cause?.code)
      ? cause.code
      : attempted
        ? uncertain
        : unproven;
    throw Object.assign(Error(code), {
      code,
      recoveryStage: stage,
      ...(typeof cause?.code === 'string' &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(cause.code) &&
      cause.code !== code
        ? { underlyingCode: cause.code }
        : {}),
    });
  }
}

function assertNewOwner(status, initial, targetId, stoppedRunId, now) {
  const lease = status.target?.lease;
  const original = initial.target?.lease;
  if (
    status.state !== 'leased' ||
    status.targetId !== targetId ||
    !lease ||
    !original ||
    lease.ownerRunId === stoppedRunId ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 1 ||
    !Number.isSafeInteger(lease.acquiredVersion) ||
    lease.acquiredVersion < 0 ||
    !Number.isSafeInteger(status.target.version) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isSafeInteger(now) ||
    now >= lease.expiresAt ||
    status.target.currentRunId !== null ||
    status.target.unresolvedOperation !== null ||
    status.pendingStep !== null ||
    status.target.dirtyRunId !== stoppedRunId ||
    ['ownerRunId', 'runnerRef', 'fence', 'acquiredVersion'].some(
      (key) => lease[key] !== original[key],
    ) ||
    status.target.version < initial.target.version ||
    identity(status.scope) !== identity(initial.scope)
  )
    fail(changed);
}
function selectStep(rows, run, targetId) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length >= 1000 ||
    rows.some((row) => row.runId !== run.runId || row.targetId !== targetId || row.kind !== 'write')
  )
    fail();
  const matches = rows.filter(
    (row) => row.state === 'reconciled' && row.operationId === run.reconciliation.cloud.operationId,
  );
  if (matches.length !== 1) fail();
  const step = matches[0];
  assertHostingBatchMembers(step.members);
  const hash = hostingBatchHash(step.members);
  if (
    step._id !== identity({ targetId, runId: run.runId, stepId: step.stepId }) ||
    step.component !== 'static' ||
    step.fence !== (run.writeFence ?? run.fence) ||
    step.removals ||
    step.sequence !== run.verifiedSteps ||
    !isHash(step.intentHash) ||
    step.planSha256 !== run.plan.planSha256 ||
    step.afterHash !== hash ||
    step.beforeHash !== hostingBatchBeforeHash(step.members) ||
    step.subject !== `upload-batch:${hash}` ||
    step.verifySubject !== `read-batch:${hash}` ||
    run.reconciliation.cloud.observedHash !== hash ||
    identity(step.resolution) !== identity(run.reconciliation)
  )
    fail();
  return step;
}
async function quiet(verify, context, now) {
  const answer = await verify(context);
  if (
    !answer ||
    ['runId', 'targetId', 'runnerRef', 'codeSha', 'pendingOperationId', 'functionName'].some(
      (key) => answer[key] !== context[key],
    ) ||
    answer.functionsAbsent !== true ||
    answer.oldJobCompleted !== true ||
    !Number.isSafeInteger(answer.checkedAt) ||
    answer.checkedAt < context.stoppedAt ||
    answer.checkedAt > now() ||
    now() - answer.checkedAt > 60000
  )
    fail();
}
async function lookupPair({ evidence, run, products, originalWrites, policy, readReceipt }) {
  const calls = evidence.calls.filter((call) =>
    ['delivery.begin', 'delivery.end'].includes(call.action),
  );
  if (
    !calls.length ||
    calls.length > 1000 ||
    new Set(calls.map((call) => call.requestId)).size !== calls.length
  )
    fail();
  const rows = await mapHostingBounded(calls, 4, async (call) => {
    const key = catalogRegionalReceiptId(run.runId, call.requestId);
    const row = await readReceipt(key);
    if (
      row?._id !== key ||
      row.schemaVersion !== 1 ||
      row.purpose !== 'catalog-seo-regional-receipt' ||
      row.runId !== run.runId ||
      row.requestId !== call.requestId ||
      row.action !== call.action ||
      !isHash(row.inputHash) ||
      !object(row.result) ||
      !Number.isFinite(Date.parse(row.completedAt))
    )
      fail();
    return { call, row };
  });
  const hash = (action, requestId, input) =>
    catalogRegionalRequestHash({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      runId: run.runId,
      targetId: run.targetId,
      siteOrigin: policy.siteOrigin,
      executorCodeSha: run.composition.static.codeSha,
      requestId,
      guard: {
        targetId: run.targetId,
        ownerRunId: run.ownerRunId,
        fence: run.fence,
        acquiredVersion: run.acquiredVersion,
      },
      action,
      input,
    });
  const pairs = [];
  for (const { call, row } of rows.filter((item) => item.call.action === 'delivery.begin')) {
    const ticket = row.result.ticket;
    if (
      !object(ticket) ||
      !ticket.owner?.startsWith(`${run.runId}:`) ||
      !Number.isSafeInteger(ticket.fence) ||
      ticket.fence < 1 ||
      !Array.isArray(ticket.products) ||
      new Set(ticket.products).size !== ticket.products.length ||
      identity([...ticket.products].sort()) !== identity([...products].sort())
    )
      continue;
    if (
      row.inputHash !==
      hash('delivery.begin', call.requestId, {
        expectedWrites: originalWrites,
        products: ticket.products,
        discovery: false,
      })
    )
      continue;
    const ended = rows.filter(
      (item) =>
        item.call.action === 'delivery.end' &&
        item.row.result.ended === true &&
        item.row.inputHash ===
          hash('delivery.end', item.call.requestId, {
            expectedWrites: originalWrites,
            ticket,
            outcome: 'unknown',
          }),
    );
    for (const end of ended)
      pairs.push({ beginRequestId: call.requestId, endRequestId: end.call.requestId });
  }
  if (pairs.length !== 1) fail();
  return pairs[0];
}
async function assertKnownFailureIdle({ readControl, readTasks, siteOrigin, stoppedRunId, now }) {
  if (typeof readControl !== 'function' || typeof readTasks !== 'function') fail();
  const rawBefore = await readControl();
  if (!rawBefore) fail();
  const before = readCatalogSeoControl(rawBefore, siteOrigin, new Date(now()).toISOString());
  if (before.state !== 'idle') fail();
  let scanned = 0;
  for (const state of phases.slice(0, 3)) {
    let cursor = null;
    for (;;) {
      const rows = await readTasks(state, cursor, 100);
      if (!Array.isArray(rows) || rows.length > 100) fail();
      for (const row of rows) {
        const task = CatalogSeoTaskSchema.parse(row);
        if (
          task._id !== catalogPublicRecordId(siteOrigin, task.productId) ||
          task.siteOrigin !== siteOrigin ||
          task.state !== state ||
          task._id <= (cursor ?? '') ||
          task.lease?.runId === stoppedRunId
        )
          fail();
        cursor = task._id;
      }
      scanned += rows.length;
      if (scanned > 50000) fail();
      if (rows.length < 100) break;
    }
  }
  const after = await readControl();
  if (
    !after ||
    identity(readCatalogSeoControl(after, siteOrigin, new Date(now()).toISOString())) !==
      identity(before)
  )
    fail(changed);
}
