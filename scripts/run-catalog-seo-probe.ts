import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import CloudBase from '@cloudbase/manager-node';
import { probeCollections } from '../packages/db/src/catalog-seo-live-probe.ts';
import { buildCatalogProbe } from './catalog-probe-build.mjs';
import { cleanupCatalogProbe } from './catalog-probe-cleanup.mjs';
import { readCatalogProbeResult } from './catalog-probe-result.mjs';
import { createSiteGithubSource } from './release/site-github-source.mjs';
const env = process.env;
const run = env.GITHUB_RUN_ID ?? '';
const sha = env.GITHUB_SHA ?? '';
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  env.GITHUB_REF !== 'refs/heads/feat/seo-foundation' ||
  env.TCB_ENV_ID !== 'diversity-123-d9grnqfux221323bb' ||
  env.CLOUDBASE_REGION !== 'ap-shanghai' ||
  env.SEO_PROBE_CONFIRM !== 'ISOLATED_CATALOG_ONLY' ||
  !/^\d{8,20}$/.test(run) ||
  !/^[a-f0-9]{40}$/.test(sha) ||
  !env.GITHUB_TOKEN ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY
)
  throw Error('Untrusted catalog probe invocation');
await createSiteGithubSource({ token: env.GITHUB_TOKEN }).requireCI(sha, {
  ref: env.GITHUB_REF,
  event: env.GITHUB_EVENT_NAME,
  runId: run,
  workflowRef: env.GITHUB_WORKFLOW_REF,
});
const manager = new CloudBase({
  envId: env.TCB_ENV_ID,
  region: env.CLOUDBASE_REGION,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const prefix = `seo_probe_${run}_`;
const name = `seo-catalog-probe-${run}`;
const directory = resolve('output/catalog-seo-probe');
await mkdir(directory, { recursive: true });
const token = randomBytes(32).toString('hex');
const digest = createHash('sha256').update(token).digest('hex');
const owned: string[] = [];
let functionCreated = false;
let invocationStarted = false;
let invocationTerminal = false;
const receipt: {
  schemaVersion: number;
  run: string;
  codeSha: string;
  scope: string;
  createdCollections: string[];
  result?: unknown;
  cleaned?: boolean;
  error?: string;
  cleanup: unknown[];
  cleanupError?: string;
  functionName: string;
  invocationConfirmed: boolean;
} = {
  schemaVersion: 1,
  run,
  codeSha: sha,
  scope: prefix,
  createdCollections: owned,
  cleanup: [],
  cleaned: false,
  functionName: name,
  invocationConfirmed: false,
};
let failure: Error | undefined;
try {
  const inventory = await manager.database.listCollections({ MgoLimit: 100, MgoOffset: 0 });
  assert.ok(
    Array.isArray(inventory.Collections) &&
      inventory.Pager?.Total === inventory.Collections.length &&
      inventory.Collections.length < 100,
    'Complete collection inventory required',
  );
  const names = new Set(inventory.Collections.map((row) => row.CollectionName));
  for (const value of probeCollections) {
    const collection = prefix + value;
    assert.equal(names.has(collection), false, 'Probe name is occupied');
    await manager.database.createCollection(collection);
    owned.push(collection);
    await writeFile(resolve(directory, 'result.json'), JSON.stringify(receipt, null, 2));
    await manager.permission.modifyResourcePermission({
      resourceType: 'collection',
      resource: collection,
      permission: 'ADMINONLY',
    });
    const acl = await manager.permission.describeResourcePermission({
      resourceType: 'collection',
      resources: [collection],
    });
    assert.equal(acl.Data?.PermissionList?.[0]?.Permission, 'ADMINONLY');
  }
  const approvedCollection = `${prefix}catalogDetailVariants`;
  const keys = ['productId', 'catalogDetailRevision', '_id'].map((Name) => ({
    Name,
    Direction: '1',
  }));
  await manager.database.updateCollection(approvedCollection, {
    CreateIndexes: [
      { IndexName: 'probe_approved_id', MgoKeySchema: { MgoIsUnique: false, MgoIndexKeys: keys } },
    ],
  });
  const index = (await manager.database.describeCollection(approvedCollection)).Indexes?.find(
    (row) => row.Name === 'probe_approved_id',
  );
  assert.ok(index && index.Unique === false, 'Exact isolated variant index readback required');
  assert.deepEqual(index.Keys, keys);
  await buildCatalogProbe(resolve(directory, 'function'));
  const functions = await manager.functions.listFunctions(100, 0);
  assert.ok(
    Array.isArray(functions) &&
      functions.length < 100 &&
      !functions.some((f) => f.FunctionName === name),
  );
  await manager.functions.createFunction({
    func: {
      name,
      runtime: 'Nodejs20.19',
      handler: 'index.main',
      timeout: 120,
      memorySize: 256,
      type: 'Event',
      installDependency: false,
      envVariables: { TCB_ENV: env.TCB_ENV_ID, SEO_PROBE_RUN: run, SEO_PROBE_DIGEST: digest },
    },
    functionPath: resolve(directory, 'function'),
    force: false,
  });
  functionCreated = true;
  let active = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await manager.functions.getFunctionDetail(name);
    if (detail.Status === 'Active' && Reflect.get(detail, 'AvailableStatus') === 'Available') {
      active = true;
      break;
    }
    if (detail.Status === 'CreateFailed' || detail.Status === 'UpdateFailed')
      throw Error('Probe function creation failed');
    await pause(2000);
  }
  if (!active) throw Error('Probe function did not become available within 60 seconds');
  invocationStarted = true;
  const response = await manager.functions.invokeFunction(name, { action: 'run', token });
  const result = readCatalogProbeResult(response, run);
  invocationTerminal = true;
  receipt.result = result;
  receipt.invocationConfirmed = true;
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(
    `Real CloudBase probe passed ${result.passed} checks; no business collections or website files were touched.`,
  );
} catch (error) {
  receipt.error = error instanceof Error ? error.message : 'Probe failed';
  failure = new Error(receipt.error);
}
// Only a complete invocation, or a preparation that never invoked it, permits cleanup.
try {
  if (!invocationStarted || invocationTerminal) {
    await cleanupCatalogProbe({
      manager,
      run,
      owned,
      functionCreated,
      onEvent: async (event: unknown) => {
        receipt.cleanup.push(event);
        await writeFile(resolve(directory, 'result.json'), JSON.stringify(receipt, null, 2));
      },
    });
    receipt.cleaned = true;
  }
} catch (error) {
  receipt.cleanupError = error instanceof Error ? error.message : 'Cleanup not confirmed';
  failure ??= new Error(receipt.cleanupError);
}
await writeFile(resolve(directory, 'result.json'), JSON.stringify(receipt, null, 2));
if (failure) throw failure;
