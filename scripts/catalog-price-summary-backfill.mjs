/**
 * One-time backfill of approved price summaries (MIU-7, runbook R4).
 * Credentials stay in CHANNEL_ADMIN_TOKEN; the manifest is written owner-only.
 *
 *   CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-summary-backfill.mjs plan  /private/m.json https://API-ORIGIN
 *   CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-summary-backfill.mjs apply /private/m.json https://API-ORIGIN
 *
 * `plan` is read-only. `apply` sends the plan's `ready` rows (the server re-checks
 * each revision), then re-plans and exits 2 if anything is still `ready`.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BATCH = 20;
const SCHEMA = 'catalog-price-summary-backfill-v1';

/** @param {(data: object) => Promise<{rows: object[], nextAfterId?: string, done: boolean}>} call */
export async function planAll(call) {
  const rows = [];
  let afterId;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await call(afterId ? { mode: 'plan', afterId } : { mode: 'plan' });
    rows.push(...page.rows);
    if (page.done || !page.nextAfterId || page.nextAfterId === afterId) return rows;
    afterId = page.nextAfterId;
  }
  throw new Error('Plan did not finish; refusing to continue.');
}

/**
 * R4 review: `ready` rows whose card price would come from a product-level offer
 * although the product has configurations (possibly the retired wholesale
 * headline). Read this on the saved plan, before apply.
 */
export function productPriceWithConfigurations(rows) {
  return rows
    .filter(
      (row) =>
        row.outcome === 'ready' && row.priceSummary?.source === 'product' && row.variantCount > 0,
    )
    .map((row) => row.productId);
}

export function countOutcomes(rows) {
  const counts = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}

/** Applied vs skipped-by-reason totals for an apply run. */
export function tallyResults(results) {
  const tally = {};
  for (const { result } of results) {
    const key =
      result?.backfill === 'applied' ? 'applied' : `skipped:${result?.reason ?? 'unknown'}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/**
 * Sends only `ready` rows, in batches; throws on any unconfirmed row. Rows already
 * confirmed are on the error's `results`, so the receipt survives a partial run.
 */
export async function applyReadyRows(call, rows) {
  const ready = rows
    .filter((row) => row.outcome === 'ready')
    .map(({ productId, revision, priceSummary }) => ({ productId, revision, priceSummary }));
  const results = [];
  const stop = (message) => Object.assign(new Error(message), { results });
  for (let start = 0; start < ready.length; start += BATCH) {
    let response;
    try {
      response = await call({ mode: 'apply', rows: ready.slice(start, start + BATCH) });
    } catch (error) {
      throw stop(`${error.message} — ${results.length} rows were confirmed before it.`);
    }
    // The server answers every row it was sent; keep every confirmed one
    // before reporting the first failure, so the receipt is complete.
    const sent = Math.min(BATCH, ready.length - start);
    const failed = response.results.find((item) => item.result?.ok !== true);
    results.push(...response.results.filter((item) => item.result?.ok === true));
    if (failed)
      throw stop(
        `${failed.productId}: ${failed.result?.code ?? 'unconfirmed'} — re-plan before retrying.`,
      );
    if (response.results.length !== sent)
      throw stop(`The server confirmed ${response.results.length} of ${sent} rows — re-plan.`);
  }
  return results;
}

async function main() {
  const [mode, file, url] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(mode) || !file || !url)
    throw new Error(
      'Usage: CHANNEL_ADMIN_TOKEN=… node scripts/catalog-price-summary-backfill.mjs plan|apply /private/manifest.json https://API-ORIGIN',
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
  const call = async (data) => {
    const response = await fetch(`${api.origin}/api/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'backfillPublicationPriceSummary', token, data }),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok || !result.ok)
      throw new Error(
        `API call unconfirmed (${response.status}, ${result.error?.code ?? 'unknown'}).`,
      );
    return result.data;
  };
  const save = async (value) => {
    const temporary = `${file}.next`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };
  if (mode === 'plan') {
    const rows = await planAll(call);
    await writeFile(
      file,
      `${JSON.stringify({ schemaVersion: SCHEMA, apiOrigin: api.origin, createdAt: new Date().toISOString(), rows }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    console.log(
      JSON.stringify(
        {
          ...countOutcomes(rows),
          productPriceWithConfigurations: productPriceWithConfigurations(rows),
        },
        null,
        2,
      ),
    );
    return;
  }
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (
    manifest.schemaVersion !== SCHEMA ||
    manifest.apiOrigin !== api.origin ||
    !Array.isArray(manifest.rows)
  )
    throw new Error('Manifest identity/format does not match the requested operation.');
  try {
    manifest.results = await applyReadyRows(call, manifest.rows);
  } catch (error) {
    manifest.results = error.results ?? [];
    manifest.failedAt = new Date().toISOString();
    manifest.failure = error.message;
    await save(manifest);
    throw error;
  }
  // A successful re-run replaces the record of an earlier failure.
  const { failedAt: _failedAt, failure: _failure, ...applied } = manifest;
  await save({ ...applied, appliedAt: new Date().toISOString() });
  const after = countOutcomes(await planAll(call));
  console.log(
    JSON.stringify({ results: tallyResults(manifest.results), afterPlan: after }, null, 2),
  );
  if ((after.ready ?? 0) > 0) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
