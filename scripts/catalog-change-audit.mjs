/**
 * One-time "changed since approval" audit (MIU-38, runbook R6). The work runs
 * on the server (admin action `auditChangesSinceApproval`); this script pages
 * through it and keeps a receipt. Credentials stay in CHANNEL_ADMIN_TOKEN; the
 * manifest is written owner-only.
 *
 *   CHANNEL_ADMIN_TOKEN=… node scripts/catalog-change-audit.mjs plan  /private/audit.json https://API-ORIGIN
 *   CHANNEL_ADMIN_TOKEN=… node scripts/catalog-change-audit.mjs apply /private/audit.json https://API-ORIGIN
 *
 * `plan` is read-only and lists every "changed" product with what differs.
 * `apply` sends the reviewed `unchanged` and `changed` rows (the server
 * re-plans each one), then re-plans: done when no `unchanged` row is left.
 * "changed" rows stay listed until an admin re-approves them (R7).
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { countOutcomes, planAll } from './catalog-price-summary-backfill.mjs';

const BATCH = 20;
const SCHEMA = 'catalog-change-audit-v1';
const ACTION = 'auditChangesSinceApproval';

/** Rows the server may write: the reviewed outcome, nothing the caller could forge. */
export function auditRowsToApply(rows) {
  return rows
    .filter((row) => row.outcome === 'unchanged' || row.outcome === 'changed')
    .map(({ productId, revision, outcome }) => ({ productId, revision, outcome }));
}

/** Sends rows in batches; every confirmed row is kept even when a later one fails. */
export async function applyAuditRows(call, rows) {
  const sendable = auditRowsToApply(rows);
  const results = [];
  const stop = (message) => Object.assign(new Error(message), { results });
  for (let start = 0; start < sendable.length; start += BATCH) {
    const sent = sendable.slice(start, start + BATCH);
    let response;
    try {
      response = await call({ mode: 'apply', rows: sent });
    } catch (error) {
      throw stop(`${error.message} — ${results.length} rows were confirmed before it.`);
    }
    if (!Array.isArray(response?.results) || response.results.length !== sent.length)
      throw stop(`Unconfirmed apply response — ${results.length} rows were confirmed before it.`);
    const failed = response.results.find((item) => item.result?.ok !== true);
    results.push(...response.results.filter((item) => item.result?.ok === true));
    if (failed)
      throw stop(
        `${failed.productId}: ${failed.result?.code ?? 'unconfirmed'} — re-plan before retrying.`,
      );
  }
  return results;
}

/** What to read before applying: counts, and what differs on each changed product. */
export function summarize(rows) {
  return {
    ...countOutcomes(rows),
    changed: rows
      .filter((row) => row.outcome === 'changed')
      .map(({ productId, differences }) => ({ productId, differences })),
  };
}

async function main() {
  const [mode, file, url] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(mode) || !file || !url)
    throw new Error(
      'Usage: CHANNEL_ADMIN_TOKEN=… node scripts/catalog-change-audit.mjs plan|apply /private/manifest.json https://API-ORIGIN',
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
      body: JSON.stringify({ action: ACTION, token, data }),
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
  if (mode === 'plan') {
    const rows = await planAll(call);
    await writeFile(
      file,
      `${JSON.stringify({ schemaVersion: SCHEMA, apiOrigin: api.origin, createdAt: new Date().toISOString(), rows }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    console.log(JSON.stringify(summarize(rows), null, 2));
    return;
  }
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (
    manifest.schemaVersion !== SCHEMA ||
    manifest.apiOrigin !== api.origin ||
    !Array.isArray(manifest.rows)
  )
    throw new Error('Manifest identity/format does not match the requested operation.');
  const save = async (value) => {
    const temporary = `${file}.next`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  };
  try {
    manifest.results = await applyAuditRows(call, manifest.rows);
  } catch (error) {
    await save({ ...manifest, results: error.results ?? [], failure: error.message });
    throw error;
  }
  await save({ ...manifest, appliedAt: new Date().toISOString() });
  const after = await planAll(call);
  console.log(
    JSON.stringify({ applied: manifest.results.length, afterPlan: summarize(after) }, null, 2),
  );
  if (after.some((row) => row.outcome === 'unchanged')) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
