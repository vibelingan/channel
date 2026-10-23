import { assertErrorDocument, assertMutableCachePolicy } from '../hosting-contract.mjs';
import {
  executeHostingRecovery,
  planReleaseCandidate,
  planReleaseRecovery,
} from '../hosting-recovery.mjs';
import {
  createHostingRecoveryAdapters,
  hostingCoordinatorPlan,
} from '../release/hosting-adapter.mjs';
import {
  configurationStateHash,
  prepareHostingConfiguration,
} from '../release/hosting-configuration.mjs';
import { verifyHostingObject } from '../release/hosting-readback.mjs';
import { identity, sha256 } from '../release/input.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';

/** No global configuration or broad directory removal is allowed by this entry. */
export async function deliverBlogDummy({
  coordinator,
  provider,
  guard,
  runId,
  input,
  loadAccepted,
  mode = 'publish',
  restoreRunId = null,
  request = fetchFully,
  postCheck = async (_context) => {},
  adapterOptions = {},
}) {
  const target = { envId: policy.envId, site: policy.siteOrigin };
  if (identity(provider.target) !== identity(target) || !['publish', 'restore'].includes(mode))
    throw new Error('Invalid Blog delivery target');
  let started = false;
  let baseline = null;
  let baselineRun = null;
  async function acceptedSource(run) {
    if (
      run?.state !== 'SUCCEEDED' ||
      !run.accepted ||
      run.accepted.sourceRunId !== run.runId ||
      run.scopeKey !== 'canary'
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
    const plan =
      action === 'restore'
        ? planReleaseRecovery({
            artifactInput: source,
            currentOwnedPaths: owned,
            publicProductPaths: [],
          })
        : planReleaseCandidate({ artifactInput: source, currentOwnedPaths: owned });
    if (
      plan.scope.prefix !== policy.canaryPrefix ||
      [...plan.uploads.map((e) => e.path), ...plan.deletes].some(
        (path) => !path.startsWith(policy.canaryPrefix),
      )
    )
      throw new Error('Blog delivery escaped its prefix');
    const errorPath = configurationPlan.before.website.WebsiteConfiguration.ErrorDocument?.Key;
    if (typeof errorPath !== 'string' || errorPath.startsWith(policy.canaryPrefix))
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
    const errorDocument = {
      path: errorPath,
      bytes: response.body.length,
      sha256: sha256(response.body),
    };
    await coordinator.renew(guard);
    await coordinator.startRun({
      guard,
      runId: key,
      scopeKey: 'canary',
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
      activation: committed.activation,
    };
  }
  try {
    const status = await coordinator.status({ scopeKey: 'canary' });
    if (
      status.state !== 'leased' ||
      status.target.lease.fence !== guard.fence ||
      status.pendingStep ||
      status.target.currentRunId ||
      status.target.dirtyRunId
    )
      throw new Error('Blog delivery target is busy or unresolved');
    const owned = await provider.inventory(policy.canaryPrefix);
    if (status.scope.baseline) {
      baselineRun = await coordinator.runStatus(status.scope.baseline.sourceRunId);
      baseline = await acceptedSource(baselineRun);
      const expected = baseline.staticManifest.entries;
      if (identity([...owned].sort()) !== identity(expected.map((e) => e.path).sort()))
        throw new Error('Unexpected files in isolated Blog prefix');
      for (const entry of expected) await verifyHostingObject({ target, entry, request });
    } else if (owned.length) throw new Error('Isolated Blog prefix is already occupied');
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
    const status = await coordinator.status({ scopeKey: 'canary' });
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
      const stopped = await coordinator.status({ scopeKey: 'canary' });
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
            await provider.inventory(policy.canaryPrefix),
            baselineRun.runId,
          );
          return { status: 'restored', receipt };
        } catch {
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
