import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { assertBlogDummyFileId } from '../../apps/functions/admin/src/blog-dummy-storage.ts';
import { articleReleaseBuildInput } from '../../packages/articles/src/release-build.ts';
import type {
  ArticleReleaseGuard,
  ClaimedArticleRelease,
} from '../../packages/articles/src/release-store.ts';
import { writeBlogBuildAssets } from '../../packages/db/src/article-build-assets.ts';
import {
  createBlogDummyControlDatabase,
  createBlogDummyDatabase,
} from '../../packages/db/src/article-dummy.ts';
import { readAcceptedArticles } from '../../packages/db/src/article-release-source.ts';
import { createCloudBaseArticleReleaseWorker } from '../../packages/db/src/article-repository.ts';
import { createReleaseCoordinator } from '../release/state.mjs';
import { createCloudbaseReleaseStore } from '../release/store-cloudbase.mjs';
import { deliverBlogDummy } from './delivery.mjs';
import { createBlogDummyProvider } from './dummy-provider.mjs';
import { createBlogGithubSource } from './github-source.mjs';
import { blogDummyArtifact, createBlogDummyPayload } from './payload.mjs';
import { assertBlogDummyInvocation } from './policy.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
import { blogWorkerSdk } from './worker-source.ts';

interface WorkerContext {
  siteBaseline: Awaited<ReturnType<typeof readBlogSiteBaseline>>;
  schemaVersion: number;
  codeSha: string;
  runId: string;
  taskId: string;
  guard: { targetId: string; ownerRunId: string; fence: number; acquiredVersion: number };
  claim: ClaimedArticleRelease;
}
const command = process.argv[2];
if (!['prepare', 'deliver', 'cleanup'].includes(command ?? ''))
  throw new Error('Use prepare, deliver or cleanup');
const env = process.env;
const codeSha = env.GITHUB_SHA ?? '';
const policy = assertBlogDummyInvocation(env);
const taskId = env.BLOG_DUMMY_TASK_ID ?? '';
if (!/^release-[a-f0-9]{64}$/.test(taskId))
  throw new Error('Exact isolated article task ID required');
if (!/^[a-f0-9]{64}$/.test(env.BLOG_DUMMY_PERMISSION_HASH ?? ''))
  throw new Error('Reviewed dummy permission hash required');
const credentials = {
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID ?? '',
  secretKey: env.TENCENTCLOUD_SECRETKEY ?? '',
};
if (!credentials.secretId || !credentials.secretKey || !env.GITHUB_TOKEN)
  throw new Error('Scoped server credentials required');
const manager = new CloudBase(credentials);
const provider = createBlogDummyProvider(manager);
const invocation = await manager.functions.invokeFunction(policy.functionName, {
  action: 'health',
});
if (invocation.InvokeResult !== 0 || typeof invocation.RetMsg !== 'string')
  throw new Error('Isolated function health invocation failed');
const health = JSON.parse(invocation.RetMsg);
if (
  !health.ok ||
  health.data?.codeSha !== codeSha ||
  health.data?.envId !== policy.envId ||
  Date.parse(health.data?.expiresAt) <= Date.now()
)
  throw new Error('Isolated function code or active test window differs from this worker');
await provider.permissions(env.BLOG_DUMMY_PERMISSION_HASH);
const sdk = blogWorkerSdk({ ...credentials, env: policy.envId });
const db = createBlogDummyDatabase(sdk.database(), policy.envId);
const worker = createCloudBaseArticleReleaseWorker(db);
const coordinator = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({
    db: createBlogDummyControlDatabase(sdk.database(), policy.envId),
    envId: policy.envId,
  }),
  policy,
});
const github = createBlogGithubSource({ token: env.GITHUB_TOKEN });
await github.requireCI(env.GITHUB_SHA);
const directory = resolve('output/blog-dummy');
await mkdir(directory, { recursive: true });
const contextPath = join(directory, 'worker-context.json');
const runId = `blog-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
const owner = {
  ownerRunId: runId,
  runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}:dummy`,
};
const loadAccepted = async (run: {
  composition: { static: { artifact: { artifactId: string; runId: string } } };
  accepted: { seals: { static: unknown } };
}) => {
  const artifact = run.composition.static.artifact;
  const destination = join(directory, `accepted-${artifact.artifactId}`);
  // Each CLI phase has its own download; never trust a previous unverified extraction.
  await rm(destination, { recursive: true, force: true });
  const source = await github.download(artifact.artifactId, destination, {
    acceptedRunId: artifact.runId,
  });
  return blogDummyArtifact({
    directory: destination,
    run: source,
    acceptedSeal: run.accepted.seals.static,
  });
};
async function heartbeat(context: WorkerContext, action: () => Promise<void>) {
  let failure: unknown;
  let renewing = false;
  const interval = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      await coordinator.renew(context.guard);
      await worker.renew(context.claim.guard);
    } catch (error) {
      failure = error;
    } finally {
      renewing = false;
    }
  }, 30000);
  try {
    await action();
    if (failure) {
      const latest = await worker.latest(context.claim.task.actorId, context.claim.task.articleId);
      if (!latest || !['SUCCEEDED', 'FAILED'].includes(latest.state)) throw failure;
    }
  } finally {
    clearInterval(interval);
  }
}
if (command === 'prepare') {
  const uncertain = await db
    .collection('articleReleaseTasks')
    .where({ state: 'UNKNOWN' })
    .limit(1)
    .get();
  if (
    !uncertain ||
    !Array.isArray(Reflect.get(uncertain, 'data')) ||
    Reflect.get(uncertain, 'data').length
  )
    throw new Error('An isolated delivery needs a technical check first');
  const guard = await coordinator.acquire(owner);
  let claim: ClaimedArticleRelease | undefined;
  try {
    const claimed = await worker.claim(taskId, runId);
    claim = claimed;
    const context = {
      schemaVersion: 1,
      codeSha,
      runId,
      taskId,
      guard,
      claim: claimed,
      siteBaseline: await readBlogSiteBaseline(),
    };
    await writeFile(contextPath, JSON.stringify(context), { flag: 'wx', mode: 0o600 });
    await heartbeat(context, async () => {
      const status = await coordinator.status({ scopeKey: 'canary' });
      if (status.pendingStep || status.target.currentRunId || status.target.dirtyRunId)
        throw new Error('Isolated target is unresolved');
      const baseline = status.scope.baseline
        ? await loadAccepted(await coordinator.runStatus(status.scope.baseline.sourceRunId))
        : null;
      const accepted = await readAcceptedArticles(db);
      const input = articleReleaseBuildInput(claimed, accepted, policy.siteOrigin);
      const inputs = join(directory, 'input');
      await mkdir(inputs, { recursive: true });
      const inputFile = join(inputs, 'release.json');
      await writeFile(inputFile, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
      await writeBlogBuildAssets({
        db,
        sdk,
        input,
        directory: inputs,
        taskId,
        assertFileId: (id) => assertBlogDummyFileId(id, policy.envId),
      });
      await mkdir(resolve('apps/site/.astro'), { recursive: true });
      const buildRoot = await mkdtemp(resolve('apps/site/.astro/blog-dummy-'));
      try {
        await new Promise<void>((done, reject) => {
          const child = spawn(
            resolve('apps/site/node_modules/.bin/astro'),
            [
              'build',
              '--config',
              'astro.blog-dummy.config.ts',
              '--outDir',
              join(buildRoot, 'site'),
            ],
            {
              cwd: resolve('apps/site'),
              env: {
                ...env,
                SEO_BLOG_SNAPSHOT: '',
                SEO_BLOG_RELEASE_INPUT: inputFile,
                SEO_BLOG_TASK_ID: taskId,
              },
              stdio: 'inherit',
            },
          );
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? done() : reject(new Error('Candidate Astro build failed')),
          );
        });
        createBlogDummyPayload({
          buildDirectory: join(buildRoot, 'site'),
          directory: join(directory, 'payload'),
          configuration: await provider.readConfiguration(),
          codeSha,
          taskId,
          baseline,
        });
      } finally {
        await rm(buildRoot, { recursive: true, force: true });
      }
    });
    console.log('Task-bound Blog payload is ready. No hosting objects have been written.');
  } catch (error) {
    if (claim) await worker.failBuild(claim.guard);
    await coordinator.release(guard);
    throw error;
  }
} else {
  let context: WorkerContext;
  try {
    context = JSON.parse(await readFile(contextPath, 'utf8'));
  } catch {
    if (command === 'cleanup') process.exit(0);
    throw new Error('Prepared worker context missing');
  }
  if (context.codeSha !== env.GITHUB_SHA || context.runId !== runId || context.taskId !== taskId)
    throw new Error('Worker context invocation mismatch');
  if (command === 'cleanup') {
    const latest = await worker.latest(context.claim.task.actorId, context.claim.task.articleId);
    if (latest?.id === taskId && latest.state === 'BUILDING') {
      await worker.failBuild(context.claim.guard);
      await coordinator.release(context.guard);
    }
  } else {
    let deploying = false;
    await heartbeat(context, async () => {
      try {
        await worker.renew(context.claim.guard);
        await coordinator.renew(context.guard);
        const destination = join(directory, 'candidate-download');
        const source = await github.download(env.BLOG_DUMMY_ARTIFACT_ID, destination, {
          currentRunId: env.GITHUB_RUN_ID,
        });
        const input = blogDummyArtifact({ directory: destination, run: source });
        if (input.envelope.codeSha !== env.GITHUB_SHA)
          throw new Error('Artifact code differs from this worker');
        const compatibility = JSON.parse(
          await readFile(join(destination, 'compatibility.json'), 'utf8'),
        );
        if (compatibility.taskId !== taskId)
          throw new Error('Artifact belongs to another article task');
        await checkBlogSiteBaseline(context.siteBaseline);
        await worker.markDeploying(context.claim.guard);
        deploying = true;
        const result = await deliverBlogDummy({
          coordinator,
          provider,
          guard: context.guard,
          runId,
          input,
          loadAccepted,
          postCheck: async ({ action }: { action: string }) => {
            await checkBlogSiteBaseline(context.siteBaseline);
            if (env.BLOG_DUMMY_FAULT === 'after-upload' && action === 'publish')
              throw new Error('Authorized dummy recovery drill after verified upload');
          },
        });
        if (result.status === 'accepted' && result.receipt)
          await worker.complete(context.claim.guard, result.receipt);
        else if (result.status === 'restored' && result.receipt)
          await worker.restored(context.claim.guard, result.receipt);
        else if (result.status === 'not-written') await worker.notWritten(context.claim.guard);
        else await worker.markUnknown(context.claim.guard);
        await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), {
          flag: 'wx',
        });
        console.log(`Isolated Blog delivery result: ${result.status}`);
        if (result.status === 'unknown') throw new Error('Isolated delivery paused for readback');
      } catch (error) {
        if (deploying) {
          try {
            await worker.markUnknown(context.claim.guard);
          } catch {
            /* A confirmed terminal task must not be overwritten. */
          }
        }
        throw error;
      }
    });
  }
}
