import { identity } from './input.mjs';
import { tables } from './ledger.mjs';

/** The accepted website must remain current while its DB-only catalog registration is completed. */
export function assertCatalogRegistrationSource({
  status,
  run,
  input,
  guard = null,
  stoppedLease = false,
}) {
  if (
    run?.state !== 'SUCCEEDED' ||
    run.scopeKey !== 'site' ||
    run.targetId !== status.targetId ||
    run.accepted?.sourceRunId !== run.runId ||
    status.scope?.baseline?.sourceRunId !== run.runId ||
    status.scope.baseline.activationId !== run.accepted.activationId ||
    status.target?.currentRunId ||
    status.target?.dirtyRunId ||
    status.pendingStep ||
    status.target?.unresolvedOperation ||
    identity(run.composition?.static?.artifact) !== identity(input.envelope.artifact) ||
    identity(run.accepted.seals?.static) !== identity(input.acceptedSeal) ||
    (guard
      ? status.state !== 'leased' ||
        status.target.lease?.fence !== guard.fence ||
        status.target.lease.ownerRunId !== guard.ownerRunId
      : stoppedLease
        ? status.state !== 'stalled' || !status.target.lease
        : status.state !== 'idle' || status.target.lease !== null)
  )
    throw Error('Only the current accepted website may complete catalog registration');
}

/** An accepted run has no outstanding hosting work; only its stopped DB-only registrar may be released. */
export async function releaseStoppedCatalogRegistration({
  coordinator,
  run,
  input,
  jobProof,
  now = Date.now,
}) {
  const status = await coordinator.status({ scopeKey: 'site' });
  assertCatalogRegistrationSource({ status, run, input, stoppedLease: true });
  const lease = status.target.lease;
  const match = /^github:([a-z0-9_.-]+\/[a-z0-9_.-]+):([1-9][0-9]*):attempt-([1-9][0-9]*)$/.exec(
    lease.runnerRef,
  );
  if (
    !match ||
    match[1] !== input.envelope.artifact.repository ||
    ![
      ...(run.runId === `site-${match[2]}-${match[3]}` ? [run.runId] : []),
      `readback-${match[2]}-${match[3]}`,
    ].includes(lease.ownerRunId) ||
    jobProof?.status !== 'completed' ||
    jobProof.runnerRef !== lease.runnerRef ||
    typeof jobProof.evidenceRef !== 'string' ||
    !jobProof.evidenceRef
  )
    throw Error('Stopped catalog registration owner is not confirmed');
  return coordinator.reconcile({
    expectedVersion: status.target.version,
    expectedFence: lease.fence,
    proof: {
      runnerRef: lease.runnerRef,
      checkedAt: now(),
      job: { status: 'completed', evidenceRef: jobProof.evidenceRef },
      cloud: {
        status: 'quiescent',
        kind: 'accepted-catalog-registration',
        operationId: null,
        observedHash: null,
        evidenceRef: `accepted:${run.runId}:no-current-or-unresolved-hosting-operation`,
      },
    },
  });
}

/** No hosting adapter is accepted here: registration can change only the catalog records. */
export async function completeCatalogRegistration({
  coordinator,
  store,
  runId,
  input,
  owner,
  register,
  now = Date.now,
}) {
  const run = await coordinator.runStatus(runId);
  assertCatalogRegistrationSource({
    status: await coordinator.status({ scopeKey: 'site' }),
    run,
    input,
  });
  const guard = await coordinator.acquire(owner);
  let result;
  let failure;
  let failed = false;
  const checkpoint = async () => {
    await coordinator.renew(guard);
    assertCatalogRegistrationSource({
      status: await coordinator.status({ scopeKey: 'site' }),
      run,
      input,
      guard,
    });
  };
  const checkTransaction = async (tx) => {
    const target = await tx.get(tables.targets, guard.targetId);
    const scope = await tx.get(tables.scopes, `${guard.targetId}-site`);
    assertCatalogRegistrationSource({
      status: {
        targetId: guard.targetId,
        target,
        scope,
        state: target?.lease && now() < target.lease.expiresAt ? 'leased' : 'stalled',
        pendingStep: target?.unresolvedOperation ?? null,
      },
      run,
      input,
      guard,
    });
    if (
      target.lease.acquiredVersion !== guard.acquiredVersion ||
      target.lease.runnerRef !== owner.runnerRef
    )
      throw Error('Catalog registration lease changed before its write');
    return target;
  };
  const writeActive = async (data) => {
    if (
      typeof store?.transaction !== 'function' ||
      data?.acceptedRunId !== runId ||
      data.catalogTracked !== true
    )
      throw Error('Tracked catalog registration requires its guarded transaction');
    await checkpoint();
    await store.transaction(async (tx) => {
      const target = await checkTransaction(tx);
      await tx.get('catalogSeoBuilders', 'active');
      if (now() >= target.lease.expiresAt)
        throw Error('Catalog registration lease expired before its write');
      await tx.set('catalogSeoBuilders', { ...data, _id: 'active' });
    });
  };
  try {
    await checkpoint();
    result = await register({ run, checkpoint, checkTransaction, writeActive });
    await checkpoint();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await coordinator.release(guard);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
  return result;
}
