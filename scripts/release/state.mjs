import { randomUUID } from 'node:crypto';
import { freeze, identity, isHash } from './input.mjs';
import {
  assertScope,
  assertTarget,
  bump,
  fail,
  id,
  integer,
  jsonCopy,
  normalizePolicy,
  text,
  validateComposition,
} from './ledger.mjs';

/** Server control plane only. All callbacks below contain database operations, never cloud effects. */
export function createReleaseCoordinator({ store, policy, clock = Date.now, leaseMs = 180_000 }) {
  const config = freeze(normalizePolicy(jsonCopy(policy)));
  if (store.envId !== config.target.envId || typeof store.transact !== 'function')
    fail('STORE_ENV_MISMATCH');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000)
    fail('INVALID_LEASE_DURATION');
  const now = () => integer(clock());
  const targetId = config.targetId;
  const scopeId = (key) => {
    if (!Object.hasOwn(config.scopes, key)) fail('INVALID_SCOPE');
    return `${targetId}-${key}`;
  };
  const runId = (key) => identity({ targetId, runId: id(key) });
  const stepId = (run, step) => identity({ targetId, runId: id(run), stepId: id(step) });
  const loadTarget = async (tx, required = true) => {
    const target = await tx.get('targets', targetId);
    if (target === null) {
      if (required) fail('TARGET_UNINITIALIZED');
      return null;
    }
    assertTarget(target, config);
    return target;
  };
  const loadScope = async (tx, key) => {
    const value = await tx.get('scopes', scopeId(key));
    if (value !== null) assertScope(value, config, key);
    return (
      value ?? {
        schemaVersion: 1,
        targetId,
        scopeKey: key,
        scope: config.scopes[key],
        version: 0,
        active: null,
        baseline: null,
      }
    );
  };
  const assertGuard = (target, guard) => {
    if (
      guard?.targetId !== targetId ||
      guard.ownerRunId !== target.lease?.ownerRunId ||
      guard.fence !== target.lease?.fence ||
      guard.acquiredVersion !== target.lease?.acquiredVersion ||
      now() >= target.lease.expiresAt
    )
      fail('LEASE_LOST');
  };
  const guardTarget = async (tx, guard) => {
    const target = await loadTarget(tx);
    assertGuard(target, guard);
    return target;
  };
  const loadRun = async (tx, key, guard) => {
    const run = await tx.get('runs', runId(key));
    if (
      run?.schemaVersion !== 1 ||
      run.targetId !== targetId ||
      run.runId !== key ||
      !Object.hasOwn(config.scopes, run.scopeKey)
    )
      fail('RUN_NOT_FOUND');
    integer(run.version);
    integer(run.verifiedSteps);
    integer(run.verifiedWrites);
    if (
      guard &&
      (guard.targetId !== targetId ||
        run.ownerRunId !== guard.ownerRunId ||
        run.fence !== guard.fence ||
        run.acquiredVersion !== guard.acquiredVersion)
    )
      fail('LEASE_LOST');
    return run;
  };
  const running = (target, run) => {
    if (run.state !== 'RUNNING' || target.currentRunId !== run.runId) fail('RUN_NOT_RUNNING');
  };
  const pending = (target, step) => {
    if (
      target.unresolvedOperation?.runId !== step.runId ||
      target.unresolvedOperation.stepId !== step.stepId ||
      target.unresolvedOperation.operationId !== step.operationId
    )
      fail('STEP_NOT_PENDING');
  };
  const stepTransaction = (request, change) => {
    const input = freeze(jsonCopy(request));
    return store.transact(async (tx) => {
      const target = await guardTarget(tx, input.guard);
      const run = await loadRun(tx, input.runId, input.guard);
      const step = await tx.get('steps', stepId(input.runId, input.stepId));
      if (
        step?.targetId !== targetId ||
        step.runId !== run.runId ||
        step.stepId !== input.stepId ||
        step.fence !== run.fence
      )
        fail('STEP_NOT_FOUND');
      if (step.intentHash !== stepIdentity(step)) fail('CORRUPT_STEP');
      running(target, run);
      assertGuard(target, input.guard);
      return change({ tx, target, run, step, input });
    });
  };
  const saveStep = (tx, step) =>
    tx.put('steps', stepId(step.runId, step.stepId), { ...step, version: bump(step.version) });
  const saveRun = (tx, run) =>
    tx.put('runs', runId(run.runId), { ...run, version: bump(run.version) });
  const checkReceipt = (step, result, status) => {
    const expected = status === 'not-applied' ? step.beforeHash : step.afterHash;
    if (
      result?.status !== status ||
      result.operationId !== step.operationId ||
      result.intentHash !== step.intentHash ||
      result.executionId !== step.executionId ||
      result.planSha256 !== step.planSha256 ||
      result.subject !== (status === 'submitted' ? step.subject : step.verifySubject) ||
      result.expectedHash !== expected ||
      (status !== 'submitted' && (result.observedHash !== expected || result.terminal !== true))
    )
      fail('INVALID_RECEIPT');
  };
  const writeTarget = (tx, target) =>
    tx.put('targets', targetId, { ...target, version: bump(target.version) });
  const api = {
    targetId,
    async beginStep(input) {
      const request = jsonCopy(input);
      const operationId = randomUUID();
      const { component, kind, beforeHash, afterHash, subject, verifySubject, executionId } =
        request;
      id(request.stepId);
      text(component);
      text(subject);
      text(verifySubject);
      id(executionId);
      if (
        !['write', 'accept'].includes(kind) ||
        ![beforeHash, afterHash].every((hash) => isHash(hash) || hash === 'absent')
      )
        fail('INVALID_STEP');
      return store.transact(async (tx) => {
        const target = await guardTarget(tx, request.guard);
        const run = await loadRun(tx, request.runId, request.guard);
        const existing = await tx.get('steps', stepId(request.runId, request.stepId));
        running(target, run);
        if (existing !== null) {
          if (existing.requestHash !== identity(request)) fail('STEP_CONFLICT');
          if (existing.state !== 'verified') fail('STEP_REQUIRES_READBACK');
          return freeze(existing);
        }
        if (target.unresolvedOperation) fail('UNRESOLVED_OPERATION');
        if (
          run.verifiedSteps >= run.plan.stepCount ||
          (kind === 'accept') !== (run.verifiedSteps === run.plan.stepCount - 1) ||
          (run.kind === 'adopt' && kind !== 'accept') ||
          (kind === 'accept' && (component !== 'scope' || afterHash !== run.plan.acceptanceHash))
        )
          fail('INVALID_STEP_ORDER');
        if (kind === 'write' && !run.deliveredComponents.includes(component))
          fail('UNDELIVERED_COMPONENT');
        const intent = {
          schemaVersion: 1,
          targetId,
          runId: run.runId,
          stepId: request.stepId,
          operationId,
          component,
          kind,
          beforeHash,
          afterHash,
          subject,
          verifySubject,
          executionId,
          planSha256: run.plan.planSha256,
          sequence: run.verifiedSteps,
          fence: run.fence,
        };
        const step = {
          ...intent,
          state: 'intent',
          version: 0,
          createdAt: now(),
          requestHash: identity(request),
          intentHash: identity(intent),
        };
        assertGuard(target, request.guard);
        tx.put('steps', stepId(run.runId, step.stepId), step);
        writeTarget(tx, {
          ...target,
          unresolvedOperation: { runId: run.runId, stepId: step.stepId, operationId },
          dirtyRunId: kind === 'write' ? run.runId : target.dirtyRunId,
        });
        return freeze(step);
      });
    },
    async recordSubmitted(input) {
      return stepTransaction(input, ({ tx, target, step, input }) => {
        pending(target, step);
        checkReceipt(step, input.receipt, 'submitted');
        if (!['intent', 'unknown', 'submitted'].includes(step.state)) fail('STEP_TERMINAL');
        const updated = {
          ...step,
          state: 'submitted',
          submittedAt: now(),
          submittedReceipt: jsonCopy(input.receipt),
        };
        saveStep(tx, updated);
        writeTarget(tx, target);
        return freeze(updated);
      });
    },
    async confirmStep(input) {
      return stepTransaction(input, ({ tx, target, run, step, input }) => {
        checkReceipt(step, input.receipt, 'verified');
        if (step.state === 'verified') return freeze(step);
        pending(target, step);
        if (step.sequence !== run.verifiedSteps) fail('STEP_ORDER_CONFLICT');
        const updated = {
          ...step,
          state: 'verified',
          verifiedAt: now(),
          receipt: jsonCopy(input.receipt),
        };
        saveStep(tx, updated);
        saveRun(tx, {
          ...run,
          verifiedSteps: bump(run.verifiedSteps),
          verifiedWrites: step.kind === 'write' ? bump(run.verifiedWrites) : run.verifiedWrites,
          lastAcceptanceHash: step.kind === 'accept' ? step.afterHash : null,
        });
        writeTarget(tx, { ...target, unresolvedOperation: null });
        return freeze(updated);
      });
    },
    async markUnknown(input) {
      text(input.reason);
      return stepTransaction(input, ({ tx, target, step, input }) => {
        pending(target, step);
        saveStep(tx, { ...step, state: 'unknown', reason: input.reason, unknownAt: now() });
        writeTarget(tx, target);
        return { status: 'unknown', operationId: step.operationId };
      });
    },
    async failStep(input) {
      text(input.reason);
      return stepTransaction(input, ({ tx, target, run, step, input }) => {
        pending(target, step);
        checkReceipt(step, input.receipt, 'not-applied');
        saveStep(tx, {
          ...step,
          state: 'failed',
          receipt: jsonCopy(input.receipt),
          reason: input.reason,
          completedAt: now(),
        });
        saveRun(tx, { ...run, state: 'FAILED', reason: input.reason, completedAt: now() });
        writeTarget(tx, {
          ...target,
          currentRunId: null,
          unresolvedOperation: null,
          dirtyRunId: run.verifiedWrites ? run.runId : run.dirtyBeforeRun,
        });
        return {
          status: 'failed',
          recoveryRequired: run.verifiedWrites > 0 || run.dirtyBeforeRun !== null,
        };
      });
    },
    async failRun(request) {
      const input = freeze(jsonCopy(request));
      text(input.reason);
      return store.transact(async (tx) => {
        const target = await guardTarget(tx, input.guard);
        const run = await loadRun(tx, input.runId, input.guard);
        running(target, run);
        if (target.unresolvedOperation) fail('UNRESOLVED_OPERATION');
        assertGuard(target, input.guard);
        saveRun(tx, { ...run, state: 'FAILED', reason: input.reason, completedAt: now() });
        writeTarget(tx, { ...target, currentRunId: null });
        return { status: 'failed', recoveryRequired: target.dirtyRunId !== null };
      });
    },
    async commitRun(request) {
      const input = freeze(jsonCopy(request));
      text(input.changeSetRef);
      const activationId = randomUUID();
      return store.transact(async (tx) => {
        const target = await loadTarget(tx);
        const run = await loadRun(tx, input.runId, input.guard);
        const scope = await loadScope(tx, run.scopeKey);
        const failed = run.failedRunId ? await loadRun(tx, run.failedRunId) : null;
        const rootFailed =
          run.rootFailedRunId && run.rootFailedRunId !== run.failedRunId
            ? await loadRun(tx, run.rootFailedRunId)
            : null;
        if (run.accepted !== null) {
          if (input.changeSetRef !== run.accepted.changeSetRef) fail('COMMIT_CONFLICT');
          return freeze({
            status: 'already-committed',
            activation: run.accepted,
            isCurrent: scope.active?.activationId === run.accepted.activationId,
          });
        }
        assertGuard(target, input.guard);
        running(target, run);
        if (
          target.unresolvedOperation ||
          run.verifiedSteps !== run.plan.stepCount ||
          run.lastAcceptanceHash !== run.plan.acceptanceHash
        )
          fail('ACCEPTANCE_REQUIRED');
        if (scope.version !== run.baseScopeVersion) fail('STALE_ACTIVATION');
        if (
          failed &&
          (failed.state !== 'FAILED' ||
            failed.scopeKey !== run.scopeKey ||
            (target.dirtyRunId !== failed.runId && target.dirtyRunId !== run.runId))
        )
          fail('INVALID_FAILED_RUN');
        const seals = {
          ...run.retainedSeals,
          ...Object.fromEntries(
            run.deliveredComponents.map((key) => {
              const part = run.composition[key];
              return [
                key,
                {
                  schemaVersion: 1,
                  activationId,
                  releaseId: part.releaseId,
                  codeSha: part.codeSha,
                  artifact: part.artifact,
                  target: { envId: config.target.envId, siteOrigin: config.target.siteOrigin },
                  scope: scope.scope,
                },
              ];
            }),
          ),
        };
        const activation = {
          schemaVersion: 1,
          activationId,
          sourceRunId: run.runId,
          compositionHash: run.compositionHash,
          changeSetRef: input.changeSetRef,
          seals,
          acceptedAt: now(),
        };
        const pointer = {
          activationId,
          sourceRunId: run.runId,
          compositionHash: run.compositionHash,
        };
        saveRun(tx, { ...run, state: 'SUCCEEDED', accepted: activation, completedAt: now() });
        tx.put('scopes', scopeId(run.scopeKey), {
          ...scope,
          version: bump(scope.version),
          active: pointer,
          baseline: pointer,
        });
        if (failed)
          saveRun(tx, {
            ...failed,
            state: 'FAILED_RECOVERED',
            recoveryActivationId: activationId,
            recoveredByRunId: run.runId,
          });
        if (rootFailed) {
          if (rootFailed.state !== 'FAILED' || rootFailed.scopeKey !== run.scopeKey)
            fail('INVALID_FAILED_RUN');
          saveRun(tx, {
            ...rootFailed,
            state: 'FAILED_RECOVERED',
            recoveryActivationId: activationId,
            recoveredByRunId: run.runId,
          });
        }
        writeTarget(tx, {
          ...target,
          lease: null,
          unresolvedOperation: null,
          currentRunId: null,
          dirtyRunId: null,
        });
        return freeze({ status: 'committed', activation, isCurrent: true });
      });
    },
    async reconcile({ expectedVersion, expectedFence, proof }) {
      const evidence = jsonCopy(proof);
      return store.transact(async (tx) => {
        const target = await loadTarget(tx);
        const key = target.currentRunId ?? target.dirtyRunId;
        const run = key ? await loadRun(tx, key) : null;
        const operation = target.unresolvedOperation;
        const step = operation
          ? await tx.get('steps', stepId(operation.runId, operation.stepId))
          : null;
        const observed = evidence?.cloud?.observedHash;
        if (
          !target.lease ||
          now() < target.lease.expiresAt ||
          target.version !== expectedVersion ||
          target.lease.fence !== expectedFence ||
          evidence?.runnerRef !== target.lease.runnerRef ||
          evidence.job?.status !== 'completed' ||
          typeof evidence.job.evidenceRef !== 'string' ||
          !evidence.job.evidenceRef.trim() ||
          evidence.cloud?.status !== 'quiescent' ||
          typeof evidence.cloud.evidenceRef !== 'string' ||
          !evidence.cloud.evidenceRef.trim() ||
          !Number.isSafeInteger(evidence.checkedAt) ||
          evidence.checkedAt < target.lease.expiresAt ||
          evidence.checkedAt > now() ||
          now() - evidence.checkedAt > 60_000 ||
          evidence.cloud.operationId !== (operation?.operationId ?? null) ||
          (operation ? !isHash(observed) && observed !== 'absent' : observed !== null)
        )
          fail('INVALID_RECONCILIATION');
        let dirty = target.dirtyRunId;
        if (operation) {
          if (
            !step ||
            step.operationId !== operation.operationId ||
            !run ||
            step.runId !== run.runId ||
            step.intentHash !== stepIdentity(step)
          )
            fail('CORRUPT_PENDING_OPERATION');
          if (step.kind === 'write' && observed === step.beforeHash && run.verifiedWrites === 0)
            dirty = run.dirtyBeforeRun;
          saveStep(tx, { ...step, state: 'reconciled', resolution: evidence, completedAt: now() });
        }
        if (run && run.state === 'RUNNING')
          saveRun(tx, {
            ...run,
            state: 'FAILED',
            reason: 'Owner ended before activation commit',
            reconciliation: evidence,
            completedAt: now(),
          });
        writeTarget(tx, {
          ...target,
          lease: null,
          currentRunId: null,
          unresolvedOperation: null,
          dirtyRunId: dirty,
          lastReconciliation: evidence,
        });
        return { status: 'reconciled', recoveryRequired: dirty !== null };
      });
    },
    async runStatus(key) {
      return store.transact(async (tx) => {
        await loadTarget(tx);
        return freeze(await loadRun(tx, key));
      });
    },
    async startRun(input) {
      const request = jsonCopy(input);
      const key = id(request.runId);
      const operationTime = now();
      if (!['adopt', 'publish', 'restore'].includes(request.kind)) fail('INVALID_RUN_KIND');
      scopeId(request.scopeKey);
      if (
        !isHash(request.plan?.planSha256) ||
        !isHash(request.plan?.acceptanceHash) ||
        !Number.isSafeInteger(request.plan.stepCount) ||
        request.plan.stepCount < 1 ||
        request.plan.stepCount > 100_000 ||
        (request.kind === 'adopt' && request.plan.stepCount !== 1)
      )
        fail('INVALID_PLAN');
      return store.transact(async (tx) => {
        const target = await guardTarget(tx, request.guard);
        const scope = await loadScope(tx, request.scopeKey);
        const existing = await tx.get('runs', runId(key));
        const sourceId =
          request.kind === 'restore'
            ? (request.restoreFromRunId ?? scope.baseline?.sourceRunId)
            : scope.baseline?.sourceRunId;
        const source = sourceId ? await tx.get('runs', runId(sourceId)) : null;
        const failureId = request.failedRunId ?? target.dirtyRunId;
        const failed = failureId ? await tx.get('runs', runId(failureId)) : null;
        if (existing !== null) {
          if (
            existing.requestHash !== identity(request) ||
            existing.fence !== request.guard.fence ||
            existing.ownerRunId !== request.guard.ownerRunId ||
            target.currentRunId !== key
          )
            fail('RUN_CONFLICT');
          return freeze(existing);
        }
        if (target.currentRunId || target.unresolvedOperation) fail('UNRESOLVED_OPERATION');
        if (target.dirtyRunId && request.kind !== 'restore') fail('RECOVERY_REQUIRED');
        if (request.kind === 'adopt' && (scope.active !== null || target.dirtyRunId))
          fail('BASELINE_ALREADY_EXISTS');
        if (request.kind !== 'adopt' && !scope.baseline) fail('BASELINE_REQUIRED');
        if (
          sourceId &&
          (source?.accepted?.sourceRunId !== sourceId ||
            source.targetId !== targetId ||
            source.scopeKey !== request.scopeKey ||
            source.accepted.compositionHash !== identity(source.composition))
        )
          fail('INVALID_RESTORE_SOURCE');
        if (
          failureId &&
          (request.kind !== 'restore' ||
            failed?.targetId !== targetId ||
            failed.scopeKey !== request.scopeKey ||
            failed.state !== 'FAILED' ||
            target.dirtyRunId !== failureId)
        )
          fail('INVALID_FAILED_RUN');
        const candidate = request.kind === 'restore' ? source?.composition : request.composition;
        if (!candidate) fail('INVALID_COMPOSITION');
        const selection =
          request.kind === 'adopt' ? Object.keys(candidate) : request.deliveredComponents;
        if (
          !Array.isArray(selection) ||
          !selection.length ||
          new Set(selection).size !== selection.length ||
          selection.some((name) => !Object.hasOwn(candidate, name))
        )
          fail('INVALID_COMPONENT_SELECTION');
        const selected = Object.fromEntries(selection.map((name) => [name, candidate[name]]));
        validateComposition(selected, config, request.scopeKey, now(), true);
        // Retained parts come from the current baseline, even when restoring selected older parts.
        const current =
          scope.baseline?.sourceRunId && scope.baseline.sourceRunId !== sourceId
            ? await tx.get('runs', runId(scope.baseline.sourceRunId))
            : source;
        if (
          scope.baseline &&
          (current?.accepted?.activationId !== scope.baseline.activationId ||
            current.accepted.compositionHash !== scope.baseline.compositionHash)
        )
          fail('CORRUPT_BASELINE');
        const finalComposition = validateComposition(
          { ...(current?.composition ?? {}), ...selected },
          config,
          request.scopeKey,
          null,
        );
        const run = {
          schemaVersion: 1,
          targetId,
          runId: key,
          scopeKey: request.scopeKey,
          scope: scope.scope,
          kind: request.kind,
          ownerRunId: request.guard.ownerRunId,
          acquiredVersion: request.guard.acquiredVersion,
          fence: request.guard.fence,
          state: 'RUNNING',
          version: 0,
          requestHash: identity(request),
          plan: request.plan,
          baseScopeVersion: scope.version,
          composition: finalComposition,
          compositionHash: identity(finalComposition),
          deliveredComponents: selection,
          verifiedSteps: 0,
          verifiedWrites: 0,
          failedRunId: failureId ?? null,
          rootFailedRunId: failed ? (failed.rootFailedRunId ?? failed.runId) : null,
          dirtyBeforeRun: target.dirtyRunId,
          retainedSeals: Object.fromEntries(
            Object.keys(current?.composition ?? {})
              .filter((key) => !selection.includes(key))
              .map((key) => [key, current.accepted.seals[key]]),
          ),
          restoredFromRunId: request.kind === 'restore' ? sourceId : null,
          accepted: null,
          createdAt: operationTime,
        };
        assertGuard(target, request.guard);
        tx.put('runs', runId(key), run);
        writeTarget(tx, { ...target, currentRunId: key });
        return freeze(run);
      });
    },
    async acquire({ ownerRunId, runnerRef }) {
      id(ownerRunId);
      text(runnerRef);
      return store.transact(async (tx) => {
        const loaded = await loadTarget(tx, false);
        const target = loaded ?? {
          schemaVersion: 1,
          targetId,
          target: config.target,
          policyHash: config.policyHash,
          version: 0,
          nextFence: 0,
          lease: null,
          currentRunId: null,
          dirtyRunId: null,
          unresolvedOperation: null,
        };
        if (target.lease !== null) {
          if (now() >= target.lease.expiresAt) fail('LEASE_STALLED');
          if (target.lease.ownerRunId !== ownerRunId || target.lease.runnerRef !== runnerRef)
            fail('LEASE_BUSY');
          return {
            targetId,
            ownerRunId,
            fence: target.lease.fence,
            acquiredVersion: target.lease.acquiredVersion,
          };
        }
        if (target.unresolvedOperation || target.currentRunId) fail('UNRESOLVED_OPERATION');
        const fence = bump(target.nextFence);
        const acquiredVersion = bump(target.version);
        const lease = {
          ownerRunId,
          runnerRef,
          fence,
          acquiredVersion,
          expiresAt: integer(now() + leaseMs),
        };
        writeTarget(tx, { ...target, nextFence: fence, lease });
        return { targetId, ownerRunId, fence, acquiredVersion };
      });
    },
    async renew(input) {
      const guard = freeze(jsonCopy(input));
      return store.transact(async (tx) => {
        const target = await guardTarget(tx, guard);
        writeTarget(tx, {
          ...target,
          lease: {
            ...target.lease,
            expiresAt: Math.max(target.lease.expiresAt, integer(now() + leaseMs)),
          },
        });
        return guard;
      });
    },
    async release(input) {
      const guard = freeze(jsonCopy(input));
      return store.transact(async (tx) => {
        const target = await guardTarget(tx, guard);
        if (target.unresolvedOperation || target.currentRunId || target.dirtyRunId)
          fail('UNRESOLVED_OPERATION');
        writeTarget(tx, { ...target, lease: null });
        return { status: 'released' };
      });
    },
    async status({ scopeKey = 'site' } = {}) {
      return store.transact(async (tx) => {
        const target = await loadTarget(tx, false);
        const scope = await loadScope(tx, scopeKey);
        const operation = target?.unresolvedOperation;
        const pendingStep = operation
          ? await tx.get('steps', stepId(operation.runId, operation.stepId))
          : null;
        if (
          operation &&
          (!pendingStep ||
            pendingStep.operationId !== operation.operationId ||
            pendingStep.intentHash !== stepIdentity(pendingStep))
        )
          fail('CORRUPT_STEP');
        return freeze({
          pendingStep,
          targetId,
          state:
            target === null
              ? 'uninitialized'
              : target.lease && now() >= target.lease.expiresAt
                ? 'stalled'
                : target.lease
                  ? 'leased'
                  : target.dirtyRunId
                    ? 'recovery-required'
                    : 'idle',
          target,
          scope,
        });
      });
    },
  };
  return Object.freeze(api);
}

function stepIdentity(step) {
  return identity(
    Object.fromEntries(
      [
        'schemaVersion',
        'targetId',
        'runId',
        'stepId',
        'operationId',
        'component',
        'kind',
        'beforeHash',
        'afterHash',
        'subject',
        'verifySubject',
        'executionId',
        'planSha256',
        'sequence',
        'fence',
      ].map((key) => [key, step[key]]),
    ),
  );
}
