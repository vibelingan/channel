/** Resumable all-record audit/apply client. Credentials stay in CHANNEL_ADMIN_TOKEN. */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const statuses = new Set([
  'archived',
  'unlinked',
  'manual',
  'invalid-manual',
  'valid-source',
  'stale-source',
  'eligible',
  'quote-only',
  'invalid-source',
  'incomplete-run',
  'invalid-pin',
  'invalid-offer',
  'identity-conflict',
  'error',
  'repaired',
  'conflict',
]);
export function verifyPage(page, mode, afterId) {
  if (
    !page ||
    page.mode !== mode ||
    !Number.isSafeInteger(page.visited) ||
    page.visited < 0 ||
    page.visited > 20 ||
    !Number.isSafeInteger(page.eligible) ||
    page.eligible < 0 ||
    page.eligible > page.visited ||
    !Number.isSafeInteger(page.repaired) ||
    page.repaired < 0 ||
    page.repaired > page.eligible ||
    typeof page.pageHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(page.pageHash) ||
    !Array.isArray(page.outcomes) ||
    page.outcomes.length !== page.visited ||
    page.outcomes.some(
      (row, i) =>
        !row ||
        typeof row.productId !== 'string' ||
        !row.productId ||
        !statuses.has(row.status) ||
        (i > 0
          ? row.productId <= page.outcomes[i - 1].productId
          : afterId && row.productId <= afterId),
    ) ||
    page.outcomes.filter((row) => row.status === 'repaired').length !== page.repaired ||
    !Array.isArray(page.deferred) ||
    page.deferred.some((id) => !page.outcomes.some((row) => row.productId === id)) ||
    (page.nextId !== null &&
      (page.visited !== 20 || page.nextId !== page.outcomes.at(-1)?.productId)) ||
    (mode === 'dry-run' && page.repaired !== 0)
  )
    throw new Error('Unconfirmed pricing page; do not advance the checkpoint.');
  if (page.stopped !== null)
    throw new Error(
      `Pricing page stopped: ${page.stopped ?? 'invalid status'}. Re-audit this page.`,
    );
  if (
    (mode === 'dry-run' &&
      page.outcomes.filter((row) => row.status === 'eligible').length !== page.eligible) ||
    (mode === 'apply' &&
      (page.eligible !== page.repaired || page.outcomes.some((row) => row.status === 'eligible')))
  )
    throw new Error('Unconfirmed eligible/repaired counts; do not advance the checkpoint.');
  return page;
}

export async function auditCatalog(call, save, manifest) {
  if (manifest.status !== 'collecting')
    throw new Error('Audit is already complete; use a new manifest for a new inventory.');
  for (;;) {
    const afterId = manifest.pages.at(-1)?.result.nextId ?? undefined;
    const result = verifyPage(
      await call({ mode: 'dry-run', ...(afterId ? { afterId } : {}) }),
      'dry-run',
      afterId,
    );
    manifest.pages.push({ afterId: afterId ?? null, result });
    if (result.nextId === null) manifest.status = 'ready';
    await save(manifest);
    if (manifest.status === 'ready') return manifest;
  }
}

export async function applyCatalog(call, save, manifest, verifyProduct) {
  if (
    manifest.status === 'reconciliation-required' ||
    manifest.pages.some((page) => page.attempt && page.attempt.status !== 'verified')
  )
    throw new Error(
      'Reconciliation required: verify every eligible product on the attempted page, then create a new audit manifest. Do not replay this manifest.',
    );
  if (!['ready', 'applying'].includes(manifest.status))
    throw new Error('A completed dry-run manifest is required.');
  manifest.status = 'applying';
  await save(manifest);
  while (manifest.nextApplyIndex < manifest.pages.length) {
    const page = manifest.pages[manifest.nextApplyIndex];
    page.attempt = { status: 'pending', startedAt: new Date().toISOString() };
    await save(manifest);
    try {
      const response = await call({
        mode: 'apply',
        expectedPageHash: page.result.pageHash,
        ...(page.afterId ? { afterId: page.afterId } : {}),
      });
      page.attempt = { ...page.attempt, status: 'received', response };
      await save(manifest);
      const result = verifyPage(response, 'apply', page.afterId);
      if (result.pageHash !== page.result.pageHash)
        throw new Error('Applied response does not match the audited page.');
      for (const row of result.outcomes.filter((row) => row.status === 'repaired'))
        await verifyProduct(row);
      page.applied = result;
      page.attempt.status = 'verified';
      manifest.nextApplyIndex++;
      await save(manifest);
    } catch (error) {
      page.attempt.status = 'unconfirmed';
      manifest.status = 'reconciliation-required';
      await save(manifest);
      throw error;
    }
  }
  manifest.status = 'applied';
  await save(manifest);
  return manifest;
}

function totals(manifest) {
  const counts = {};
  for (const page of manifest.pages)
    for (const row of (page.applied ?? page.result).outcomes)
      counts[row.status] = (counts[row.status] ?? 0) + 1;
  return {
    status: manifest.status,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
  };
}

async function main() {
  const [mode, file, url] = process.argv.slice(2);
  if (!['audit', 'apply', 'resume-audit'].includes(mode) || !file || !url)
    throw new Error(
      'Usage: CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-repair.mjs audit|resume-audit|apply /private/manifest.json https://API-ORIGIN',
    );
  const api = new URL(url);
  if (
    api.origin !== url.replace(/\/$/, '') ||
    api.username ||
    api.password ||
    (api.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(api.hostname))
  )
    throw new Error('Use an explicit HTTPS API origin (HTTP allowed only for local verification).');
  const token = process.env.CHANNEL_ADMIN_TOKEN;
  if (!token) throw new Error('CHANNEL_ADMIN_TOKEN is required; never pass it as a CLI argument.');
  const save = async (value) => {
    const temporary = `${file}.next`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };
  const request = async (path, body) => {
    const response = await fetch(`${api.origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(
        `API read/write unconfirmed (${response.status}, ${result.error?.code ?? 'unknown'}). Re-audit before retrying.`,
      );
    return result.data;
  };
  const call = (data) =>
    request('/api/alibaba-catalog-sync', { action: 'repairSourcePricing', token, data });
  let manifest;
  if (mode === 'audit') {
    manifest = {
      schemaVersion: 'catalog-price-repair-v1',
      apiOrigin: api.origin,
      createdAt: new Date().toISOString(),
      status: 'collecting',
      pages: [],
      nextApplyIndex: 0,
    };
    await writeFile(file, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
  } else {
    manifest = JSON.parse(await readFile(file, 'utf8'));
    if (
      manifest.schemaVersion !== 'catalog-price-repair-v1' ||
      manifest.apiOrigin !== api.origin ||
      !Array.isArray(manifest.pages) ||
      !Number.isSafeInteger(manifest.nextApplyIndex) ||
      manifest.nextApplyIndex < 0 ||
      manifest.nextApplyIndex > manifest.pages.length
    )
      throw new Error('Manifest identity/format does not match the requested operation.');
  }
  if (mode === 'apply') {
    await applyCatalog(call, save, manifest, async (row) => {
      const product = await request('/api/admin', {
        action: 'get',
        token,
        data: { collection: 'products', id: row.productId },
      });
      if (product.published !== true) return; // All private products were already read back by the fenced operation.
      const projected = await request(`/api/products/${encodeURIComponent(row.productId)}`);
      const price = Object.fromEntries(
        Object.entries(row.proposedPricing).filter(
          ([key]) => !['sourceOfferKey', 'sourceProductId', 'sourceSkuId'].includes(key),
        ),
      );
      if (!isDeepStrictEqual(projected.alibabaCatalogPricing, price))
        throw new Error(`Public price verification failed for ${row.productId}.`);
    });
    // A fresh inventory is required to account for concurrent additions and deferred records.
    const after = {
      schemaVersion: 'catalog-price-repair-v1',
      apiOrigin: api.origin,
      createdAt: new Date().toISOString(),
      status: 'collecting',
      pages: [],
      nextApplyIndex: 0,
    };
    await auditCatalog(
      call,
      async (value) =>
        writeFile(`${file}.after.json`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }),
      after,
    );
    console.log(JSON.stringify({ applied: totals(manifest), reAudit: totals(after) }, null, 2));
    if (after.pages.some((page) => page.result.eligible > 0)) process.exitCode = 2;
  } else {
    await auditCatalog(call, save, manifest);
    console.log(JSON.stringify(totals(manifest), null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
