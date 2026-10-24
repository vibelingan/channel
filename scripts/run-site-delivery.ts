import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { productPath } from '../apps/site/src/lib/seo/product-identity.ts';
import { prepareArticleBuild } from '../packages/articles/src/build.ts';
import { articleReleaseBuildInput } from '../packages/articles/src/release-build.ts';
import type { ClaimedArticleRelease } from '../packages/articles/src/release-store.ts';
import { writeBlogArticleAssets } from '../packages/db/src/article-build-assets.ts';
import { readAcceptedArticles } from '../packages/db/src/article-release-source.ts';
import { createCloudBaseArticleReleaseWorker } from '../packages/db/src/article-repository.ts';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { captureManagerHostingBackup } from './release/hosting-backup-reader.mjs';
import {
  assertPublicSiteDeliveryFiles,
  assertSameAcceptedBlog,
  filesFromHostingBackup,
  filesFromSiteBuild,
  ownedSitePaths,
  retainSiteAssets,
} from './release/site-files.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
import { assertSiteDeliveryInvocation } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { deliverStaticContent } from './release/static-delivery.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
interface SiteObjectEntry {
  path: string;
  bytes: number;
  sha256: string;
  objectVersion?: { etag: string; lastModified: string };
}
const env = process.env;
const policy = assertSiteDeliveryInvocation(env);
const codeSha = env.GITHUB_SHA ?? '';
if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY || !env.GITHUB_TOKEN)
  throw Error('Existing deployment credentials required');
const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
await github.requireCI(codeSha);
const manager = new CloudBase({
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const provider = createCanaryProvider({ manager, policy });
await provider.controlPlane({ execute: true });
const sdk = blogWorkerSdk({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const db = sdk.database();
const worker = createCloudBaseArticleReleaseWorker(db);
const coordinator = createReleaseCoordinator({
  store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
  policy,
});
let requestedTaskId = env.SITE_ARTICLE_TASK_ID ?? '';
if (env.SITE_DELIVERY_MODE === 'publish' && requestedTaskId === 'auto') {
  const uncertain = await db
    .collection('articleReleaseTasks')
    .where({ state: 'UNKNOWN' })
    .limit(1)
    .get();
  if (!Array.isArray(uncertain.data) || uncertain.data.length)
    throw Error('An earlier article publication requires readback');
  const queued = await db
    .collection('articleReleaseTasks')
    .where({ state: 'QUEUED' })
    .orderBy('createdAt', 'asc')
    .orderBy('_id', 'asc')
    .limit(1)
    .get();
  if (!Array.isArray(queued.data)) throw Error('Article queue read failed');
  requestedTaskId = queued.data[0]?._id ?? '';
  if (!requestedTaskId) {
    console.log('No queued articles. No site build, deployment lease or cloud writes.');
    process.exit(0);
  }
}
if (requestedTaskId && !/^release-[a-f0-9]{64}$/.test(requestedTaskId))
  throw Error('Invalid article task id');
const directory = resolve('output/site-delivery');
await mkdir(directory, { recursive: true });
const runId = `site-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
let guard = await coordinator.acquire({
  ownerRunId: runId,
  runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
});
let claim: ClaimedArticleRelease | undefined;
let deploying = false;
let failure: unknown;
let renewing = false;
const clock = setInterval(async () => {
  if (renewing) return;
  renewing = true;
  try {
    try {
      await coordinator.renew(guard);
    } catch (error) {
      const status = await coordinator.status({ scopeKey: 'site' }).catch(() => null);
      // Acceptance ends this lease; ignore only that confirmed handover.
      if (
        !status ||
        (status.target.lease && status.target.lease.ownerRunId !== runId) ||
        status.target.currentRunId ||
        status.target.dirtyRunId ||
        status.target.unresolvedOperation
      )
        throw error;
    }
    if (claim) await worker.renew(claim.guard);
  } catch (error) {
    failure = error;
  } finally {
    renewing = false;
  }
}, 30000);
const check = () => {
  if (failure) throw failure;
};
async function command(
  bin: string,
  args: string[],
  cwd = process.cwd(),
  extra: Record<string, string> = {},
) {
  check();
  await new Promise<void>((done, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error(`Site build/check failed (${code})`)),
    );
  });
  check();
}
const root = process.cwd();
const acceptedCache = new Map<string, ReturnType<typeof siteArtifact>>();
async function loadAccepted(run: {
  composition: { static: { artifact: { artifactId: string; runId: string } } };
  accepted: { seals: { static: unknown } };
}) {
  const artifact = run.composition.static.artifact;
  const cached = acceptedCache.get(artifact.artifactId);
  if (cached) {
    assert.deepEqual(cached.acceptedSeal, run.accepted.seals.static);
    return cached;
  }
  const destination = join(directory, `accepted-${artifact.artifactId}`);
  const source = await github.download(artifact.artifactId, destination, {
    acceptedRunId: artifact.runId,
  });
  const input = siteArtifact({
    directory: destination,
    policy,
    run: source,
    acceptedSeal: run.accepted.seals.static,
  });
  acceptedCache.set(artifact.artifactId, input);
  return input;
}
async function archivePayload(payload: string, prefix: string) {
  const files: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
      else throw Error('Non-file archive member');
    }
  }
  await walk(payload);
  check();
  const artifact = await new DefaultArtifactClient().uploadArtifact(
    `${prefix}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    files,
    payload,
    { retentionDays: 90 },
  );
  if (!artifact.id || !artifact.digest) throw Error('Static artifact was not durably archived');
  const destination = `${payload}-download`;
  const run = await github.download(String(artifact.id), destination, {
    currentRunId: env.GITHUB_RUN_ID,
  });
  check();
  return siteArtifact({ directory: destination, policy, run });
}
try {
  const status = await coordinator.status({ scopeKey: 'site' });
  if (status.pendingStep || status.target.currentRunId || status.target.dirtyRunId)
    throw Error('An earlier delivery requires readback before another publication');
  let baseline = status.scope.baseline
    ? await loadAccepted(await coordinator.runStatus(status.scope.baseline.sourceRunId))
    : null;
  const productFile = join(directory, 'product-snapshot.json');
  let pathRead = 0;
  const readPublicProductPaths = async () => {
    const output = join(directory, `public-paths-${++pathRead}.json`);
    await command(
      join(root, 'apps/site/node_modules/.bin/tsx'),
      ['apps/site/scripts/prepare-product-public-paths.ts', output],
      root,
      { SITE_URL: policy.siteOrigin, SEO_CATALOG_API_ORIGIN: policy.siteOrigin },
    );
    const paths = JSON.parse(await readFile(output, 'utf8'));
    assert(
      Array.isArray(paths) &&
        paths.every((p) => typeof p === 'string' && /^\/products\/p-[A-Za-z0-9_-]+\/$/.test(p)),
    );
    return paths;
  };
  const publicProductPaths = await readPublicProductPaths();
  if (!baseline) {
    if (env.SITE_DELIVERY_MODE === 'restore') throw Error('No accepted site version exists');
    check();
    const backupPath = join(directory, 'before');
    const backup = await captureManagerHostingBackup({
      provider,
      target: provider.target,
      output: backupPath,
    });
    const beforeInventory = JSON.parse(
      await readFile(join(backupPath, 'inventory-before.json'), 'utf8'),
    );
    const objectProofs = backup.entries.map((e) => ({
      ...e,
      ...beforeInventory.entries.find((p: { path: string }) => p.path === e.path),
    }));
    const payload = join(directory, 'baseline');
    createSitePayload({
      directory: payload,
      policy,
      configuration: backup.configuration,
      codeSha,
      releaseId: `${runId}-baseline`,
      objectProofs,
      files: filesFromHostingBackup(backup, join(backupPath, 'files')),
      snapshot: {
        siteOrigin: policy.siteOrigin,
        purpose: 'legacy-public-inventory',
        capture: 'existing-site-before-first-release',
      },
    });
    const input = await archivePayload(payload, 'site-baseline');
    input.ownedPaths = ownedSitePaths(input, null);
    const adopted = await deliverStaticContent(
      {
        coordinator,
        provider,
        guard,
        runId: `${runId}-baseline`,
        input,
        loadAccepted,
        mode: 'adopt',
        publicProductPaths,
        readPublicProductPaths,
        onStop: (phase: string, error: Error) => console.error(`Site ${phase}: ${error.message}`),
      },
      { policy, scopeKey: 'site' },
    );
    if (adopted.status !== 'accepted')
      throw Error('Current site could not be accepted without writes');
    // commitRun ends its lease. Acquire a new fence before publishing B.
    const next = await coordinator.acquire({
      ownerRunId: runId,
      runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
    });
    guard = next;
    const accepted = await coordinator.status({ scopeKey: 'site' });
    baseline = await loadAccepted(await coordinator.runStatus(accepted.scope.baseline.sourceRunId));
  }
  if (env.SITE_DELIVERY_MODE === 'restore') {
    const sourceRunId = env.SITE_RESTORE_RUN_ID ?? '';
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(sourceRunId))
      throw Error('Exact accepted site run required');
    const target = await loadAccepted(await coordinator.runStatus(sourceRunId));
    assertSameAcceptedBlog(target, baseline);
    target.ownedPaths = ownedSitePaths(target, baseline);
    const result = await deliverStaticContent(
      {
        coordinator,
        provider,
        guard,
        runId,
        input: target,
        loadAccepted,
        mode: 'restore',
        restoreRunId: sourceRunId,
        publicProductPaths,
        readPublicProductPaths,
        onStop: (phase: string, error: Error) => console.error(`Site ${phase}: ${error.message}`),
      },
      { policy, scopeKey: 'site' },
    );
    await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), {
      flag: 'wx',
    });
    if (result.status !== 'accepted') throw Error(`Site restore: ${result.status}`);
  } else {
    const uncertain = await db
      .collection('articleReleaseTasks')
      .where({ state: 'UNKNOWN' })
      .limit(1)
      .get();
    if (!Array.isArray(uncertain.data) || uncertain.data.length)
      throw Error('An article publication requires technical readback first');
    if (requestedTaskId) claim = await worker.claim(requestedTaskId, runId);
    await command(
      join(root, 'apps/site/node_modules/.bin/tsx'),
      ['apps/site/scripts/prepare-product-seo.ts', productFile],
      root,
      { SITE_URL: policy.siteOrigin, SEO_CATALOG_API_ORIGIN: policy.siteOrigin },
    );
    const products = JSON.parse(await readFile(productFile, 'utf8'));
    assert(Array.isArray(products.products));
    const snapshotPaths = products.products.map((p: { product: { _id: string } }) =>
      productPath(p.product._id),
    );
    const accepted = await readAcceptedArticles(db);
    const blogDir = join(directory, 'blog');
    await mkdir(blogDir);
    const input = claim ? articleReleaseBuildInput(claim, accepted, policy.siteOrigin) : null;
    const articles = claim && input ? prepareArticleBuild(input.release, claim.task.id) : accepted;
    const assertFileId = (id: string) => {
      if (!id.startsWith(`cloud://${policy.envId}.`) || !id.includes('/articles/'))
        throw Error('Foreign Blog media');
    };
    await writeBlogArticleAssets({ db, sdk, articles, directory: blogDir, assertFileId });
    const blogFile = join(blogDir, claim ? 'release.json' : 'snapshot.json');
    await writeFile(
      blogFile,
      JSON.stringify(
        input ?? {
          schemaVersion: 1,
          purpose: 'public',
          siteOrigin: policy.siteOrigin,
          total: articles.length,
          articles,
        },
      ),
      { flag: 'wx' },
    );
    const dist = join(root, 'apps/site/.astro/formal-site-delivery/site');
    await command(
      join(root, 'apps/site/node_modules/.bin/astro'),
      ['build', '--outDir', dist],
      join(root, 'apps/site'),
      {
        SEO_CATALOG_SNAPSHOT: productFile,
        SEO_BLOG_SNAPSHOT: claim ? '' : blogFile,
        SEO_BLOG_RELEASE_INPUT: claim ? blogFile : '',
        SEO_BLOG_TASK_ID: claim?.task.id ?? '',
        PUBLIC_BLOG_WORKSPACE: '0',
      },
    );
    const files = retainSiteAssets(filesFromSiteBuild(dist), baseline);
    assertPublicSiteDeliveryFiles(files, env.PUBLIC_AI_API_BASE_URL);
    const payload = join(directory, 'candidate');
    createSitePayload({
      directory: payload,
      policy,
      configuration: await provider.readConfiguration(),
      codeSha,
      releaseId: runId,
      files,
      snapshot: products,
      objectProofs: baseline.staticManifest.entries.flatMap((e: SiteObjectEntry) =>
        e.objectVersion ? [{ ...e, ...e.objectVersion }] : [],
      ),
    });
    const candidate = await archivePayload(payload, 'site-payload');
    candidate.ownedPaths = ownedSitePaths(candidate, baseline);
    check();
    assert.deepEqual(
      (await readPublicProductPaths()).sort(),
      snapshotPaths.sort(),
      'Public inventory changed during the build; no candidate upload started',
    );
    if (claim) {
      await worker.markDeploying(claim.guard);
      deploying = true;
    }
    const result = await deliverStaticContent(
      {
        coordinator,
        provider,
        guard,
        runId,
        input: candidate,
        loadAccepted,
        publicProductPaths,
        readPublicProductPaths,
        onStop: (phase: string, error: Error) => console.error(`Site ${phase}: ${error.message}`),
      },
      { policy, scopeKey: 'site' },
    );
    if (claim) {
      if (result.status === 'accepted' && result.receipt)
        await worker.complete(claim.guard, result.receipt);
      else if (result.status === 'restored' && result.receipt)
        await worker.restored(claim.guard, result.receipt);
      else if (result.status === 'not-written') await worker.notWritten(claim.guard);
      else await worker.markUnknown(claim.guard);
    }
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        { ...result, articleTaskId: claim?.task.id ?? null, products: publicProductPaths.length },
        null,
        2,
      ),
      { flag: 'wx' },
    );
    if (result.status !== 'accepted') throw Error(`Site publication: ${result.status}`);
  }
} catch (error) {
  if (claim) {
    try {
      if (deploying) await worker.markUnknown(claim.guard);
      else await worker.failBuild(claim.guard);
    } catch {}
  }
  try {
    await coordinator.release(guard);
  } catch {}
  throw error;
} finally {
  clearInterval(clock);
}
