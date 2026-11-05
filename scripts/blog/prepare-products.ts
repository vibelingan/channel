import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { catalogRegionalRequestHash } from '../../packages/db/src/catalog-seo-regional.ts';
import { readCatalogSeoRecordingConfig } from '../../packages/db/src/catalog-seo-requests.ts';
import { sealCatalogBuildInput, versionFreshCatalogBuildSnapshot } from '../catalog-build-input.ts';
import { captureCatalogRegionalInput } from '../catalog-regional-capture.mjs';
import { createCatalogRegionalClient } from '../catalog-regional-client.mjs';
import { createReleaseRegionalClient } from '../release-regional-client.mjs';
import { assertInitialCatalogRuntime } from '../release/catalog-runtime-activation.mjs';
import { checkCatalogRuntimeFlags } from '../release/catalog-runtime-flags.mjs';
import { publicBuildEnvironment } from '../release/public-build-env.mjs';
import { createSiteGithubSource } from '../release/site-github-source.mjs';
import { siteArtifact } from '../release/site-payload.mjs';
import { assertCleanAcceptedSite, assertSiteDeliveryInvocation } from '../release/site-policy.mjs';
import { createCloudbaseReleaseDatabase } from '../release/store-cloudbase.mjs';
import { readFunctionRuntimeState } from './runtime-health.mjs';
export async function prepareProducts(env = process.env) {
  const policy = assertSiteDeliveryInvocation(env);
  if (
    env.GITHUB_REF !== 'refs/heads/test' ||
    env.SITE_DELIVERY_BUILT_INPUT !== '1' ||
    !env.GITHUB_TOKEN
  )
    throw Error('Explicit normal test snapshot preparation required');
  const source = env.SITE_PRODUCT_SOURCE ?? 'fresh';
  assert(source === 'fresh' || source === 'accepted', 'Explicit product source required');
  const output = resolve('output/seo-release');
  await mkdir(output, { recursive: true });
  const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
  await github.requireCI(env.GITHUB_SHA, {
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  });
  if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY)
    throw Error('Existing target-bound deployment credentials required');
  const db = createCloudbaseReleaseDatabase({
    env: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  });
  const catalogConfig = readCatalogSeoRecordingConfig(env);
  const manager = new CloudBase({
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  });
  const runId = `site-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const runnerRef = `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`;
  await withProductReleaseCoordinator({
    createClient: () =>
      createReleaseRegionalClient({
        manager,
        policy,
        ownerRunId: runId,
        runnerRef,
        codeSha: env.GITHUB_SHA,
        directory: resolve(output, 'release-regional'),
      }),
    prepare: async (coordinator) => {
      const status = await coordinator.status({ scopeKey: 'site' });
      assertCleanAcceptedSite(status);
      if (catalogConfig) {
        await checkCatalogRuntimeFlags(manager, catalogConfig, policy.envId);
        const activation = await db
          .collection('catalogSeoBuilders')
          .doc('runtime-activation')
          .get();
        assertInitialCatalogRuntime(
          Array.isArray(activation.data) ? activation.data[0] : activation.data,
          policy.siteOrigin,
        );
        for (const name of ['admin', 'alibaba-catalog-sync'])
          assert(
            (await readFunctionRuntimeState(policy.envId, name)).catalogSeoRecording,
            'Actual product writer has not enabled change recording',
          );
      }
      async function command(args: string[]) {
        await new Promise<void>((done, reject) => {
          const child = spawn(resolve('apps/site/node_modules/.bin/tsx'), args, {
            env: publicBuildEnvironment(env),
            stdio: 'inherit',
          });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? done() : reject(Error('Public snapshot preparation stopped')),
          );
        });
      }
      async function collectSnapshot(baseline: { sourceRunId: string }) {
        let receipt: Record<string, unknown> = { source };
        if (source === 'fresh') {
          await command([
            'apps/site/scripts/prepare-product-seo.ts',
            resolve(output, 'product-snapshot.json'),
          ]);
          return receipt;
        }
        const accepted = await coordinator.runStatus(baseline.sourceRunId);
        assert.equal(accepted.state, 'SUCCEEDED');
        const artifact = accepted.composition.static.artifact;
        const directory = resolve(output, 'product-reuse-source');
        const run = await github.download(artifact.artifactId, directory, {
          acceptedRunId: artifact.runId,
        });
        const verified = siteArtifact({
          directory,
          policy,
          run,
          acceptedSeal: accepted.accepted.seals.static,
        });
        const paths = resolve(output, 'product-current-paths.json');
        await command(['apps/site/scripts/prepare-product-public-paths.ts', paths]);
        await command([
          'apps/site/scripts/reuse-product-seo.ts',
          resolve(verified.directory, 'product-snapshot.json'),
          paths,
          resolve(output, 'product-snapshot.json'),
        ]);
        receipt = { source, acceptedSiteRunId: accepted.runId, artifactId: artifact.artifactId };
        return receipt;
      }
      const captured = catalogConfig
        ? await captureCatalogRegionalInput({
            coordinator,
            owner: { ownerRunId: runId, runnerRef },
            config: catalogConfig,
            createClient: (
              guard: object,
              { withLease }: { withLease: (operation: () => Promise<unknown>) => Promise<unknown> },
            ) =>
              createCatalogRegionalClient({
                manager,
                policy,
                runId,
                codeSha: env.GITHUB_SHA,
                runnerRef,
                guard,
                directory: resolve(output, 'regional'),
                requestHash: catalogRegionalRequestHash,
                withLease,
              }),
            collect: ({ baseline }: { baseline: { sourceRunId: string } }) =>
              collectSnapshot(baseline),
          })
        : null;
      const receipt: Record<string, unknown> = captured
        ? captured.value
        : await collectSnapshot(status.scope.baseline);
      if (catalogConfig && captured) {
        const capture: Parameters<typeof sealCatalogBuildInput>[0] = {
          config: catalogConfig,
          source,
          before: captured.before,
          after: captured.after,
          snapshot: await readFile(resolve(output, 'product-snapshot.json')),
        };
        if (source === 'fresh') {
          capture.snapshot = versionFreshCatalogBuildSnapshot(capture);
          await writeFile(resolve(output, 'product-snapshot.json'), capture.snapshot);
        }
        receipt.catalog = sealCatalogBuildInput(capture);
      }
      await writeFile(resolve(output, 'product-source.json'), JSON.stringify(receipt, null, 2), {
        flag: 'wx',
      });
    },
  });
  console.log(`Prepared the complete public product input using explicit ${source} mode.`);
}

type ProductReleaseClient = Awaited<ReturnType<typeof createReleaseRegionalClient>>;

/** The capture owns its lease; keep its coordinator alive until capture cleanup has finished. */
export async function withProductReleaseCoordinator<T>({
  createClient,
  prepare,
}: {
  createClient: () => Promise<ProductReleaseClient>;
  prepare: (coordinator: ProductReleaseClient['coordinator']) => Promise<T>;
}): Promise<T> {
  const regional = await createClient();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    outcome = { ok: true, value: await prepare(regional.coordinator) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    try {
      const closed = await regional.close();
      assert.equal(closed.cleaned, true);
      assert.equal(closed.unconfirmed, false);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }
  if (cleanupFailed) {
    const message = 'Product preparation release helper requires readback';
    throw Object.assign(
      outcome.ok
        ? new Error(message, { cause: cleanupFailure })
        : new AggregateError([outcome.error, cleanupFailure], message, {
            cause: outcome.error,
          }),
      { code: 'RELEASE_REGIONAL_UNCONFIRMED' },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareProducts();
