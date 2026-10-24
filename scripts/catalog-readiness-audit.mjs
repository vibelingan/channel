/** Read-only, resumable private inventory. A consistent scan never authorizes publication. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesCatalogReadiness } from '../packages/db/src/catalog-readiness-query.ts';
import { productFamilyForDoc } from '../packages/shared/src/catalog-product.ts';
import {
  ADMIN_PRODUCT_LIST_VIEW,
  isAdminProductListRow,
} from '../packages/shared/src/catalog/admin-product-list.ts';
import {
  CATALOG_PREPARATION_POLICY,
  CatalogPreparationReportSchema,
  readCurrentCatalogPreparation,
  readCurrentCatalogPreparationRequest,
} from '../packages/shared/src/catalog/preparation.ts';
import { decodeUtf8, fetchFully } from './smoke-http.mjs';

const SCHEMA = 'catalog-readiness-shadow-v1';
const PAGE_SIZE = 100;
const MAX_ROWS = 100_000;
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const scopes = ['normal', 'issues', 'preparing', 'unchecked'];
const preparationFields = new Set([
  'catalogPreparationReport',
  'catalogPreparationRequest',
  'catalogPreparationState',
  'catalogPreparationPolicy',
]);
const rootKeys = [
  'schemaVersion',
  'apiOrigin',
  'actorId',
  'policyVersion',
  'catalogListView',
  'startedAt',
  'phase',
  'rows',
  'verification',
  'rowsHash',
  'verificationHash',
];
const rowKeys = [
  'productId',
  'rowHash',
  'businessHash',
  'readiness',
  'published',
  'archived',
  'classified',
  'malformedReport',
  'projectionMismatch',
];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function canonical(value, depth = 0) {
  if (depth > 64) throw Error('Audit input is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonical(entry, depth + 1)).join(',')}]`;
  if (record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`)
      .join(',')}}`;
  }
  throw Error('Audit requires plain JSON input.');
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const seal = (value) => ({
  ...value,
  rowsHash: digest(value.rows),
  verificationHash: digest(value.verification),
});

function origin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('Invalid audit API origin.');
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  ) {
    throw Error('An explicit HTTPS API origin is required; HTTP is allowed only for localhost.');
  }
  return value;
}

export function createReadinessAudit(context) {
  if (!id(context.actorId)) throw Error('An explicit administrator identity is required.');
  return seal({
    schemaVersion: SCHEMA,
    apiOrigin: origin(context.apiOrigin),
    actorId: context.actorId,
    policyVersion: CATALOG_PREPARATION_POLICY,
    catalogListView: ADMIN_PRODUCT_LIST_VIEW,
    startedAt: new Date().toISOString(),
    phase: 'collecting',
    rows: [],
    verification: [],
  });
}

function validate(manifest, context) {
  if (
    !exactKeys(manifest, rootKeys) ||
    manifest.schemaVersion !== SCHEMA ||
    manifest.apiOrigin !== origin(context.apiOrigin) ||
    manifest.actorId !== context.actorId ||
    !id(manifest.actorId) ||
    manifest.policyVersion !== CATALOG_PREPARATION_POLICY ||
    manifest.catalogListView !== ADMIN_PRODUCT_LIST_VIEW ||
    typeof manifest.startedAt !== 'string' ||
    manifest.startedAt.length > 40 ||
    !Number.isFinite(Date.parse(manifest.startedAt)) ||
    !['collecting', 'reconciling', 'complete', 'changed'].includes(manifest.phase)
  ) {
    throw Error('Audit identity, policy, or format does not match.');
  }
  for (const [key, hash] of [
    ['rows', 'rowsHash'],
    ['verification', 'verificationHash'],
  ]) {
    const entries = manifest[key];
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_ROWS ||
      !hex(manifest[hash]) ||
      entries.some(
        (row, i) =>
          !exactKeys(row, rowKeys) ||
          !id(row.productId) ||
          !hex(row.rowHash) ||
          !hex(row.businessHash) ||
          !scopes.includes(row.readiness) ||
          rowKeys.slice(4).some((field) => typeof row[field] !== 'boolean') ||
          (i > 0 && row.productId <= entries[i - 1].productId),
      ) ||
      digest(entries) !== manifest[hash]
    ) {
      throw Error('Audit checkpoint rows, order, or hash are invalid.');
    }
  }
  if (
    (manifest.phase === 'collecting' && manifest.verification.length) ||
    (manifest.phase === 'complete' && manifest.rowsHash !== manifest.verificationHash) ||
    (manifest.phase === 'changed' && manifest.rowsHash === manifest.verificationHash)
  )
    throw Error('Audit checkpoint phase is inconsistent.');
}

function summarizeProduct(product, productId) {
  if (!record(product) || product._id !== productId)
    throw Error('The full product identity could not be checked.');
  const report = readCurrentCatalogPreparation(product);
  const request = readCurrentCatalogPreparationRequest(product);
  const readiness =
    product.published === true || report?.state === 'ready'
      ? 'normal'
      : report?.state === 'blocked'
        ? 'issues'
        : report?.state === 'preparing' || request
          ? 'preparing'
          : 'unchecked';
  return {
    productId,
    rowHash: digest(product),
    businessHash: digest(
      Object.fromEntries(Object.entries(product).filter(([key]) => !preparationFields.has(key))),
    ),
    readiness,
    published: product.published === true,
    archived: product.archived === true,
    classified: productFamilyForDoc(product) !== null,
    malformedReport:
      product.catalogPreparationReport != null &&
      !CatalogPreparationReportSchema.safeParse(product.catalogPreparationReport).success,
    projectionMismatch: scopes.some(
      (scope) => matchesCatalogReadiness(product, scope) !== (scope === readiness),
    ),
  };
}

/** Each page is checkpointed only after every full read succeeds. No write action is sent. */
export async function auditReadiness(call, save, manifest, context) {
  validate(manifest, context);
  if (!['collecting', 'reconciling'].includes(manifest.phase)) {
    throw Error('This audit is finished; start a new audit file for a fresh inventory.');
  }
  let current = structuredClone(manifest);
  while (['collecting', 'reconciling'].includes(current.phase)) {
    const field = current.phase === 'collecting' ? 'rows' : 'verification';
    const afterId = current[field].at(-1)?.productId ?? '';
    const page = await call('list', {
      collection: 'products',
      page: 1,
      pageSize: PAGE_SIZE,
      catalogReadiness: 'all',
      catalogListView: ADMIN_PRODUCT_LIST_VIEW,
      sort: [{ field: '_id', dir: 'asc' }],
      ...(afterId
        ? { filter: { combinator: 'and', clauses: [{ field: '_id', op: 'gt', value: afterId }] } }
        : {}),
    });
    if (
      !record(page) ||
      page.page !== 1 ||
      page.pageSize !== PAGE_SIZE ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      page.catalogListView !== ADMIN_PRODUCT_LIST_VIEW ||
      !Array.isArray(page.items) ||
      page.items.length > PAGE_SIZE ||
      page.items.some(
        (row, i) =>
          !record(row) ||
          !id(row._id) ||
          !isAdminProductListRow(row) ||
          row._id <= (i > 0 ? page.items[i - 1]._id : afterId),
      )
    ) {
      throw Error('Audit list identity, ordering, or view could not be checked.');
    }
    let next;
    if (page.items.length === 0) {
      next = {
        ...current,
        phase:
          field === 'rows'
            ? 'reconciling'
            : current.rowsHash === current.verificationHash
              ? 'complete'
              : 'changed',
      };
    } else {
      if (current[field].length + page.items.length > MAX_ROWS)
        throw Error('Audit row limit reached; no completion claimed.');
      const entries = await readPage(call, page.items);
      next = seal({ ...current, [field]: [...current[field], ...entries] });
    }
    validate(next, context);
    await save(structuredClone(next));
    current = next;
  }
  return current;
}

async function readPage(call, rows) {
  const entries = new Array(rows.length);
  let cursor = 0;
  let failed = false;
  // Offline maintenance only: four bounded reads; no full GETs added to the UI list.
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (!failed && cursor < rows.length) {
        const index = cursor++;
        const row = rows[index];
        try {
          entries[index] = summarizeProduct(
            await call('get', { collection: 'products', id: row._id }),
            row._id,
          );
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  // Drain every in-flight read before releasing the report lock or returning an error.
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
  return entries;
}

export function summarizeReadinessAudit(manifest) {
  validate(manifest, manifest);
  const counts = Object.fromEntries(scopes.map((scope) => [scope, 0]));
  for (const row of manifest.rows) counts[row.readiness]++;
  return {
    phase: manifest.phase,
    nonTransactional: true,
    total: manifest.rows.length,
    verifiedTotal: manifest.verification.length,
    counts,
    archived: manifest.rows.filter((row) => row.archived).length,
    malformedReports: manifest.rows.filter((row) => row.malformedReport).length,
    projectionMismatches: manifest.rows.filter((row) => row.projectionMismatch).length,
    rowsHash: manifest.rowsHash,
    verificationHash: manifest.verificationHash,
  };
}

async function readPrivate(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_CHECKPOINT_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error('Audit file must be an owner-only regular file.');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Cooperative lock plus atomic private checkpoints; never follows a manifest symlink. */
export async function openReadinessAuditFile(filePath, mode, initial) {
  if (!['audit', 'resume-audit'].includes(mode)) throw Error('Unknown audit mode.');
  const file = resolve(filePath);
  const lock = `${file}.lock`;
  await mkdir(lock, { mode: 0o700 });
  const lockIdentity = await lstat(lock);
  const close = async () => {
    const current = await lstat(lock);
    if (
      current.ino !== lockIdentity.ino ||
      current.dev !== lockIdentity.dev ||
      !current.isDirectory()
    )
      throw Error('Audit lock ownership changed.');
    await rmdir(lock);
  };
  try {
    if (mode === 'audit') {
      validate(initial, initial);
      const text = checkpointText(initial);
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    let expected = await readPrivate(file);
    const manifest = parseAuditJson(expected);
    validate(manifest, manifest);
    return {
      manifest,
      close,
      async save(value) {
        validate(value, manifest);
        const text = checkpointText(value);
        const temporary = `${file}.${randomUUID()}.next`;
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(text);
            await handle.sync();
          } finally {
            await handle.close();
          }
          if ((await readPrivate(file)) !== expected)
            throw Error('Audit file changed outside this run; refusing to overwrite it.');
          await rename(temporary, file);
          expected = text;
        } finally {
          await rm(temporary, { force: true });
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function checkpointText(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES)
    throw Error('Audit checkpoint size limit reached; prior progress is retained.');
  return text;
}

function parseAuditJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw Error('Audit JSON could not be checked; no response body or credentials are logged.');
  }
}

export function adminReadOnlyTransport(apiOrigin, token) {
  origin(apiOrigin);
  if (typeof token !== 'string' || token.length === 0)
    throw Error('CHANNEL_ADMIN_TOKEN is required.');
  return async (action, data) => {
    if (
      !['list', 'get', 'me'].includes(action) ||
      (action !== 'me' && data?.collection !== 'products')
    )
      throw Error('Only read-only product audit actions are permitted.');
    const response = await fetchFully('POST', `${apiOrigin}/api/admin`, {
      body: JSON.stringify({ action, token, ...(data ? { data } : {}) }),
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
    });
    const result = parseAuditJson(decodeUtf8(response.body));
    if (response.status !== 200 || result?.ok !== true)
      throw Error(`Read-only audit request unconfirmed (${response.status}).`);
    return result.data;
  };
}

async function main() {
  const [mode, file, apiOrigin] = process.argv.slice(2);
  if (!['audit', 'resume-audit'].includes(mode) || !file || !apiOrigin)
    throw Error(
      'Usage: CHANNEL_ADMIN_TOKEN=… node --experimental-strip-types scripts/catalog-readiness-audit.mjs audit|resume-audit /private/report.json https://API-ORIGIN',
    );
  const call = adminReadOnlyTransport(apiOrigin, process.env.CHANNEL_ADMIN_TOKEN);
  const account = (await call('me'))?.user;
  if (!id(account?.id) || account.role !== 'admin' || account.status !== 'active')
    throw Error('An active administrator is required.');
  const context = { apiOrigin, actorId: account.id };
  const store = await openReadinessAuditFile(
    file,
    mode,
    mode === 'audit' ? createReadinessAudit(context) : undefined,
  );
  try {
    const result = await auditReadiness(call, store.save, store.manifest, context);
    console.log(JSON.stringify(summarizeReadinessAudit(result), null, 2));
    if (result.phase !== 'complete') process.exitCode = 2;
  } finally {
    await store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
