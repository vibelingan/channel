#!/usr/bin/env node
/**
 * Local-only Dianxiaomi import CLI.
 *
 * Runs the whole pipeline against a file on this machine and a file-backed
 * database. It never contacts CloudBase, never reads a secret, and never
 * copies the source workbook into the database — only its SHA-256, the
 * normalized records, and the findings.
 *
 *   # what columns does this file actually have?
 *   pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \
 *     --file "/path/to/export.xlsx" --headers
 *
 *   # parse and report, writing nothing
 *   LOCAL_DB_FILE=./data/db.dianxiaomi-spike.json \
 *   pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \
 *     --file "/path/to/export.xlsx" --dry-run
 *
 *   # parse, stage, and show the delta against what is already stored
 *   LOCAL_DB_FILE=./data/db.dianxiaomi-spike.json \
 *   LOCAL_MEDIA_DIR=./data/media-dianxiaomi-spike \
 *   pnpm --filter @vibelingan-channel/local-server import:dianxiaomi -- \
 *     --file "/path/to/export.xlsx"
 *
 * `--headers` exists because the header alias table has to be calibrated
 * against a real export exactly once, and guessing at it from a failed import
 * is a much worse way to spend an afternoon.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  parseDianxiaomiWorkbook,
  readDianxiaomiRows,
} from '@vibelingan-channel/catalog-import/dianxiaomi';
import { setAdapter } from '@vibelingan-channel/db';
import { publishImportedSample } from '@vibelingan-channel/fn-admin/catalog-import-publish';
import {
  computeImportDelta,
  runCatalogImport,
} from '@vibelingan-channel/fn-admin/catalog-import-service';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import { optionalEnv } from '@vibelingan-channel/shared';
import { JsonFileAdapter } from './json-adapter.ts';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    headers: { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false },
    publish: { type: 'string' },
    'fetch-images': { type: 'string' },
    json: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

function usage(): never {
  console.log(
    [
      'Usage: import:dianxiaomi --file <path.xlsx> [options]',
      '',
      '  --headers            print the source header row and exit (no writes)',
      '  --dry-run            parse and report; write nothing to the database',
      '  --replay             re-import bytes already imported, as a new job',
      '  --publish <n>        publish at most n staged products into the catalog',
      '  --fetch-images <n>   download at most n source images into LOCAL_MEDIA_DIR',
      '  --json <path>        write a redacted machine-readable summary',
      '',
      'Environment: LOCAL_DB_FILE, LOCAL_MEDIA_DIR',
    ].join('\n'),
  );
  process.exit(values.help === true ? 0 : 1);
}

if (values.help === true || typeof values.file !== 'string' || values.file === '') usage();

const filePath = resolve(process.cwd(), values.file);
const bytes = readFileSync(filePath);
const sourceFileName = filePath.split('/').pop() ?? 'workbook.xlsx';

// --- --headers: no database, no writes, no side effects --------------------
if (values.headers === true) {
  const read = readDianxiaomiRows(bytes);
  console.log(`file: ${sourceFileName} (${bytes.length} bytes)`);
  console.log(`columns found (${read.headerLabels.length}):`);
  read.headerLabels.forEach((label: string, index: number) => {
    console.log(`  ${String(index + 1).padStart(3)}  ${label}`);
  });
  if (!read.ok) {
    console.log('');
    console.log('structural findings:');
    for (const finding of read.findings) console.log(`  [${finding.code}] ${finding.message}`);
    process.exit(1);
  }
  console.log('');
  console.log(
    `unrecognised columns (${read.ignoredHeaders.length}): ${read.ignoredHeaders.join(', ') || '(none)'}`,
  );
  process.exit(0);
}

const percent = (part: number, whole: number) =>
  whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;

function printSummary(detail: ReturnType<typeof parseDianxiaomiWorkbook>): void {
  const variants = detail.bundle.products.reduce(
    (total, product) => total + product.variants.length,
    0,
  );
  console.log('');
  console.log('  source');
  console.log(`    file             ${sourceFileName}`);
  console.log(`    sha256           ${detail.bundle.sourceFileSha256}`);
  console.log(`    template         ${detail.bundle.templateId}`);
  console.log(`    sheet            ${detail.sheetName}`);
  console.log('');
  console.log('  cardinalities');
  console.log(`    rows             ${detail.counts.rows}`);
  console.log(`    parentSkus       ${detail.counts.parentSkus}`);
  console.log(`    skus             ${detail.counts.skus}`);
  console.log(`    storeProducts    ${detail.counts.storeProducts}`);
  console.log(`    storeVariants    ${detail.counts.storeVariants}`);
  console.log(`    stores           ${detail.counts.stores}`);
  console.log(`    uniqueImageUrls  ${detail.counts.uniqueImageUrls}`);
  console.log(`    imageReferences  ${detail.counts.imageReferences}`);
  console.log('');
  console.log('  candidates');
  console.log(`    products         ${detail.bundle.products.length}`);
  console.log(`    variants         ${variants}`);
  console.log(`    storeListings    ${detail.storeListings.length}`);
  console.log(`    quarantined      ${detail.quarantined.length}`);
  console.log('');

  const known = detail.inventory.filter((entry) => entry.resolution.state === 'known').length;
  const conflict = detail.inventory.filter((entry) => entry.resolution.state === 'conflict').length;
  const unknown = detail.inventory.filter((entry) => entry.resolution.state === 'unknown').length;
  console.log('  inventory');
  console.log(`    exact            ${known} (${percent(known, detail.inventory.length)})`);
  console.log(`    conflicting      ${conflict}`);
  console.log(`    unknown          ${unknown}`);
  console.log('');

  const byCode = new Map<string, number>();
  for (const finding of detail.bundle.findings) {
    byCode.set(finding.code, (byCode.get(finding.code) ?? 0) + 1);
  }
  console.log(`  findings (${detail.bundle.findings.length})`);
  for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${code.padEnd(34)} ${count}`);
  }
  if (detail.bundle.ignoredHeaders.length > 0) {
    console.log('');
    console.log(`  unrecognised columns: ${detail.bundle.ignoredHeaders.join(', ')}`);
  }
  console.log('');
  console.log('  Prices above are SOURCE CNY. USD website prices stay OFF until the');
  console.log('  margin mode, input price, FX source and rounding rule are settled.');
  console.log('');
}

// --- --dry-run: parse and report, touch nothing ----------------------------
if (values['dry-run'] === true) {
  const detail = parseDianxiaomiWorkbook(bytes);
  printSummary(detail);
  if (typeof values.json === 'string') writeRedactedJson(values.json, detail, null);
  process.exit(detail.structurallyValid ? 0 : 1);
}

// --- full run: needs a database --------------------------------------------
const dbFile = resolve(
  process.cwd(),
  optionalEnv('LOCAL_DB_FILE', './data/db.dianxiaomi-spike.json'),
);
const mediaDir = resolve(
  process.cwd(),
  optionalEnv('LOCAL_MEDIA_DIR', './data/media-dianxiaomi-spike'),
);
setAdapter(new JsonFileAdapter(dbFile));
setMediaStorage(new LocalDiskMediaStorage(mediaDir));
console.log(`[import] database: ${dbFile}`);
console.log(`[import] media:    ${mediaDir}`);

const result = await runCatalogImport({
  bytes,
  sourceFileName,
  ...(values.replay === true ? { replay: true } : {}),
});

if (result.reused) {
  console.log('');
  console.log(`  This file was already imported as job ${result.job._id}.`);
  console.log('  Nothing was re-staged. Pass --replay to import it again as a new job.');
  console.log('');
  process.exit(0);
}

printSummary(result.detail);
console.log(`  job              ${result.job._id}`);
console.log(`  status           ${String(result.job.status)}`);

const delta = await computeImportDelta(result.detail);
console.log('');
console.log('  delta against stored source state');
console.log(`    added            ${delta.added.length}`);
console.log(`    changed          ${delta.changed.length}`);
console.log(`    unchanged        ${delta.unchanged.length}`);
console.log(`    source-missing   ${delta.sourceMissing.length} (never deleted automatically)`);
for (const entry of delta.changed.slice(0, 5)) {
  const fields = entry.changes.map((change) => change.field).join(', ');
  console.log(`      ${entry.storeKey} / ${entry.sku}: ${fields}`);
}
console.log('');

let published: Awaited<ReturnType<typeof publishImportedSample>> | null = null;
if (typeof values.publish === 'string') {
  const limit = Number.parseInt(values.publish, 10);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    console.error('--publish expects a non-negative whole number');
    process.exit(1);
  }
  published = await publishImportedSample({
    jobId: String(result.job._id),
    limit,
    ...(typeof values['fetch-images'] === 'string'
      ? { fetchImages: Number.parseInt(values['fetch-images'], 10) }
      : {}),
  });
  console.log('  publish');
  console.log(`    products         ${published.products}`);
  console.log(`    variants         ${published.variants}`);
  console.log(`    sourceLinks      ${published.sourceLinks}`);
  console.log(`    imagesMigrated   ${published.imagesMigrated}`);
  console.log(`    imagesFailed     ${published.imagesFailed}`);
  console.log(`    publishedPublic  ${published.publishedPublic}`);
  console.log(`    blocked          ${published.blocked.length}`);
  for (const blocked of published.blocked.slice(0, 5)) {
    console.log(`      ${blocked.parentSku}: ${blocked.reason}`);
  }
  console.log('');
}

if (typeof values.json === 'string') writeRedactedJson(values.json, result.detail, delta);

/**
 * A summary safe to attach to a review.
 *
 * Titles, SKUs, store names, image URLs and descriptions are customer data and
 * are deliberately absent: the counts and finding codes are what a reviewer
 * needs, and the workbook contents are not theirs to circulate.
 */
function writeRedactedJson(
  target: string,
  detail: ReturnType<typeof parseDianxiaomiWorkbook>,
  deltaReport: Awaited<ReturnType<typeof computeImportDelta>> | null,
): void {
  const byCode: Record<string, number> = {};
  for (const finding of detail.bundle.findings) {
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFileSha256: detail.bundle.sourceFileSha256,
    sourceByteSize: bytes.length,
    templateId: detail.bundle.templateId,
    structurallyValid: detail.structurallyValid,
    counts: detail.counts,
    candidates: {
      products: detail.bundle.products.length,
      variants: detail.bundle.products.reduce((total, p) => total + p.variants.length, 0),
      storeListings: detail.storeListings.length,
      quarantined: detail.quarantined.length,
    },
    inventory: {
      known: detail.inventory.filter((entry) => entry.resolution.state === 'known').length,
      conflict: detail.inventory.filter((entry) => entry.resolution.state === 'conflict').length,
      unknown: detail.inventory.filter((entry) => entry.resolution.state === 'unknown').length,
    },
    findingsByCode: byCode,
    unrecognisedColumnCount: detail.bundle.ignoredHeaders.length,
    ...(deltaReport === null
      ? {}
      : {
          delta: {
            added: deltaReport.added.length,
            changed: deltaReport.changed.length,
            unchanged: deltaReport.unchanged.length,
            sourceMissing: deltaReport.sourceMissing.length,
            completeSource: deltaReport.completeSource,
          },
        }),
  };
  writeFileSync(resolve(process.cwd(), target), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`  redacted summary written to ${target}`);
}
