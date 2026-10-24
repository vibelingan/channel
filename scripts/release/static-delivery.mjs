import { assertErrorDocument, assertMutableCachePolicy } from '../hosting-contract.mjs';
import { assertAcceptedHostingFiles, selectChangedHostingFiles } from '../hosting-delta.mjs';
import {
  executeHostingRecovery,
  planReleaseCandidate,
  planReleaseRecovery,
  planSiteReleaseCandidate,
} from '../hosting-recovery.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { createHostingRecoveryAdapters, hostingCoordinatorPlan } from './hosting-adapter.mjs';
import { withSiteUploadBatches } from './hosting-batches.mjs';
import { configurationStateHash, prepareHostingConfiguration } from './hosting-configuration.mjs';
import { verifyHostingObject } from './hosting-readback.mjs';
import { identity, sha256 } from './input.mjs';
import { ownedSitePaths } from './site-files.mjs';
import { assertDirtySiteInventory, assertSiteRecoveryChain } from './site-recovery.mjs';

/** No global configuration or broad directory removal is allowed by this entry. */
export async function deliverStaticContent(
  {
    coordinator,
    provider,
    guard,
    runId,
    input,
    loadAccepted,
    failedCandidates = /** @type {Array<{run:object,input:object}>|null} */ (null),
    mode = 'publish',
    restoreRunId = /** @type {string|null} */ (null),
    request = fetchFully,
    postCheck = async (_context) => {},
    adapterOptions = {},
    publicProductPaths = /** @type {string[]} */ ([]),
    readPublicProductPaths = async () => publicProductPaths,
    onStop = (_phase, _error) => {},
  },
  { policy, scopeKey = 'canary' },
) {
  const target = { envId: policy.envId, site: policy.siteOrigin };
  if (
    identity(provider.target) !== identity(target) ||
    !['publish', 'restore', 'adopt'].includes(mode)
  )
    throw new Error('Invalid Blog delivery target');
  let started = false;
  let baseline = null;
  let baselineRun = null;
  let owned = [];
  const baselineProofs = [];
  async function acceptedSource(run) {
    if (
      run?.state !== 'SUCCEEDED' ||
      !run.accepted ||
      run.accepted.sourceRunId !== run.runId ||
      run.scopeKey !== scopeKey
    )
      throw new Error('Blog recovery source is not accepted');
    const source = await loadAccepted(run);
    if (
      identity(source.acceptedSeal) !== identity(run.accepted.seals.static) ||
      identity(source.envelope.artifact) !== identity(run.composition.static.artifact)
    )
      throw new Error('Blog accepted artifact identity mismatch');
    return source;
  }
  async function execute(source, key, action, owned, sourceRunId) {
    const configurationPlan = prepareHostingConfiguration({
      target,
      before: source.staticManifest.configuration,
    });
    if (
      configurationPlan.changes.length ||
      configurationStateHash(await provider.readConfiguration()) !==
        configurationStateHash(configurationPlan.before)
    )
      throw new Error('Blog delivery cannot change hosting configuration');
    const currentPublicProductPaths = scopeKey === 'site' ? await readPublicProductPaths() : [];
    let plan =
      action === 'restore'
        ? planReleaseRecovery({
            artifactInput: source,
            currentOwnedPaths: owned,
            publicProductPaths: currentPublicProductPaths,
          })
        : scopeKey === 'site'
          ? planSiteReleaseCandidate({
              artifactInput: source,
              currentOwnedPaths: owned,
              publicProductPaths: currentPublicProductPaths,
            })
          : planReleaseCandidate({ artifactInput: source, currentOwnedPaths: owned });
    if (
      scopeKey === 'canary' &&
      (plan.scope.prefix !== policy.canaryPrefix ||
        [...plan.uploads.map((e) => e.path), ...plan.deletes].some(
          (path) => !path.startsWith(policy.canaryPrefix),
        ))
    )
      throw new Error('Blog delivery escaped its prefix');
    if (scopeKey === 'site') {
      if (plan.scope.kind !== 'site' || typeof provider.readInventory !== 'function')
        throw new Error('Formal site inventory required');
      plan = selectChangedHostingFiles({
        plan,
        directory: source.directory,
        inventory: await provider.readInventory(),
        contentProofs: baselineProofs,
      });
      plan = withSiteUploadBatches(plan);
      if (action === 'adopt' && (plan.uploads.length || plan.deletes.length))
        throw new Error('Baseline differs from the live site');
    }
    const errorPath = configurationPlan.before.website.WebsiteConfiguration.ErrorDocument?.Key;
    if (
      typeof errorPath !== 'string' ||
      (scopeKey === 'canary' && errorPath.startsWith(policy.canaryPrefix))
    )
      throw new Error('Dedicated site error page required');
    const response = await request('GET', `${target.site}/${errorPath}`, {
      timeoutMs: 15000,
      maxBytes: 131072,
      redirect: 'error',
      headers: { 'cache-control': 'no-cache', 'accept-encoding': 'identity' },
    });
    if (response.status !== 200) throw new Error('Error document unavailable');
    assertErrorDocument(response.body);
    assertMutableCachePolicy(response.headers.get('cache-control') ?? '');
    const errorDocument = source.staticManifest.entries.find(
      (entry) => entry.path === errorPath,
    ) ?? {
      path: errorPath,
      bytes: response.body.length,
      sha256: sha256(response.body),
    };
    await coordinator.renew(guard);
    await coordinator.startRun({
      guard,
      runId: key,
      scopeKey,
      kind: action,
      ...(action === 'restore'
        ? { restoreFromRunId: sourceRunId }
        : {
            composition: {
              static: {
                releaseId: source.envelope.releaseId,
                codeSha: source.envelope.codeSha,
                contentSha256: plan.stateSha256,
                artifact: source.envelope.artifact,
              },
            },
          }),
      deliveredComponents: ['static'],
      plan: hostingCoordinatorPlan(plan, configurationPlan),
    });
    started = true;
    const adapters = createHostingRecoveryAdapters({
      ...adapterOptions,
      plan,
      directory: source.directory,
      configurationPlan,
      coordinator,
      guard,
      runId: key,
      provider,
      request,
      errorDocument,
    });
    await executeHostingRecovery(plan, adapters);
    await postCheck({ action, plan });
    const committed = await coordinator.commitRun({
      guard,
      runId: key,
      changeSetRef: `blog:${key}`,
    });
    return {
      deliveryId: key,
      artifactHash: plan.stateSha256,
      acceptedAt: new Date(committed.activation.acceptedAt).toISOString(),
    };
  }
  try {
    const status = await coordinator.status({ scopeKey });
    if (
      status.state !== 'leased' ||
      status.target.lease.fence !== guard.fence ||
      status.pendingStep ||
      status.target.currentRunId ||
      (status.target.dirtyRunId && mode !== 'restore')
    )
      throw new Error('Blog delivery target is busy or unresolved');
    if (status.target.dirtyRunId) {
      if (scopeKey !== 'site' || !failedCandidates)
        throw Error('Exact failed site artifact required');
      assertSiteRecoveryChain({
        chain: failedCandidates,
        policy,
        dirtyRunId: status.target.dirtyRunId,
      });
    }
    owned =
      scopeKey === 'site'
        ? (await provider.readInventory())
            .filter((entry) => input?.ownedPaths?.includes(entry.path))
            .map((entry) => entry.path)
        : await provider.inventory(policy.canaryPrefix);
    if (status.scope.baseline) {
      baselineRun = await coordinator.runStatus(status.scope.baseline.sourceRunId);
      baseline = await acceptedSource(baselineRun);
      const expected = baseline.staticManifest.entries;
      if (
        scopeKey === 'canary' &&
        identity([...owned].sort()) !== identity(expected.map((e) => e.path).sort())
      )
        throw new Error('Unexpected files in isolated Blog prefix');
      if (scopeKey === 'canary')
        for (const entry of expected) await verifyHostingObject({ target, entry, request });
      else {
        const inventory = await provider.readInventory();
        if (!status.target.dirtyRunId)
          for (const entry of expected) {
            const current = inventory.find((e) => e.path === entry.path);
            if (
              current &&
              !/^"?[a-f0-9]{32}"?$/i.test(current.etag) &&
              !(
                entry.objectVersion?.etag === current.etag &&
                entry.objectVersion?.lastModified === current.lastModified
              )
            ) {
              const observed = await verifyHostingObject({ target, entry, request });
              if (observed.etag !== current.etag)
                throw Object.assign(Error('Accepted object changed during readback'), {
                  code: 'STOP_EXTERNAL_CHANGE',
                });
              baselineProofs.push({
                ...entry,
                etag: current.etag,
                lastModified: current.lastModified,
              });
            }
          }
        if (status.target.dirtyRunId) {
          const inventory = await provider.readInventory();
          assertDirtySiteInventory({
            baseline,
            failed: failedCandidates.map((c) => c.input),
            inventory,
          });
          const paths = new Set(failedCandidates.flatMap((c) => ownedSitePaths(c.input, baseline)));
          owned = inventory.filter((entry) => paths.has(entry.path)).map((entry) => entry.path);
        } else
          assertAcceptedHostingFiles({
            source: baseline,
            inventory: await provider.readInventory(),
            contentProofs: baselineProofs,
          });
      }
    } else if (owned.length && mode !== 'adopt') throw new Error('Delivery baseline is required');
    if (mode === 'adopt') {
      if (scopeKey !== 'site' || baseline)
        throw new Error('Only the first formal baseline can be adopted');
      return { status: 'accepted', receipt: await execute(input, runId, 'adopt', []) };
    }
    if (mode === 'restore') {
      if (!restoreRunId) throw new Error('Explicit accepted recovery version required');
      const source = await acceptedSource(await coordinator.runStatus(restoreRunId));
      return {
        status: 'accepted',
        receipt: await execute(source, runId, 'restore', owned, restoreRunId),
      };
    }
    return {
      status: 'accepted',
      receipt: await execute(input, runId, baseline ? 'publish' : 'initialize', owned),
    };
  } catch (error) {
    try {
      onStop('publish', error);
    } catch {
      /* Logging must not change recovery. */
    }
    const status = await coordinator.status({ scopeKey });
    if (error?.code === 'STOP_EXTERNAL_CHANGE')
      return {
        status: 'unknown',
        reason: 'An external website change requires readback before any further write',
      };
    // A lost/unknown SDK result is never treated as a safe retry or a restore trigger.
    if (
      status.pendingStep ||
      status.target?.lease?.fence !== guard.fence ||
      status.state !== 'leased'
    )
      return { status: 'unknown', reason: 'Cloud outcome or lease requires readback' };
    if (started) {
      await coordinator.failRun({
        guard,
        runId,
        reason: 'Blog delivery stopped before acceptance',
      });
      const stopped = await coordinator.status({ scopeKey });
      if (stopped.target.dirtyRunId) {
        if (!baseline || !baselineRun || mode === 'restore')
          return {
            status: 'unknown',
            reason: 'No accepted recovery target; stopped without recursive recovery',
          };
        // Recover exactly the baseline checked before the first write, once only.
        try {
          const receipt = await execute(
            baseline,
            `${runId}-restore`,
            'restore',
            scopeKey === 'site'
              ? [...new Set([...owned, ...input.staticManifest.entries.map((entry) => entry.path)])]
              : await provider.inventory(policy.canaryPrefix),
            baselineRun.runId,
          );
          return { status: 'restored', receipt };
        } catch (error) {
          try {
            onStop('restore', error);
          } catch {
            /* Logging must not change recovery. */
          }
          return {
            status: 'unknown',
            reason: 'Recovery could not be confirmed; no further writes',
          };
        }
      }
    }
    await coordinator.release(guard);
    return {
      status: 'not-written',
      reason: error instanceof Error ? error.message : 'Build/delivery preflight failed',
    };
  }
}
