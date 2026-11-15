import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createExclusiveLeaseHeartbeat } from './release/lease-heartbeat.mjs';
import { assertCleanAcceptedSite } from './release/site-policy.mjs';

const stopped = (code) => Object.assign(Error(code), { code });

/** Hold the normal release lease only while collecting public inputs; never upload a website. */
export async function captureCatalogRegionalInput({
  coordinator,
  owner,
  config,
  createClient,
  collect,
  schedule = setInterval,
  cancel = clearInterval,
  now = () => performance.now(),
}) {
  const baseline = assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
  const guard = await coordinator.acquire(owner);
  let client;
  let failed = false;
  let failure;
  let result;
  const validateCurrent = async () => {
    const current = await coordinator.status({ scopeKey: 'site' });
    if (
      !isDeepStrictEqual(current.scope?.baseline, baseline) ||
      current.state !== 'leased' ||
      current.target?.lease?.ownerRunId !== owner.ownerRunId ||
      current.target.lease.runnerRef !== owner.runnerRef ||
      current.target.lease.fence !== guard.fence ||
      current.target.lease.acquiredVersion !== guard.acquiredVersion ||
      current.target.currentRunId ||
      current.target.dirtyRunId ||
      current.target.unresolvedOperation ||
      current.pendingStep
    )
      throw stopped('CATALOG_CAPTURE_BASELINE_CHANGED');
  };
  const renew = async () => {
    try {
      await coordinator.renew(guard);
      await validateCurrent();
    } catch (error) {
      throw error?.code === 'CATALOG_CAPTURE_BASELINE_CHANGED'
        ? error
        : stopped('CATALOG_CAPTURE_LEASE_LOST');
    }
  };
  const heartbeat = createExclusiveLeaseHeartbeat({ renew, schedule, cancel, now });
  const checkpoint = async () => {
    await heartbeat.checkpoint();
    await validateCurrent();
    heartbeat.check();
  };
  try {
    await checkpoint();
    try {
      client = await createClient(guard, {
        withLease: (operation) => heartbeat.withLease(operation),
      });
    } catch {
      // No returned client can prove that a partially created function was removed.
      throw stopped('CATALOG_REGIONAL_UNCONFIRMED');
    }
    await checkpoint();
    const before = await client.prepare(config);
    await checkpoint();
    const value = await collect({ baseline, checkpoint });
    await checkpoint();
    const after = await client.prepare(config);
    await checkpoint();
    result = { baseline, before, after, value };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    await heartbeat.stop();
    let cleaned = false;
    const unknown = client?.unconfirmed || failure?.code === 'CATALOG_REGIONAL_UNCONFIRMED';
    if (unknown && !failed) {
      failed = true;
      failure = stopped('CATALOG_REGIONAL_UNCONFIRMED');
    }
    if (client && !unknown) {
      try {
        const answer = await client.close();
        assert.equal(answer?.cleaned, true);
        assert.equal(answer.unconfirmed, false);
        cleaned = true;
      } catch {
        failed = true;
        failure = stopped('CATALOG_CAPTURE_CLEANUP_UNCONFIRMED');
      }
    }
    if (heartbeat.failed) {
      failed = true;
      failure = heartbeat.failure;
    }
    if (cleaned && !heartbeat.failed) {
      try {
        await renew();
        await coordinator.release(guard);
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  assert.ok(result);
  return result;
}
