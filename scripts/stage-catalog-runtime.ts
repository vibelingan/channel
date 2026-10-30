import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import COS from 'cos-nodejs-sdk-v5';
import { readFunctionRuntimeState, readFunctionRuntimeVersion } from './blog/runtime-health.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './blog/site-baseline.mjs';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { captureFunctionBackups } from './capture-function-backups.mjs';
import { ALIBABA_SYNC_TIMER } from './cloudbase-function-manifest.mjs';
import { settleInitialCatalogRuntime } from './release/catalog-runtime-activation.mjs';
import { preserveCatalogRuntimeBackup } from './release/catalog-runtime-backup.mjs';
import { setCatalogRuntimeFlags } from './release/catalog-runtime-config.mjs';
import {
  assertTrackedCatalogProgram,
  checkCatalogRuntimeFlags,
} from './release/catalog-runtime-flags.mjs';
import { ARCHIVE_COS_OPTIONS, createCosArchiveTransfer } from './release/cos-archive-transfer.mjs';
import { checkFunctionArchive } from './release/function-archive.mjs';
import { createCloudbaseFunctionProvider } from './release/function-provider.mjs';
import { replaceFunctionCode } from './release/function-replacement.mjs';
import { identity } from './release/input.mjs';
import { createPrivateArchive } from './release/private-archive.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
import { assertCleanAcceptedSite, SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
import { fetchFully } from './smoke-http.mjs';
const env = process.env;
let stage = 'invocation';
async function main() {
  const phase = env.CATALOG_RUNTIME_ACTION;
  const codeSha = env.CATALOG_RUNTIME_SHA || env.GITHUB_SHA;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    env.GITHUB_REF !== policy.trustedRef ||
    env.GITHUB_WORKFLOW_REF !==
      `${policy.repository}/.github/workflows/seo-static-canary.yml@${policy.trustedRef}` ||
    env.TCB_ENV_ID !== policy.envId ||
    !env.GITHUB_TOKEN ||
    !env.TENCENTCLOUD_SECRETID ||
    !env.TENCENTCLOUD_SECRETKEY ||
    !['stage', 'record', 'readiness'].includes(phase ?? '') ||
    !/^[a-f0-9]{40}$/.test(codeSha ?? '') ||
    (phase === 'stage' && codeSha !== env.GITHUB_SHA)
  )
    throw Error('Untrusted catalog runtime invocation');
  const github = createSiteGithubSource({ token: env.GITHUB_TOKEN });
  stage = 'checked-source';
  await github.requireCI(env.GITHUB_SHA);
  await github.requireCI(codeSha);
  const target = { envId: policy.envId, region: policy.region, siteOrigin: policy.siteOrigin };
  const manager = new CloudBase({
    envId: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  });
  const sdk = blogWorkerSdk({
    env: policy.envId,
    region: policy.region,
    secretId: env.TENCENTCLOUD_SECRETID,
    secretKey: env.TENCENTCLOUD_SECRETKEY,
  });
  const db = sdk.database();
  const archiveCos = new COS({
    SecretId: env.TENCENTCLOUD_SECRETID,
    SecretKey: env.TENCENTCLOUD_SECRETKEY,
    ...ARCHIVE_COS_OPTIONS,
  });
  const objects = createPrivateArchive({
    ...createCosArchiveTransfer({ cos: archiveCos, policy }),
    sdk,
    manager,
    policy,
    readLifecycle: (params: COS.GetBucketLifecycleParams) => archiveCos.getBucketLifecycle(params),
  });
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const baseline = assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
  const clock = await manager.functions.getFunctionDetail('catalog-seo-clock');
  if (
    clock.Environment?.Variables?.find((v) => v.Key === 'CATALOG_SEO_CLOCK_ENABLED')?.Value !== '0'
  )
    throw Error('Stop the catalog clock before initial runtime activation');
  const names = ['public-api', 'alibaba-catalog-sync', 'admin'];
  const provider = createCloudbaseFunctionProvider({
    manager,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    region: policy.region,
    names,
    expectedTriggers: { 'alibaba-catalog-sync': [ALIBABA_SYNC_TIMER] },
    archiveProfiles: { 'alibaba-catalog-sync': 'catalog-native-decoder' },
    archiveBucket: policy.archiveBucket,
    stageArchive: (bytes: Buffer) => objects.put(bytes),
    configurationKey: createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
      .update(
        `channel-function-observation:v1:${identity({ envId: policy.envId, siteOrigin: policy.siteOrigin })}`,
      )
      .digest(),
  });
  const directory = resolve('output/catalog-runtime');
  await mkdir(directory, { recursive: true });
  const website = await readBlogSiteBaseline();
  const results: object[] = [];
  if (phase === 'stage') {
    stage = 'capture-original-programs';
    for (const name of names) {
      const detail = await manager.functions.getFunctionDetail(name);
      if (detail.Runtime !== 'Nodejs20.19') throw Error('Preserve the reviewed function runtime');
      if (
        detail.Environment?.Variables?.some(
          (v) =>
            ['CATALOG_SEO_RECORDING', 'CATALOG_SEO_PAGE_READINESS'].includes(v.Key) &&
            v.Value === '1',
        )
      )
        throw Error('Initial code staging requires catalog activation switches to remain off');
    }
    const captured = await captureFunctionBackups({
      provider,
      names,
      output: join(directory, 'before'),
    });
    const versions: Record<string, string> = {};
    const candidates = new Map<string, Buffer>();
    const files = [join(directory, 'before/function-backups.json')];
    for (const name of names) {
      stage = `validate-${name}`;
      versions[name] = await readFunctionRuntimeVersion(policy.envId, name);
      const zip = join(directory, `${name}-candidate.zip`);
      execFileSync(
        'python3',
        [
          '-c',
          "import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'x',compression=zipfile.ZIP_DEFLATED) as z:\n for p in sorted(r.rglob('*')):\n  if p.is_symlink(): raise RuntimeError('Unexpected function symlink')\n  if p.is_file(): z.write(p,p.relative_to(r))",
          resolve('.cloudbase-artifacts/functions', name),
          zip,
        ],
        { timeout: 30000, stdio: 'pipe' },
      );
      const bytes = await readFile(zip);
      const profile = name === 'alibaba-catalog-sync' ? 'catalog-native-decoder' : 'bundled';
      checkFunctionArchive(bytes, { smoke: true, profile });
      checkFunctionArchive(await readFile(join(directory, `before/${name}.zip`)), {
        smoke: true,
        profile,
      });
      candidates.set(name, bytes);
      files.push(zip, join(directory, `before/${name}.zip`));
    }
    await writeFile(
      join(directory, 'before/runtime.json'),
      JSON.stringify({ versions, codeSha }, null, 2),
      { flag: 'wx' },
    );
    files.push(join(directory, 'before/runtime.json'));
    stage = 'preserve-original-programs';
    const originals = [];
    for (const entry of captured.entries) {
      const name = entry.snapshot.name;
      originals.push({
        name,
        snapshot: entry.snapshot,
        bytes: await readFile(join(directory, `before/${name}.zip`)),
        version: versions[name],
      });
    }
    const preserved = await preserveCatalogRuntimeBackup({
      row: db.collection('catalogSeoBuilders').doc(`runtime-backup-${codeSha}`),
      objects,
      target,
      codeSha,
      sourceRunId: env.GITHUB_RUN_ID,
      originals,
    });
    await writeFile(join(directory, 'before/retention.json'), JSON.stringify(preserved, null, 2), {
      flag: 'wx',
    });
    files.push(join(directory, 'before/retention.json'));
    const backup = await new DefaultArtifactClient().uploadArtifact(
      `catalog-runtime-backup-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      files,
      directory,
      { retentionDays: 90 },
    );
    if (!backup.id || !backup.digest)
      throw Error('Original programs not archived; no code write allowed');
    await checkBlogSiteBaseline(website);
    for (const name of names) {
      stage = `code-${name}`;
      const before = captured.entries.find((e) => e.snapshot.name === name)?.snapshot;
      const candidate = candidates.get(name);
      if (!before || !candidate) throw Error('Captured function disappeared');
      const result = await replaceFunctionCode({
        name,
        archiveProfile: name === 'alibaba-catalog-sync' ? 'catalog-native-decoder' : 'bundled',
        provider,
        before,
        original: await readFile(join(directory, `before/${name}.zip`)),
        candidate,
        beforeVersion: versions[name],
        expectedVersion: codeSha,
        readHealth: () => readFunctionRuntimeVersion(policy.envId, name),
      });
      results.push({ name, result });
      await writeFile(
        join(directory, 'progress.json'),
        JSON.stringify({ codeSha, backupArtifactId: backup.id, results }, null, 2),
      );
      if (result.status !== 'accepted')
        throw Error('Function code needs investigation; no further write allowed');
      await checkBlogSiteBaseline(website);
    }
  } else {
    stage = 'verify-running-programs';
    for (const name of names) {
      await provider.read(name);
      if ((await readFunctionRuntimeVersion(policy.envId, name)) !== codeSha)
        throw Error('Running program differs from the selected accepted source');
    }
    if (phase === 'readiness') {
      await checkCatalogRuntimeFlags(
        manager,
        { siteOrigin: policy.siteOrigin, detailEnabled: true },
        policy.envId,
      );
      const response = await db.collection('catalogSeoBuilders').doc('active').get();
      assertTrackedCatalogProgram(
        Array.isArray(response.data) ? response.data[0] : response.data,
        baseline,
      );
    }
    for (const name of phase === 'record' ? ['admin', 'alibaba-catalog-sync'] : ['public-api']) {
      stage = `${phase}-${name}`;
      const before = await manager.functions.getFunctionDetail(name);
      const result = await setCatalogRuntimeFlags({ manager, target, name, phase, before });
      results.push(result);
      await writeFile(
        join(directory, 'progress.json'),
        JSON.stringify({ codeSha, results }, null, 2),
      );
      let healthy = false;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        let health: Awaited<ReturnType<typeof readFunctionRuntimeState>>;
        try {
          health = await readFunctionRuntimeState(policy.envId, name, (method, url, options) =>
            fetchFully(method, url, { ...options, timeoutMs: 10000, maxBytes: 16384 }),
          );
        } catch {
          await new Promise((done) => setTimeout(done, 2000));
          continue;
        }

        if (health.releaseId !== codeSha) throw Error('Function source changed during activation');
        healthy = phase === 'record' ? health.catalogSeoRecording : health.catalogSeoPageReadiness;
        if (healthy) break;
        await new Promise((done) => setTimeout(done, 2000));
      }
      if (!healthy) throw Error('Running program has not confirmed its catalog setting');
      await checkBlogSiteBaseline(website);
    }
  }
  if (phase === 'record') {
    stage = 'finish-prior-writer-requests';
    const row = db.collection('catalogSeoBuilders').doc('runtime-activation');
    const registry = {
      async get() {
        const response = await row.get();
        const value = Array.isArray(response.data) ? response.data[0] : response.data;
        if (!value) return null;
        const { _id, ...body } = value;
        return body;
      },
      async set(value: object) {
        await row.set(value);
      },
    };
    const activation = await settleInitialCatalogRuntime({
      registry,
      sourceRunId: env.GITHUB_RUN_ID,
      siteOrigin: policy.siteOrigin,
      codeSha,
      async read() {
        const configurations = [];
        let maximumTimeoutSeconds = 0;
        for (const name of names) {
          const detail = await manager.functions.getFunctionDetail(name);
          const snapshot = await provider.read(name);
          const health = await readFunctionRuntimeState(policy.envId, name);
          if (
            health.releaseId !== codeSha ||
            (name !== 'public-api' && !health.catalogSeoRecording)
          )
            throw Error('Catalog writer runtime changed during initial activation');
          if (name !== 'public-api') {
            if (!Number.isSafeInteger(detail.Timeout) || detail.Timeout < 1 || detail.Timeout > 900)
              throw Error('Writer execution duration is not bounded');
            maximumTimeoutSeconds = Math.max(maximumTimeoutSeconds, detail.Timeout);
          }
          configurations.push({
            name,
            configurationToken: snapshot.configurationToken,
            versionToken: snapshot.versionToken,
            packageSha256: snapshot.packageSha256,
          });
        }
        return { configurationHash: identity(configurations), maximumTimeoutSeconds };
      },
      report: (event: object) => console.log(JSON.stringify(event)),
    });
    results.push({ initialActivation: activation });
  }
  assertCleanAcceptedSite(await coordinator.status({ scopeKey: 'site' }));
  await writeFile(
    join(directory, 'receipt.json'),
    JSON.stringify(
      {
        phase,
        codeSha,
        executorSha: env.GITHUB_SHA,
        results,
        websiteWrites: 0,
        businessWrites: 0,
        clockEnabled: false,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({
      phase,
      codeSha,
      functions: results.length,
      websiteWrites: 0,
      businessWrites: 0,
      clockEnabled: false,
    }),
  );
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: 'CATALOG_RUNTIME_UNCONFIRMED',
      stage,
      ...(/^[A-Za-z0-9_.-]{1,100}$/.test(error?.code ?? '') ? { code: error.code } : {}),
      ...(/^[A-Za-z0-9-]{1,128}$/.test(error?.requestId ?? '')
        ? { requestId: error.requestId }
        : {}),
    }),
  );
  process.exitCode = 1;
});
