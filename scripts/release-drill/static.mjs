import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canaryArtifact, createCanaryPayload } from '../release/canary.mjs';
import { createGithubSource } from '../release/github-source.mjs';
import { executeManualCanary, planManualCanary } from '../release/orchestrator.mjs';

/** C1 owns the single noindex file. Its audit records use the separate drill collections. */
export async function exerciseDummyStatic({
  provider,
  coordinator,
  policy,
  artifactClient,
  owner,
  codeSha,
  githubRun,
  attempt,
  seedRun,
  operation,
  output,
  token,
}) {
  const source = createGithubSource({ policy, token });
  const status = await coordinator.status({ scopeKey: 'canary' });
  const downloaded = new Map();
  const loadAccepted = async (run) => {
    if (run.state !== 'SUCCEEDED' || run.scopeKey !== 'canary' || !run.accepted)
      throw Error('An accepted private static A is required');
    const artifactId = run.composition.static.artifact.artifactId;
    const directory = join(output, `static-source-${artifactId}`);
    await source.requireCI(run.composition.static.codeSha);
    const acceptedOptions = { acceptedSeal: run.accepted.seals.static };
    const metadata = downloaded.has(artifactId)
      ? (await source.metadata(artifactId, acceptedOptions)).metadata
      : await source.download(artifactId, directory, acceptedOptions);
    downloaded.set(artifactId, true);
    return canaryArtifact({
      directory,
      policy,
      run: metadata,
      acceptedSeal: run.accepted.seals.static,
    });
  };
  let input;
  let restoreRunId = null;
  if (operation === 'restore') {
    restoreRunId = `dummy-${seedRun}-static-A`;
    input = await loadAccepted(await coordinator.runStatus(restoreRunId));
  } else {
    const directory = join(output, `static-${operation}`);
    createCanaryPayload({
      directory,
      policy,
      configuration: await provider.readConfiguration(),
      variant: operation === 'initialize' ? 'A' : 'B',
      codeSha,
    });
    const walk = async (dir) =>
      (
        await Promise.all(
          (
            await readdir(dir, { withFileTypes: true })
          ).map((x) => (x.isDirectory() ? walk(join(dir, x.name)) : join(dir, x.name))),
        )
      ).flat();
    const stored = await artifactClient.uploadArtifact(
      `static-canary-payload-${githubRun}-${attempt}`,
      await walk(directory),
      directory,
      { retentionDays: 90 },
    );
    if (!stored.id || !stored.digest) throw Error('Static dummy archive was not confirmed');
    const verifiedDirectory = `${directory}-verified`;
    const metadata = await source.download(String(stored.id), verifiedDirectory, {
      allowCurrentRunId: githubRun,
    });
    input = canaryArtifact({ directory: verifiedDirectory, policy, run: metadata });
  }
  const request = {
    action: operation,
    expectedActivationId: status.scope.active?.activationId ?? 'none',
    restoreRunId,
    reason: 'Authorized isolated static A to B to A; preserve every ordinary website URL',
    executorSha: codeSha,
  };
  const args = { policy, coordinator, provider, input, request, loadAccepted };
  const plan = await planManualCanary(args);
  const runId =
    operation === 'initialize'
      ? `dummy-${seedRun}-static-A`
      : `dummy-${githubRun}-static-${operation}`;
  const result = await executeManualCanary({ ...args, token: plan.review.token, runId, owner });
  if (result.status !== 'accepted') throw Error('Static dummy delivery was not accepted');
  return {
    status: result.status,
    runId,
    path: `/${policy.canaryPrefix}`,
    variant: operation === 'publish' ? 'B' : 'A',
    fileWrites: 1,
  };
}
