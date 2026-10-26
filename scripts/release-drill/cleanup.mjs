import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { assertErrorDocument, assertMutableCachePolicy } from '../hosting-contract.mjs';
import { readHttpWithRetry } from '../read-http-retry.mjs';
import { configurationStateHash } from '../release/hosting-configuration.mjs';
import { verifyHostingObject } from '../release/hosting-readback.mjs';
import { identity } from '../release/input.mjs';

export function assertDummyCleanup({ seedRun, snapshot, health, rows, expectedHash }) {
  const ids = ['existing', 'new-b', 'deleted-b'].map((suffix) => `seo-drill-${seedRun}-${suffix}`);
  if (
    seedRun !== '40267380016' ||
    snapshot.functionId !== 'lam-d42kr5c9' ||
    snapshot.name !== 'seo-release-dummy' ||
    snapshot.packageSha256 !== expectedHash ||
    snapshot.runtime !== 'Nodejs20.19' ||
    snapshot.handler !== 'index.main' ||
    snapshot.triggerCount !== 0 ||
    snapshot.role !== 'TCB_QcsRole' ||
    !Array.isArray(snapshot.layers) ||
    snapshot.layers.length !== 0 ||
    health.version !== 'A' ||
    health.runId !== seedRun ||
    health.purpose !== 'channel-recovery-dummy-v1' ||
    !Array.isArray(rows) ||
    rows.length !== 3 ||
    new Set(rows.map((r) => r._id)).size !== 3 ||
    rows.some((r) => !ids.includes(r._id) || r.purpose !== 'channel-recovery-dummy-v1') ||
    rows.find((r) => r._id.endsWith('-deleted-b'))?.deleted !== true
  )
    throw Error('Only the complete owned A-B-A fixture may be removed');
}

/** One-off removal of this accepted drill; ordinary site/functions and all audit records stay. */
export async function cleanupDummyResources({
  manager,
  db,
  coordinator,
  provider,
  canaryProvider,
  health,
  baseline,
  seedRun,
  expectedActivationId,
  output,
  artifactClient,
  githubRun,
  attempt,
  policy,
  loadStatic,
}) {
  const status = await coordinator.status({ scopeKey: 'site' });
  assert.equal(status.state, 'idle');
  assert.equal(status.target?.dirtyRunId, null);
  assert.equal(status.scope.active.activationId, expectedActivationId);
  const active = await coordinator.runStatus(status.scope.active.sourceRunId);
  assert.equal(active.state, 'SUCCEEDED');
  assert.equal(active.kind, 'restore');
  const snapshot = await provider.read('seo-release-dummy');
  const collection = 'seoReleaseDrillFixtures';
  const readAll = async () => {
    const r = await db.collection(collection).limit(4).get();
    assert(!r.code && Array.isArray(r.data) && r.requestId);
    return r.data.sort((a, b) => a._id.localeCompare(b._id));
  };
  const rows = await readAll();
  assertDummyCleanup({
    seedRun,
    snapshot,
    health: await health(),
    rows,
    expectedHash: baseline.envelope.functions[0].sha256,
  });
  const before = await manager.functions.getFunctionList(100, 0);
  assert(
    before.RequestId &&
      Array.isArray(before.Functions) &&
      before.TotalCount === before.Functions.length,
  );
  const rest = (list) =>
    list
      .filter((f) => f.FunctionName !== 'seo-release-dummy')
      .sort((a, b) => a.FunctionName.localeCompare(b.FunctionName));
  const accesses = await manager.access.getAccessList({
    name: 'seo-release-dummy',
    limit: 100,
    offset: 0,
  });
  assert(Array.isArray(accesses.APISet) && accesses.APISet.length === 0 && accesses.Total === 0);
  const routes = await manager.env.describeHttpServiceRoute({ EnvId: policy.envId });
  assert(
    routes.RequestId &&
      Array.isArray(routes.Domains) &&
      routes.TotalCount === routes.Domains.length,
  );
  assert(
    !routes.Domains.some((d) =>
      (d.Routes ?? []).some((r) => r.UpstreamResourceName === 'seo-release-dummy'),
    ),
  );
  const staticStatus = await coordinator.status({ scopeKey: 'canary' });
  const staticRun = await coordinator.runStatus(staticStatus.scope.active.sourceRunId);
  const input = await loadStatic(staticRun);
  const entry = input.staticManifest.entries[0];
  assert.equal(entry.path, `${policy.canaryPrefix}index.html`);
  const configuration = await canaryProvider.readConfiguration();
  assert.equal(
    configurationStateHash(configuration),
    configurationStateHash(input.staticManifest.configuration),
  );
  assert.deepEqual(await canaryProvider.inventory(policy.canaryPrefix), [entry.path]);
  await verifyHostingObject({ target: canaryProvider.target, entry });
  const preparation = {
    schemaVersion: 1,
    purpose: 'remove-owned-finished-dummy-only',
    seedRun,
    expectedActivationId,
    functionId: snapshot.functionId,
    functionName: snapshot.name,
    functionPackageSha256: snapshot.packageSha256,
    originalFunctionArtifact: baseline.envelope.artifact,
    rows,
    staticPath: entry.path,
    staticSha256: entry.sha256,
    retained:
      'All production data, ordinary pages/functions, article data, and four drill audit collections',
    recovery:
      'Original function A and static A archives remain; no business restore is needed for disposable fixture removal',
  };
  const file = join(output, 'cleanup-preparation.json');
  await writeFile(file, JSON.stringify(preparation, null, 2), { flag: 'wx' });
  const archived = await artifactClient.uploadArtifact(
    `dummy-cleanup-preparation-${githubRun}-${attempt}`,
    [file],
    output,
    { retentionDays: 90 },
  );
  assert(archived.id && archived.digest);
  const result = {
    status: 'removing',
    preparationArtifactId: String(archived.id),
    stage: 'delete-owned-function',
    functionDeletes: 0,
    rowDeletes: 0,
    collectionDeletes: 0,
    fileDeletes: 0,
  };
  const save = () =>
    writeFile(join(output, 'cleanup-result.json'), JSON.stringify(result, null, 2));
  await save();
  const again = await provider.read('seo-release-dummy');
  assert.equal(again.packageSha256, snapshot.packageSha256);
  assert.equal(again.functionId, snapshot.functionId);
  assert.equal(again.configurationToken, snapshot.configurationToken);
  result.functionDeletes = null;
  await save();
  const deleted = await manager.functions.deleteFunction('seo-release-dummy');
  assert(deleted.RequestId && !deleted.SCFErrorCode);
  const deadline = Date.now() + 120000;
  let functions;
  for (;;) {
    const f = await manager.functions.getFunctionList(100, 0);
    assert(f.RequestId && Array.isArray(f.Functions) && f.TotalCount === f.Functions.length);
    if (!f.Functions.some((x) => x.FunctionName === 'seo-release-dummy')) {
      functions = f.Functions;
      break;
    }
    if (Date.now() >= deadline) throw Error('Dummy removal is not yet confirmed');
    await pause(1000);
  }
  assert.equal(identity(rest(functions)), identity(rest(before.Functions)));
  result.functionDeletes = 1;
  result.stage = 'delete-owned-records';
  await save();
  assert.equal(identity(await readAll()), identity(rows));
  for (const row of rows) {
    result.pendingRowId = row._id;
    await save();
    const removed = await db.collection(collection).doc(row._id).remove();
    assert(!removed.code && removed.requestId && removed.deleted === 1);
    result.rowDeletes++;
    result.pendingRowId = null;
    await save();
  }
  assert.equal((await readAll()).length, 0);
  result.stage = 'remove-empty-fixture-collection';
  await save();
  result.collectionDeletes = null;
  await save();
  await manager.database.deleteCollection(collection);
  const tables = await manager.database.listCollections({ MgoLimit: 100, MgoOffset: 0 });
  assert(
    tables.RequestId &&
      Array.isArray(tables.Collections) &&
      tables.Pager?.Offset === 0 &&
      tables.Pager.Total === tables.Collections.length &&
      tables.Collections.every((t) => typeof t.CollectionName === 'string'),
  );
  assert(
    !tables.Collections.some((t) => t.TableName === collection || t.CollectionName === collection),
  );
  result.collectionDeletes = 1;
  result.stage = 'remove-owned-canary';
  await save();
  result.fileDeletes = null;
  await save();
  await canaryProvider.remove(entry.path);
  result.fileDeletes = 1;
  await save();
  assert.deepEqual(await canaryProvider.inventory(policy.canaryPrefix), []);
  for (const headers of [{}, { 'cache-control': 'no-cache' }]) {
    const page = await readHttpWithRetry('GET', `${policy.siteOrigin}/${policy.canaryPrefix}`, {
      timeoutMs: 15000,
      maxBytes: 131072,
      redirect: 'error',
      headers,
    });
    assert.equal(page.status, 404);
    assertMutableCachePolicy(page.headers.get('cache-control') ?? '');
    assertErrorDocument(page.body);
  }
  assert.equal(
    configurationStateHash(await canaryProvider.readConfiguration()),
    configurationStateHash(configuration),
  );
  result.status = 'removed';
  result.stage = 'complete';
  await save();
  return result;
}
