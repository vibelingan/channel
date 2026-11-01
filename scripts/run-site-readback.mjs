import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { createCatalogRegionalClient } from './catalog-regional-client.mjs';
import { planSiteReleaseCandidate } from './hosting-recovery.mjs';
import { createCanaryProvider } from './release/canary-provider.mjs';
import { activateCatalogRenderer } from './release/catalog-activation.mjs';
import {
  completeCatalogRegistration,
  releaseStoppedCatalogRegistration,
} from './release/catalog-registration.mjs';
import { checkCatalogRuntimeFlags } from './release/catalog-runtime-flags.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { identity, readJson, readObject, sha256 } from './release/input.mjs';
import { createExclusiveLeaseHeartbeat } from './release/lease-heartbeat.mjs';
import { publicBuildEnvironment } from './release/public-build-env.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { siteArtifact } from './release/site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { siteProducerPolicy } from './release/site-producers.mjs';
import { siteReadbackEvidence, verifySiteReadback } from './release/site-readback.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import {
  createCloudbaseReleaseDatabase,
  createCloudbaseReleaseStore,
} from './release/store-cloudbase.mjs';
const { require: tsxRequire } = createRequire(
  new URL('../apps/site/package.json', import.meta.url),
)('tsx/cjs/api');
const { createCatalogAcceptanceProof, finishCatalogAcceptance } = tsxRequire(
  './catalog-acceptance.ts',
  import.meta.url,
);
const { createCatalogSeoStore } = tsxRequire(
  '../packages/db/src/catalog-seo-cloud.ts',
  import.meta.url,
);
const { catalogRegionalRequestHash } = tsxRequire(
  '../packages/db/src/catalog-seo-regional.ts',
  import.meta.url,
);

/** Preserve the original delivery identity while a separate readback runner owns its lease. */
export function createReadbackRegionalAccess({
  manager,
  runId,
  codeSha,
  owner,
  directory,
  createClient = createCatalogRegionalClient,
  schedule = setInterval,
  cancel = clearInterval,
  now = () => performance.now(),
}) {
  let client;
  let heartbeat;
  const drain = async () => {
    await heartbeat?.stop();
  };
  return {
    async use(guard, checkpoint = async () => {}) {
      assert.equal(guard.ownerRunId, owner.ownerRunId, 'Readback guard belongs to another owner');
      await drain();
      heartbeat?.check();
      heartbeat = createExclusiveLeaseHeartbeat({ renew: checkpoint, schedule, cancel, now });
      try {
        await heartbeat.checkpoint();
        if (client) client.setGuard(guard);
        else
          client = await createClient({
            manager,
            policy,
            runId,
            ownerRunId: owner.ownerRunId,
            codeSha,
            runnerRef: owner.runnerRef,
            guard,
            directory,
            requestHash: catalogRegionalRequestHash,
            withLease: (operation) => heartbeat.withLease(operation),
          });
        await heartbeat.checkpoint();
        return client;
      } catch (error) {
        await drain();
        throw error;
      }
    },
    checkpoint: () => heartbeat.checkpoint(),
    check: () => heartbeat?.check(),
    drain,
    async close() {
      await drain();
      return client ? client.close() : null;
    },
  };
}

/** Readback may verify the sealed version; it must not consume newer pending changes. */
export async function captureReadbackCatalog({
  regional,
  proof,
  snapshot,
  checkpoint = async () => {},
}) {
  const config = { siteOrigin: proof.siteOrigin, detailEnabled: proof.detailEnabled };
  await checkpoint();
  const current = await regional.capture(config);
  await checkpoint();
  assert.deepEqual(
    createCatalogAcceptanceProof({ config, capture: current, snapshot }),
    proof,
    'Products changed after delivery; rebuild current content instead of accepting old HTML',
  );
  return current;
}

/** Send only the accepted artifact identity and seal, never its files or private build inputs. */
export async function clearReadbackCatalogRegistration({
  regional,
  acceptedRun,
  input,
  checkpoint = async () => {},
  now = Date.now,
}) {
  assert.equal(acceptedRun.state, 'SUCCEEDED', 'Catalog cleanup requires an accepted site');
  assert.equal(acceptedRun.accepted?.sourceRunId, acceptedRun.runId);
  assert.deepEqual(acceptedRun.composition?.static?.artifact, input.envelope.artifact);
  assert.deepEqual(acceptedRun.accepted.seals?.static, input.acceptedSeal);
  let checkedAt = Number.NEGATIVE_INFINITY;
  const beforeStep = async () => {
    if (now() - checkedAt >= 30_000) {
      await checkpoint();
      checkedAt = now();
    }
  };
  const result = await regional.clearAcceptedRegistration({
    artifact: input.envelope.artifact,
    acceptedSeal: input.acceptedSeal,
    checkpoint: beforeStep,
  });
  await checkpoint();
  return result;
}

export async function runSiteReadback(env = process.env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_WORKFLOW_REF !==
      `${policy.repository}/${policy.workflowPath}@${policy.trustedRef}` ||
    env.TCB_ENV_ID !== policy.envId ||
    env.SITE_URL !== policy.siteOrigin ||
    env.CLOUDBASE_REGION !== policy.region ||
    env.SITE_READBACK_CONFIRM !== 'FINAL_READ_ONLY' ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(env.SITE_READBACK_RUN_ID ?? '') ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !env.TENCENTCLOUD_SECRETID ||
    !env.TENCENTCLOUD_SECRETKEY ||
    !env.GITHUB_TOKEN
  )
    throw Error('Pinned manual read-only acceptance invocation required');
  const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
  const api = createGithubReadClient({ policy, token: env.GITHUB_TOKEN });
  await github.requireCI(env.GITHUB_SHA);
  const config = {
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  };
  const db = createCloudbaseReleaseDatabase({ ...config, env: policy.envId });
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const runId = env.SITE_READBACK_RUN_ID;
  const output = resolve('output/site-readback');
  await mkdir(output, { recursive: true });
  const record = {
    runId,
    executorSha: env.GITHUB_SHA,
    websiteWrites: 0,
    operation: 'continue-final-read-only-acceptance',
    status: 'preflight',
  };
  const save = () => writeFile(resolve(output, 'result.json'), JSON.stringify(record, null, 2));
  await save();
  let guard;
  let step;
  let heartbeat;
  let cleanupFailure;
  let regionalAccess;
  const readbackOwner = {
    ownerRunId: `readback-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    runnerRef: `github:${policy.repository}:${env.GITHUB_RUN_ID}:attempt-${env.GITHUB_RUN_ATTEMPT}`,
  };
  let pathRead = 0;
  async function readPublicPaths() {
    const path = resolve(output, `public-paths-${++pathRead}.json`);
    await new Promise((done, reject) => {
      const child = spawn(
        resolve('apps/site/node_modules/.bin/tsx'),
        ['apps/site/scripts/prepare-product-public-paths.ts', path],
        {
          stdio: 'inherit',
          env: publicBuildEnvironment(env, {
            SITE_URL: policy.siteOrigin,
            SEO_CATALOG_API_ORIGIN: policy.siteOrigin,
          }),
        },
      );
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? done() : reject(Error('Public product inventory unreadable')),
      );
    });
    return JSON.parse(await readFile(path, 'utf8'));
  }
  try {
    let run = await coordinator.runStatus(runId);
    const acceptedRegistration = run.state === 'SUCCEEDED';
    const artifact = run.composition.static.artifact;
    const metadata = await github.download(
      artifact.artifactId,
      resolve(output, 'original-candidate'),
      { acceptedRunId: artifact.runId },
    );
    const input = siteArtifact({
      directory: resolve(output, 'original-candidate'),
      policy,
      run: metadata,
      ...(acceptedRegistration ? { acceptedSeal: run.accepted?.seals?.static } : {}),
    });
    const compatibility = readJson(input.directory, input.envelope.compatibilityRef.path);
    const catalogProof = compatibility.catalog;
    if (acceptedRegistration && !catalogProof)
      throw Error('Accepted registration repair requires a sealed catalog candidate');
    if (catalogProof && !compatibility.renderer)
      throw Error('Catalog registration requires its archived renderer identity');
    await github.requireCI(input.envelope.codeSha);
    const response = await db
      .collection('siteReleaseSteps')
      .where({ runId, kind: 'write' })
      .limit(1000)
      .get();
    if (response?.code || !Array.isArray(response?.data))
      throw Error('Original write evidence unreadable');
    const steps = response.data;
    const evidence = siteReadbackEvidence({ run, input, steps, policy, acceptedRegistration });
    const manager = new CloudBase(config);
    const provider = createCanaryProvider({ manager, policy });
    await provider.controlPlane({ execute: true });
    const catalogStore = catalogProof ? createCatalogSeoStore(db) : null;
    if (catalogProof) await checkCatalogRuntimeFlags(manager, catalogProof, policy.envId);
    if (catalogProof)
      regionalAccess = createReadbackRegionalAccess({
        manager,
        runId,
        codeSha: env.GITHUB_SHA,
        owner: readbackOwner,
        directory: resolve(output, 'regional'),
      });
    let catalog = null;
    const status = await coordinator.status({ scopeKey: 'site' });
    const owner = status.target.lease;
    const match =
      acceptedRegistration && !owner
        ? /^(?:site|readback)-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(run.ownerRunId ?? '')
        : /^github:vibelingan\/channel:([1-9][0-9]*):attempt-([1-9][0-9]*)$/.exec(
            owner?.runnerRef ?? '',
          );
    if (!match || match[1] === env.GITHUB_RUN_ID) throw Error('Original workflow owner unproven');
    const previous = await api.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
    siteProducerPolicy(policy, previous);
    if (
      String(previous.id) !== match[1] ||
      String(previous.run_attempt) !== match[2] ||
      previous.status !== 'completed' ||
      previous.repository?.full_name !== policy.repository ||
      previous.head_repository?.full_name !== policy.repository
    )
      throw Error('Previous owner has not stopped in the trusted workflow');
    if (acceptedRegistration) {
      if (status.target.lease)
        await releaseStoppedCatalogRegistration({
          coordinator,
          run,
          input,
          jobProof: {
            status: 'completed',
            runnerRef: owner.runnerRef,
            evidenceRef: `github:${previous.id}:attempt-${match[2]}:${previous.conclusion}`,
          },
        });
      record.catalogCleanup = await completeCatalogRegistration({
        coordinator,
        store: catalogStore,
        runId,
        input,
        owner: readbackOwner,
        register: async ({ run: acceptedRun, guard: registrationGuard, checkpoint }) => {
          const regional = await regionalAccess.use(registrationGuard, checkpoint);
          try {
            return await clearReadbackCatalogRegistration({
              regional,
              acceptedRun,
              input,
              checkpoint: () => regionalAccess.checkpoint(),
            });
          } finally {
            await regionalAccess.drain();
            regionalAccess.check();
          }
        },
      });
      await save();
    }
    const publicPaths = await readPublicPaths();
    const candidate = planSiteReleaseCandidate({
      artifactInput: input,
      currentOwnedPaths: [...input.staticManifest.entries.map((e) => e.path), ...evidence.removed],
      publicProductPaths: publicPaths,
    });
    if (candidate.stateSha256 !== evidence.hash)
      throw Error('Current public catalog differs from candidate; rebuild current content');
    // This is the only takeover allowed: every cloud write was already confirmed.
    if (!acceptedRegistration)
      guard = await coordinator.resumeReadOnlyAcceptance({
        runId,
        expectedVersion: status.target.version,
        expectedFence: owner.fence,
        ...readbackOwner,
        proof: {
          runnerRef: owner.runnerRef,
          checkedAt: Date.now(),
          job: {
            status: 'completed',
            evidenceRef: `github:${previous.id}:attempt-${match[2]}:${previous.conclusion}`,
          },
          cloud: { status: 'quiescent', kind: 'hosting-final-read-only' },
        },
      });
    record.status = 'checking-existing-website';
    await save();
    if (guard && !catalogProof)
      heartbeat = createExclusiveLeaseHeartbeat({ renew: () => coordinator.renew(guard) });
    const check = () => {
      heartbeat?.check();
      regionalAccess?.check();
    };
    if (catalogProof && !acceptedRegistration)
      catalog = await captureReadbackCatalog({
        regional: await regionalAccess.use(guard, () => coordinator.renew(guard)),
        proof: catalogProof,
        snapshot: readObject(input.directory, input.envelope.snapshotPath),
        checkpoint: () => regionalAccess.checkpoint(),
      });
    run = await coordinator.runStatus(runId);
    const observed = await verifySiteReadback({
      run,
      input,
      steps,
      policy,
      acceptedRegistration,
      // No upload/remove/configuration callback is exposed to this operation.
      provider: {
        readInventory: () => provider.readInventory(),
        readConfiguration: () => provider.readConfiguration(),
      },
      postCheck: async () => {
        check();
        await new Promise((done, reject) => {
          const child = spawn(
            resolve('node_modules/.bin/playwright'),
            ['test', 'tests/e2e/seo-public-live.spec.ts', '--project=chromium', '--retries=0'],
            {
              stdio: 'inherit',
              env: {
                PATH: env.PATH,
                HOME: env.HOME,
                CI: 'true',
                GITHUB_ACTIONS: 'true',
                E2E_SITE_URL: policy.siteOrigin,
                E2E_API_URL: `https://${policy.envId}.service.tcloudbase.com`,
                E2E_SEO_PUBLIC_LIVE: '1',
                E2E_BLOG_DELIVERY_MODE:
                  input.staticManifest.blog?.delivery === 'server' ? 'server' : 'static',
                E2E_RECORD_ARTIFACTS: '0',
              },
            },
          );
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? done() : reject(Error('Actual public browser checks failed')),
          );
        });
        check();
        if (identity(await readPublicPaths()) !== identity(publicPaths))
          throw Error('Public product inventory changed during acceptance');
      },
    });
    check();
    let accepted = null;
    if (!acceptedRegistration) {
      if (catalog) await catalog.delivery.check();
      // Acceptance ends the lease. No old renewal may race the next registration fence.
      await heartbeat?.stop();
      await regionalAccess?.drain();
      check();
      step = await coordinator.beginStep({
        guard,
        runId,
        stepId: randomUUID(),
        component: 'scope',
        kind: 'accept',
        beforeHash: observed.observedHash,
        afterHash: observed.observedHash,
        subject: 'accept',
        verifySubject: 'accept',
        executionId: randomUUID(),
      });
      await coordinator.confirmStep({
        guard,
        runId,
        stepId: step.stepId,
        receipt: {
          status: 'verified',
          executionId: step.executionId,
          planSha256: step.planSha256,
          operationId: step.operationId,
          intentHash: step.intentHash,
          subject: 'accept',
          expectedHash: step.afterHash,
          observedHash: observed.observedHash,
          terminal: true,
        },
      });
      accepted = await coordinator.commitRun({
        guard,
        runId,
        changeSetRef: `github:${env.GITHUB_RUN_ID}:read-only-acceptance`,
      });
    }
    if (catalogProof) {
      run = await coordinator.runStatus(runId);
      input.acceptedSeal = run.accepted.seals.static;
      record.catalogRegistration = await completeCatalogRegistration({
        coordinator,
        store: catalogStore,
        runId,
        input,
        owner: readbackOwner,
        register: async ({
          run: acceptedRun,
          guard: registrationGuard,
          checkpoint,
          writeActive,
        }) => {
          const source = compatibility.renderer;
          const approved = await catalogStore.get('catalogSeoBuilders', source.codeSha);
          if (
            approved?.schemaVersion !== 1 ||
            approved.codeSha !== source.codeSha ||
            approved.manifestSha256 !== source.manifestSha256 ||
            approved.archiveSha256 !== source.archiveSha256 ||
            approved.archiveObject?.fileID !== source.archiveFileId ||
            source.inputSchema !== 1
          )
            throw Error('Catalog renderer approval differs from the accepted website');
          const regional = await regionalAccess.use(registrationGuard, checkpoint);
          const regionalCheckpoint = () => regionalAccess.checkpoint();
          try {
            await clearReadbackCatalogRegistration({
              regional,
              acceptedRun,
              input,
              checkpoint: regionalCheckpoint,
            });
            const current = await captureReadbackCatalog({
              regional,
              proof: catalogProof,
              snapshot: readObject(input.directory, input.envelope.snapshotPath),
              checkpoint: regionalCheckpoint,
            });
            const files = new Map(
              input.staticManifest.entries
                .filter((entry) => /^products\/p-[A-Za-z0-9_-]+\/index\.html$/.test(entry.path))
                .map((entry) => {
                  const bytes = readObject(input.directory, entry.path);
                  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
                    throw Error('Archived product HTML changed before catalog registration');
                  return [entry.path, bytes];
                }),
            );
            return await activateCatalogRenderer({
              db,
              proof: source,
              runId,
              executorSha: env.GITHUB_SHA,
              executorRef: env.GITHUB_REF.slice(11),
              finishCatalog: () =>
                finishCatalogAcceptance({
                  catalog: current,
                  files,
                  checkpoint: regionalCheckpoint,
                }),
              writeActive: async (data) => {
                await regionalAccess.drain();
                regionalAccess.check();
                return writeActive(data);
              },
            });
          } finally {
            await regionalAccess.drain();
            regionalAccess.check();
          }
        },
      });
    }
    record.status = 'accepted';
    record.observation = observed;
    record.accepted = accepted;
    await save();
    console.log(`Existing website ${runId} accepted without repeating any website write.`);
  } catch (error) {
    record.status = 'readback-incomplete';
    record.error = error.message;
    await save();
    // Never clear uncertainty or start restoration merely because this read failed.
    throw error;
  } finally {
    await heartbeat?.stop();
    await regionalAccess?.drain();
    if (regionalAccess) {
      try {
        // The client retains an unconfirmed worker; this never releases its lease.
        record.regional = await regionalAccess.close();
      } catch (error) {
        cleanupFailure = error;
        record.regional = { cleaned: false };
        record.regionalCleanupError = error.message;
        await save();
      }
      await save();
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await runSiteReadback();
