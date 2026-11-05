import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const stoppedError = () =>
  Object.assign(Error('Lease heartbeat has stopped'), {
    code: 'LEASE_HEARTBEAT_STOPPED',
  });

/** Regional transactions and WAN renewals write the same target row: run them sequentially. */
export function createExclusiveLeaseHeartbeat({
  renew,
  intervalMs = 30_000,
  now = () => performance.now(),
  schedule = setInterval,
  cancel = clearInterval,
}) {
  assert.equal(typeof renew, 'function');
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > 0);
  let tail = Promise.resolve();
  let pending = 0;
  let stopped = false;
  let failed = false;
  let failure;
  let generation = 0;
  let lastRenewed;
  const check = () => {
    if (failed) throw failure;
  };
  const latch = (error) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    return failure;
  };
  const enqueue = (operation) => {
    if (stopped) return Promise.reject(stoppedError());
    pending++;
    const active = tail.then(async () => {
      if (stopped) throw stoppedError();
      check();
      return operation();
    });
    tail = active.then(
      () => undefined,
      () => undefined,
    );
    return active.finally(() => {
      pending--;
    });
  };
  const renewIfDue = async () => {
    check();
    const started = now();
    if (lastRenewed !== undefined && started >= lastRenewed && started - lastRenewed < intervalMs)
      return;
    const renewingGeneration = generation;
    try {
      await renew();
    } catch (error) {
      throw latch(error);
    }
    if (generation === renewingGeneration) lastRenewed = started;
  };
  const checkpoint = () => enqueue(renewIfDue);
  const timer = schedule(() => {
    if (stopped || failed || pending) return Promise.resolve();
    // Failure remains observable through check() and prevents every later call.
    return checkpoint().catch(() => {});
  }, intervalMs);
  return {
    checkpoint,
    check,
    invalidate() {
      generation++;
      lastRenewed = undefined;
    },
    withLease(operation) {
      assert.equal(typeof operation, 'function');
      return enqueue(async () => {
        await renewIfDue();
        try {
          return await operation();
        } catch (error) {
          if (error?.code === 'CATALOG_REGIONAL_UNCONFIRMED') latch(error);
          throw error;
        }
      });
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        cancel(timer);
      }
      // No cleanup or release may race a request that was already sent.
      await tail;
    },
    get failed() {
      return failed;
    },
    get failure() {
      return failure;
    },
  };
}

/** A completed acceptance releases its lease; an expired or failed same-owner renewal does not. */
export async function renewCurrentSiteLease({ coordinator, getGuard, runnerRef, acceptedRunIds }) {
  assert.equal(typeof runnerRef, 'string');
  assert.ok(runnerRef);
  const attempted = getGuard();
  try {
    await coordinator.renew(attempted);
  } catch (error) {
    const status = await coordinator.status({ scopeKey: 'site' }).catch(() => null);
    // The guard may change while this status request is in flight.
    const current = getGuard();
    if (
      current !== attempted &&
      status?.state === 'leased' &&
      status.target?.lease?.ownerRunId === current.ownerRunId &&
      status.target.lease.runnerRef === runnerRef &&
      status.target.lease.fence === current.fence &&
      status.target.lease.acquiredVersion === current.acquiredVersion &&
      !status.target.currentRunId &&
      !status.target.dirtyRunId &&
      !status.target.unresolvedOperation &&
      !status.pendingStep &&
      acceptedRunIds.includes(status.scope?.baseline?.sourceRunId)
    ) {
      await coordinator.renew(current);
      return;
    }
    if (
      status?.state === 'idle' &&
      status.target?.lease === null &&
      !status.target.currentRunId &&
      !status.target.dirtyRunId &&
      !status.target.unresolvedOperation &&
      !status.pendingStep &&
      acceptedRunIds.includes(status.scope?.baseline?.sourceRunId)
    )
      return;
    throw error;
  }
}
