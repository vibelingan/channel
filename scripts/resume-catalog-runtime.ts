import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import CloudBase from '@cloudbase/manager-node';
import { createCatalogSeoStore } from '../packages/db/src/catalog-seo-cloud.ts';
import { readFunctionRuntimeState } from './blog/runtime-health.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './blog/site-baseline.mjs';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { requireFunctionSourceAncestor } from './images/source-ancestry.mjs';
import { assertInitialCatalogRuntime } from './release/catalog-runtime-activation.mjs';
import { setCatalogRuntimeFlags } from './release/catalog-runtime-config.mjs';
import { settleCatalogRuntimeRecovery } from './release/catalog-runtime-recovery.mjs';
import {
  assertCatalogRecoveryInvocation,
  assertRecoveredCatalogSite,
  createCatalogRecoveryRecords,
  enableRecoveredCatalogReadiness,
  resumeCatalogWriters,
} from './release/catalog-runtime-resume.mjs';
import { identity } from './release/input.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { assertCleanAcceptedSite, SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
import { fetchFully } from './smoke-http.mjs';

const env = process.env;
let stage = 'invocation';
const directory = resolve('output/catalog-runtime');
async function main() {
  const source = assertCatalogRecoveryInvocation(env, policy);
  if (!env.GITHUB_TOKEN || !env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY)
    throw Error('Explicit recovery credentials required');
  stage = 'checked-source';
  await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(source.executorSha);
  const target = { envId: policy.envId, region: policy.region, siteOrigin: policy.siteOrigin };
  const config = {
    env: policy.envId,
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  };
  const manager = new CloudBase(config);
  const db = blogWorkerSdk(config).database();
  const store = createCatalogSeoStore(db);
  const records = createCatalogRecoveryRecords(store, source.executorSha);
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const baseline = assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
  const website = await readBlogSiteBaseline();
  const assertWebsiteUnchanged = async () => {
    const current = assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
    if (identity(current) !== identity(baseline))
      throw Error('Accepted website changed during recovery');
    await checkBlogSiteBaseline(website);
  };
  const assertClockStopped = async () => {
    const detail = await manager.functions.getFunctionDetail('catalog-seo-clock');
    const flags = detail.Environment?.Variables ?? [];
    if (
      detail.FunctionName !== 'catalog-seo-clock' ||
      detail.Namespace !== policy.envId ||
      detail.Description !== 'channel-catalog-seo-clock-v1' ||
      detail.Status !== 'Active' ||
      Reflect.get(detail, 'AvailableStatus') !== 'Available' ||
      flags.filter((v) => v.Key === 'CATALOG_SEO_CLOCK_ENABLED').length !== 1 ||
      flags.find((v) => v.Key === 'CATALOG_SEO_CLOCK_ENABLED')?.Value !== '0'
    )
      throw Error('Stop the owned catalog clock before recovering writer settings');
  };
  const readFunctions = async () =>
    Object.fromEntries(
      await Promise.all(
        ['admin', 'alibaba-catalog-sync', 'public-api'].map(async (name) => {
          const [detail, health] = await Promise.all([
            manager.functions.getFunctionDetail(name),
            readFunctionRuntimeState(policy.envId, name, async (method, url, options) => {
              const response = await fetchFully(method, url, {
                ...options,
                timeoutMs: 15000,
                maxBytes: 16384,
              });
              const payload = JSON.parse(response.body.toString());
              const flag =
                name === 'public-api' ? 'catalogSeoPageReadiness' : 'catalogSeoRecording';
              if (typeof payload.data?.[flag] !== 'boolean')
                throw Error('Running source does not report the catalog capability');
              return response;
            }),
          ]);
          return [name, { detail, health }];
        }),
      ),
    );
  const key = createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
    .update(`catalog-writer-recovery:v1:${policy.envId}:${policy.siteOrigin}`)
    .digest();
  const fingerprint = (value: object) => {
    const candidate = structuredClone(value);
    const environment = Reflect.get(candidate, 'Environment');
    if (environment?.Variables)
      environment.Variables.sort((a: { Key: string }, b: { Key: string }) =>
        a.Key.localeCompare(b.Key),
      );
    return createHmac('sha256', key).update(identity(candidate)).digest('hex');
  };
  const report = (event: { stage: string }) => {
    stage = event.stage;
    console.log(JSON.stringify({ operation: 'catalog-runtime-recovery', ...event }));
  };
  await mkdir(directory, { recursive: true });
  const shared = {
    target,
    ...source,
    records,
    beforeAcceptedSite: baseline,
    readFunctions,
    assertClockStopped,
    assertWebsiteUnchanged,
    requireAncestor: ({ beforeVersion, sourceSha }: { beforeVersion: string; sourceSha: string }) =>
      requireFunctionSourceAncestor({ beforeVersion, sourceSha, token: env.GITHUB_TOKEN }),
    fingerprint,
    setFlags: ({ name, phase, before }: { name: string; phase: string; before: object }) =>
      setCatalogRuntimeFlags({ manager, target, name, phase, before }),
  };
  stage = env.CATALOG_RUNTIME_ACTION ?? 'unknown';
  const result =
    env.CATALOG_RUNTIME_ACTION === 'resume'
      ? await resumeCatalogWriters({ ...shared, settle: settleCatalogRuntimeRecovery, report })
      : await enableRecoveredCatalogReadiness({
          ...shared,
          assertRecoveryProof: assertInitialCatalogRuntime,
          assertAcceptedProgram: async ({
            preparation,
            proof,
          }: {
            preparation: {
              beforeAcceptedSite: {
                activationId: string;
                sourceRunId: string;
                compositionHash: string;
              };
            };
            proof: { acceptedAt: number };
          }) => {
            const status = await coordinator.status({ scopeKey: 'site' });
            const current = assertCleanAcceptedSite(status);
            const run = await coordinator.runStatus(current.sourceRunId);
            const active = await store.get('catalogSeoBuilders', 'active');
            const approved =
              active && typeof active.codeSha === 'string'
                ? await store.get('catalogSeoBuilders', active.codeSha)
                : null;
            assertRecoveredCatalogSite({
              beforeAcceptedSite: preparation.beforeAcceptedSite,
              status,
              run,
              active,
              approved,
              proof,
              executorSha: source.executorSha,
              target,
            });
          },
        });
  await writeFile(
    resolve(directory, 'receipt.json'),
    JSON.stringify({ ...result, clockEnabled: false }, null, 2),
  );
  console.log(
    JSON.stringify({
      phase: result.phase,
      source: source.executorSha,
      websiteWrites: 0,
      businessWrites: 0,
      functionCodeWrites: 0,
      clockEnabled: false,
    }),
  );
}
main().catch(async (error: unknown) => {
  await mkdir(directory, { recursive: true });
  const code =
    error &&
    typeof error === 'object' &&
    typeof Reflect.get(error, 'code') === 'string' &&
    /^[A-Z_]{1,64}$/.test(Reflect.get(error, 'code'))
      ? Reflect.get(error, 'code')
      : 'RECOVERY_STOPPED';
  const stopped = { stage, code, status: 'stopped', clockState: 'not-changed-by-this-entry' };
  await writeFile(resolve(directory, 'progress.json'), JSON.stringify(stopped, null, 2));
  console.error(JSON.stringify(stopped));
  process.exitCode = 1;
});
