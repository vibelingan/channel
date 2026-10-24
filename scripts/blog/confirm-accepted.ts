import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import {
  createBlogDummyControlDatabase,
  createBlogDummyDatabase,
} from '../../packages/db/src/article-dummy.ts';
import { createCloudBaseArticleReleaseWorker } from '../../packages/db/src/article-repository.ts';
import { configurationStateHash } from '../release/hosting-configuration.mjs';
import { verifyHostingObject } from '../release/hosting-readback.mjs';
import { identity, sha256 } from '../release/input.mjs';
import { createReleaseCoordinator } from '../release/state.mjs';
import { createCloudbaseReleaseStore } from '../release/store-cloudbase.mjs';
import { createBlogDummyProvider } from './dummy-provider.mjs';
import { blogGh, downloadAcceptedBlogArtifact } from './github-cli-source.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { blogDummyArtifact } from './payload.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
import { blogWorkerSdk } from './worker-source.ts';
const command = process.argv[2];
if (!['plan', 'confirm'].includes(command ?? '') || !process.env.BLOG_DUMMY_PRIVATE_DIR)
  throw new Error('Explicit isolated confirmation command and private directory required');
const directory = resolve(process.env.BLOG_DUMMY_PRIVATE_DIR);
if (directory.startsWith(`${process.cwd()}/`))
  throw new Error('Confirmation record must remain outside the checkout');
const file = join(directory, 'accepted-confirmation-plan.json');
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new Error('Exact isolated identity required');
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed isolated record');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid isolated sequence');
  return value;
}
const taskId = identifier(process.env.BLOG_DUMMY_TASK_ID, /^release-[a-f0-9]{64}$/);
const sourceId = identifier(
  process.env.BLOG_DUMMY_ACCEPTED_RUN_ID,
  /^blog-[1-9][0-9]*-[1-9][0-9]*$/,
);
const mcp = await connectBlogMcp();
try {
  const temporary = await mcp.call('auth', {
    action: 'get_temp_credentials',
    confirm: 'yes',
    reveal: true,
  });
  if (temporary.credentials?.masked !== false)
    throw new Error('Current management connection must provide reviewed temporary credentials');
  const credentials = { envId: policy.envId, region: policy.region, ...temporary.credentials };
  const manager = new CloudBase(credentials);
  const provider = createBlogDummyProvider(manager);
  const sdk = blogWorkerSdk({
    ...credentials,
    env: policy.envId,
    sessionToken: temporary.credentials.token,
  });
  const db = createBlogDummyDatabase(sdk.database(), policy.envId);
  const worker = createCloudBaseArticleReleaseWorker(db);
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({
      db: createBlogDummyControlDatabase(sdk.database(), policy.envId),
      envId: policy.envId,
    }),
    policy,
  });
  async function inspect() {
    const status = await coordinator.status({ scopeKey: 'canary' });
    if (
      status.pendingStep ||
      status.target.currentRunId ||
      status.target.dirtyRunId ||
      status.scope.baseline?.sourceRunId !== sourceId
    )
      throw new Error('Current accepted Blog delivery differs or is unresolved');
    const run = await coordinator.runStatus(sourceId);
    if (
      run.state !== 'SUCCEEDED' ||
      run.scopeKey !== 'canary' ||
      run.accepted?.sourceRunId !== sourceId
    )
      throw new Error('Only an accepted isolated delivery can confirm a task');
    const archive = join(await mkdtemp(join(directory, 'confirm-artifact-')), 'payload');
    const artifact = run.composition.static.artifact;
    const source = downloadAcceptedBlogArtifact(artifact.artifactId, archive, artifact.runId);
    const payload = blogDummyArtifact({
      directory: archive,
      run: source,
      acceptedSeal: run.accepted.seals.static,
    });
    const compatibility = JSON.parse(await readFile(join(archive, 'compatibility.json'), 'utf8'));
    if (compatibility.taskId !== taskId)
      throw new Error('Accepted artifact belongs to another task');
    const taskResult = await db.runTransaction((transaction) =>
      transaction.collection('articleReleaseTasks').doc(taskId).get(),
    );
    const raw = record(record(taskResult).data);
    if (
      raw.id !== taskId ||
      raw.workerId !== sourceId ||
      !['UNKNOWN', 'SUCCEEDED'].includes(String(raw.state))
    )
      throw new Error('Only this exact uncertain task can be confirmed');
    const task = {
      articleId: identifier(raw.articleId, /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
      actorId: identifier(raw.actorId, /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/),
      workerId: sourceId,
      attempt: positive(raw.attempt),
      revision: positive(raw.revision),
      leaseUntil: positive(raw.leaseUntil),
    };
    if (raw.state === 'UNKNOWN' && task.leaseUntil > Date.now())
      throw new Error('The previous worker lease has not expired');
    const receipt = {
      deliveryId: sourceId,
      artifactHash: run.composition.static.contentSha256,
      acceptedAt: new Date(run.accepted.acceptedAt).toISOString(),
    };
    if (raw.state === 'SUCCEEDED' && identity(raw.receipt) !== identity(receipt))
      throw new Error('The completed task has different acceptance evidence');
    const owned = await provider.inventory(policy.canaryPrefix);
    if (
      identity(owned.sort()) !==
      identity(payload.staticManifest.entries.map((entry: { path: string }) => entry.path).sort())
    )
      throw new Error('Isolated hosting inventory changed');
    for (const entry of payload.staticManifest.entries)
      await verifyHostingObject({
        target: provider.target,
        entry,
        signal: AbortSignal.timeout(30000),
      });
    const configurationBefore = await provider.readConfiguration();
    if (
      configurationStateHash(configurationBefore) !==
      configurationStateHash(payload.staticManifest.configuration)
    )
      throw new Error('Hosting configuration differs from the accepted source');
    return {
      schemaVersion: 1,
      target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
      purpose: 'confirm-isolated-accepted-task',
      codeSha,
      taskId,
      sourceId,
      configurationBefore,
      baseline: await readBlogSiteBaseline(),
      task: { articleId: task.articleId, actorId: task.actorId, revision: task.revision },
      guard: { taskId, workerId: task.workerId, attempt: task.attempt },
      receipt,
      artifactId: artifact.artifactId,
      permissionHash: await provider.permissions(),
    };
  }
  if (command === 'plan') {
    const record = await inspect();
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    console.log(
      JSON.stringify({
        codeSha,
        taskId,
        sourceId,
        artifactId: record.artifactId,
        verified: true,
        writes: 'none',
      }),
    );
  } else {
    const reviewed = JSON.parse(await readFile(file, 'utf8'));
    if (
      reviewed.codeSha !== codeSha ||
      reviewed.taskId !== taskId ||
      reviewed.sourceId !== sourceId
    )
      throw new Error('Confirmation record belongs to another code or task');
    if (process.env.BLOG_DUMMY_CONFIRM_ACCEPTED !== 'CONFIRM_VERIFIED_BLOG_TASK')
      throw new Error('Explicit metadata-only confirmation required');
    execFileSync(
      'git',
      [
        'ls-files',
        '--error-unmatch',
        '--',
        'scripts/blog/confirm-accepted.ts',
        'scripts/blog/github-cli-source.mjs',
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['diff', '--quiet', 'HEAD', '--', 'packages', 'scripts', 'apps/functions/admin'],
      { stdio: 'pipe' },
    );
    const runs = blogGh([
      'run',
      'list',
      '--repo',
      policy.repository,
      '--branch',
      'feat/seo-foundation',
      '--commit',
      codeSha,
      '--limit',
      '10',
      '--json',
      'workflowName,status,conclusion',
    ]);
    if (
      !runs.some(
        (run: { workflowName: string; status: string; conclusion: string }) =>
          run.workflowName === 'SEO module 01 (offline)' &&
          run.status === 'completed' &&
          run.conclusion === 'success',
      )
    )
      throw new Error('Current reviewed code has not passed full CI');
    if (
      !runs.some(
        (run: { workflowName: string; status: string; conclusion: string }) =>
          run.workflowName === 'SEO Blog isolated dummy' &&
          run.status === 'completed' &&
          run.conclusion === 'success',
      )
    )
      throw new Error('Current reviewed code has not passed the Blog integration CI');
    const guard = await coordinator.acquire({
      ownerRunId: `confirm-${codeSha.slice(0, 16)}-${taskId.slice(-16)}`,
      runnerRef: `operator:${codeSha}:${taskId}`,
    });
    let renewalFailure: unknown;
    let renewal: Promise<unknown> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() => coordinator.renew(guard))
        .catch((error: unknown) => {
          renewalFailure = error;
        });
    }, 30000);
    try {
      const actual = await inspect();
      await renewal;
      if (renewalFailure) throw renewalFailure;
      if (identity(actual) !== identity(reviewed))
        throw new Error('Accepted evidence or target changed after review');
      await checkBlogSiteBaseline(reviewed.baseline);
      await coordinator.renew(guard);
      const task = await worker.confirmAccepted(reviewed.guard, reviewed.receipt);
      await writeFile(
        join(directory, 'accepted-confirmation-result.json'),
        JSON.stringify({
          task,
          receipt: reviewed.receipt,
          sourceId,
          artifactId: reviewed.artifactId,
          codeSha,
        }),
        { mode: 0o600 },
      );
      console.log(
        `Confirmed the exact accepted task: ${task.id}, ${task.state}. No hosting objects were changed.`,
      );
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await coordinator.release(guard);
    }
  }
} finally {
  await mcp.close();
}
