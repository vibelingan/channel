import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import CloudBase from '@cloudbase/manager-node';
import { collectPublicProductPaths } from '../apps/site/src/lib/seo/product-snapshot.ts';
import { CatalogPublicHeadSchema } from '../packages/db/src/catalog-public-changes.ts';
import { createCatalogSeoStore } from '../packages/db/src/catalog-seo-cloud.ts';
import { recheckCatalogSeoRequests } from '../packages/db/src/catalog-seo-recheck.ts';
import { readFunctionRuntimeState } from './blog/runtime-health.mjs';
import { blogWorkerSdk } from './blog/worker-source.ts';
import {
  assertCatalogRecheckRuntime,
  assertCatalogRecheckSite,
  catalogRecheckInventoryFetch,
  createCatalogRecheckFence,
} from './release/catalog-recheck-fence.mjs';
import { identity } from './release/input.mjs';
import { normalizePolicy, tables } from './release/ledger.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
import { createReleaseCoordinator } from './release/state.mjs';
import { createCloudbaseReleaseStore } from './release/store-cloudbase.mjs';
import { fetchFully } from './smoke-http.mjs';

interface Connection {
  secretId: string;
  secretKey: string;
  token?: string;
  sessionToken?: string;
  envId?: string;
  env?: string;
  region?: string;
}
interface RecheckInput {
  config: Connection;
  expectedAcceptedRunId: string;
  expectedExecutorSha: string;
  outputDirectory: string;
}
const LIMIT = 50_000;
const BATCH = 100;

/** Queue a public-state recheck; never alter products, heads, tasks, functions or website objects. */
export async function runCatalogRuntimeRecheck(input: RecheckInput) {
  const { config, expectedAcceptedRunId, expectedExecutorSha } = input;
  if (
    process.env.CATALOG_RECHECK_CONFIRM !== 'QUEUE_ONLY_NO_CONTENT_WRITES' ||
    !/^site-[1-9][0-9]*-[1-9][0-9]*$/.test(expectedAcceptedRunId) ||
    !/^[a-f0-9]{40}$/.test(expectedExecutorSha) ||
    typeof input.outputDirectory !== 'string' ||
    !input.outputDirectory.trim() ||
    typeof config.secretId !== 'string' ||
    !config.secretId ||
    typeof config.secretKey !== 'string' ||
    !config.secretKey ||
    (config.envId !== undefined && config.envId !== policy.envId) ||
    (config.env !== undefined && config.env !== policy.envId) ||
    (config.region !== undefined && config.region !== policy.region) ||
    (config.token !== undefined &&
      config.sessionToken !== undefined &&
      config.token !== config.sessionToken)
  )
    throw Error(
      'Explicit queue-only confirmation, credentials, fixed target and accepted identities required',
    );
  const token = config.token ?? config.sessionToken;
  if (token !== undefined && (typeof token !== 'string' || !token))
    throw Error('A supplied temporary session token must be complete');
  const credentials = {
    envId: policy.envId,
    region: policy.region,
    secretId: config.secretId,
    secretKey: config.secretKey,
    ...(token ? { token } : {}),
  };
  const manager = new CloudBase(credentials);
  const db = blogWorkerSdk({
    ...credentials,
    env: policy.envId,
    ...(token ? { sessionToken: token } : {}),
  }).database();
  const store = createCatalogSeoStore(db);
  const coordinator = createReleaseCoordinator({
    store: createCloudbaseReleaseStore({ db, envId: policy.envId }),
    policy,
  });
  const targetId = normalizePolicy(policy).targetId;
  const scopeId = `${targetId}-site`;
  const directory = resolve(input.outputDirectory);
  const operationId = randomUUID();
  const startedAt = new Date().toISOString();
  const budget = { publicListReads: 0, headListReads: 0, queueTransactionsPlanned: 0 };
  let phase = 'preflight';
  let finished = 0;
  const counts = { queued: 0, preserved: 0, upgraded: 0 };
  let pendingBatch: { offset: number; size: number; idsHash: string } | null = null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = async (name: string, value: object) => {
    const file = join(directory, `${operationId}-${name}.json`);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  };
  const receipt = () => ({
    schemaVersion: 1,
    purpose: 'catalog-runtime-gap-recheck',
    operationId,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin, region: policy.region },
    expectedAcceptedRunId,
    expectedExecutorSha,
    startedAt,
    phase,
    finished,
    counts: { ...counts },
    pendingBatch,
    budget: { ...budget },
    contentWrites: 0,
    functionWrites: 0,
    websiteWrites: 0,
    headWrites: 0,
    taskWrites: 0,
  });
  try {
    const inspectSite = async () => {
      const status = await coordinator.status({ scopeKey: 'site' });
      const run = await coordinator.runStatus(expectedAcceptedRunId);
      const [active, proof] = await Promise.all([
        store.get('catalogSeoBuilders', 'active'),
        store.get('catalogSeoBuilders', 'runtime-activation'),
      ]);
      assertCatalogRecheckSite({
        status,
        run,
        active,
        proof,
        expectedAcceptedRunId,
        expectedExecutorSha,
        policy,
      });
      return { status, run, active, proof };
    };
    const first = await inspectSite();
    const proof = first.proof;
    const readRuntime = async () => {
      const [writers, clock] = await Promise.all([
        Promise.all(
          ['admin', 'alibaba-catalog-sync'].map(async (name) => {
            const [detail, health] = await Promise.all([
              manager.functions.getFunctionDetail(name),
              readFunctionRuntimeState(policy.envId, name, (method, url, options) =>
                fetchFully(method, url, { ...options, timeoutMs: 15_000, maxBytes: 16_384 }),
              ),
            ]);
            return { name, detail, health };
          }),
        ),
        manager.functions.getFunctionDetail('catalog-seo-clock'),
      ]);
      return assertCatalogRecheckRuntime({ writers, clock, proof, policy });
    };
    const runtime = await readRuntime();
    const hmac = (value: unknown) =>
      createHmac('sha256', config.secretKey)
        .update(`catalog-recheck:${policy.envId}:${identity(value)}`)
        .digest('hex');
    const runtimeHash = hmac(runtime);
    const [targetRow, scopeRow] = await Promise.all([
      store.get(tables.targets, targetId),
      store.get(tables.scopes, scopeId),
    ]);
    const fence = createCatalogRecheckFence({ policy, targetRow, scopeRow, expectedAcceptedRunId });
    const paths = await collectPublicProductPaths(
      policy.siteOrigin,
      catalogRecheckInventoryFetch({ request: fetchFully, budget }),
    );
    const ids = new Set(
      paths.map((path) => {
        const match = /^\/products\/p-([A-Za-z0-9_-]{1,200})\/$/.exec(path);
        if (!match?.[1]) throw Error('Invalid public product path');
        return match[1];
      }),
    );
    let cursor: string | null = null;
    let headCount = 0;
    const headsBefore: Array<{
      publicId: string;
      visible: boolean;
      sequence: number;
      semanticHash: string;
      detailRevision: string | null;
      changedAt: string | null;
    }> = [];
    for (;;) {
      budget.headListReads++;
      const page = await store.list(
        'catalogPublicHeads',
        { siteOrigin: policy.siteOrigin },
        cursor,
        BATCH,
      );
      if (page.length > BATCH) throw Error('Historical public head page exceeds its bound');
      for (const raw of page) {
        const row = CatalogPublicHeadSchema.parse(raw);
        if (
          row.siteOrigin !== policy.siteOrigin ||
          row._id <= (cursor ?? '') ||
          ++headCount > LIMIT
        )
          throw Error('Historical public head inventory changed or exceeds its bound');
        cursor = row._id;
        headsBefore.push({
          publicId: row.productId,
          visible: row.visible,
          sequence: row.sequence,
          semanticHash: row.semanticHash,
          detailRevision: row.detailRevision,
          changedAt: row.changedAt,
        });
        ids.add(row.productId);
        if (ids.size > LIMIT) throw Error('Combined product inventory exceeds its bound');
      }
      if (page.length < BATCH) break;
    }
    if (ids.size > LIMIT) throw Error('Combined product inventory exceeds its bound');
    const ordered = [...ids].sort();
    budget.queueTransactionsPlanned = ordered.length;
    // Finish all preflight reads before the first queue transaction starts.
    fence.assertUnchanged(
      await store.get(tables.targets, targetId),
      await store.get(tables.scopes, scopeId),
    );
    if (
      hmac(await readRuntime()) !== runtimeHash ||
      identity(await inspectSite()) !== identity(first)
    )
      throw Error('Runtime or accepted website changed during preflight');
    phase = 'queueing';
    await save(
      'heads-before',
      headsBefore.sort((a, b) => a.publicId.localeCompare(b.publicId)),
    );
    await save('preflight', {
      ...receipt(),
      fence: fence.receipt,
      runtimeHash,
      productCount: ordered.length,
      publicProductCount: paths.length,
      historicalHeadCount: headCount,
      idsHash: identity(ordered),
    });
    const now = new Date().toISOString();
    for (let offset = 0; offset < ordered.length; offset += BATCH) {
      const batch = ordered.slice(offset, offset + BATCH);
      pendingBatch = { offset, size: batch.length, idsHash: identity(batch) };
      await save('progress', receipt());
      const result = await recheckCatalogSeoRequests(
        store,
        { siteOrigin: policy.siteOrigin, detailEnabled: true },
        batch,
        now,
        fence.assertCanQueue,
      );
      counts.queued += result.queued;
      counts.preserved += result.preserved;
      counts.upgraded += result.upgraded;
      finished += batch.length;
      pendingBatch = null;
      await save(`batch-${String(offset / BATCH + 1).padStart(4, '0')}`, {
        ...receipt(),
        batch: { offset, size: batch.length, ...result },
      });
    }
    phase = 'postflight';
    fence.assertUnchanged(
      await store.get(tables.targets, targetId),
      await store.get(tables.scopes, scopeId),
    );
    if (
      hmac(await readRuntime()) !== runtimeHash ||
      identity(await inspectSite()) !== identity(first)
    )
      throw Error('Runtime or accepted website changed before final confirmation');
    phase = 'completed';
    const final = {
      ...receipt(),
      completedAt: new Date().toISOString(),
      fence: fence.receipt,
      runtimeHash,
    };
    await save('result', final);
    return final;
  } catch {
    const stopped = {
      ...receipt(),
      status: 'stopped',
      queueWritesMayHaveCompletedInPendingBatch: pendingBatch !== null,
      queueRollback: 'none',
      code: 'CATALOG_RECHECK_STOPPED',
    };
    await save('stopped', stopped);
    throw Object.assign(
      Error('Catalog recheck stopped; retain queued requests and inspect its safe receipt'),
      { code: 'CATALOG_RECHECK_STOPPED', operationId },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCatalogRuntimeRecheck({
    config: {
      secretId: process.env.TENCENTCLOUD_SECRETID ?? '',
      secretKey: process.env.TENCENTCLOUD_SECRETKEY ?? '',
      ...(process.env.TENCENTCLOUD_SESSIONTOKEN
        ? { sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }
        : {}),
    },
    expectedAcceptedRunId: process.env.CATALOG_RECHECK_ACCEPTED_RUN_ID ?? '',
    expectedExecutorSha: process.env.CATALOG_RECHECK_EXECUTOR_SHA ?? '',
    outputDirectory: process.env.CATALOG_RECHECK_OUTPUT ?? 'output/catalog-runtime-recheck',
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(JSON.stringify({ status: 'stopped', code: 'CATALOG_RECHECK_STOPPED' }));
      process.exitCode = 1;
    });
}
