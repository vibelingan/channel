/**
 * Read-only check that the product list and the product page agree (MIU-26,
 * runbook R5, R8, R10). Uses only the public API, so it needs no credentials.
 *
 *   node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN
 *   node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN --require-no-fallback
 *
 * For every listed product with an approved page it compares the name, the main
 * photo (by image id) and the card's price summary with the price the page's own
 * offers give under the approval rule (`derivePriceSummary`, imported, not copied).
 * Products without an approved page are on the row fallback and listed apart.
 * Exits 1 on any mismatch or unconfirmed read; with --require-no-fallback, also
 * when any product is still on the row fallback.
 */
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { derivePriceSummary } from '../packages/shared/src/catalog/price-summary.ts';

const LIST_PAGE_SIZE = 48; // public API maximum
const DETAIL_PAGE_SIZE = 50; // detail endpoint maximum
const SHOWN = 20;

/** The card price the approval rule gives for this page's prices. */
export function cardPriceFromDetail(detail, variants) {
  return derivePriceSummary({
    websitePricing: detail.websitePricing,
    offers: detail.offers ?? [],
    variants: variants.map(({ id, offers }) => ({ id, offers: offers ?? [] })),
  });
}

function photoId(source) {
  if (typeof source !== 'string') return undefined;
  const last = new URL(source, 'http://audit.invalid').pathname.split('/').pop();
  return last ? decodeURIComponent(last) : undefined;
}

async function mapPool(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const failure = (response) =>
  `${response.status} ${response.body?.error?.code ?? 'unconfirmed response'}`;

async function listAll(get, pageSize) {
  const cards = [];
  const seen = new Set();
  for (let page = 1; page <= 10_000; page++) {
    const response = await get(`/api/products?page=${page}&pageSize=${pageSize}`);
    if (response.status !== 200 || response.body?.ok !== true)
      throw new Error(`List page ${page} failed: ${failure(response)}`);
    const { items, total } = response.body.data;
    for (const item of items) {
      if (seen.has(item._id)) continue;
      seen.add(item._id);
      cards.push(item);
    }
    if (items.length === 0 || page * pageSize >= total) return cards;
  }
  throw new Error('List did not finish; refusing to report.');
}

/** One product's approved page with every configuration, or why there is none. */
async function readDetail(get, productId) {
  const base = `/api/products/${encodeURIComponent(productId)}/detail`;
  const first = await get(`${base}?page=1&pageSize=${DETAIL_PAGE_SIZE}`);
  if (first.status === 404) return { kind: 'fallback' };
  if (first.status !== 200 || first.body?.ok !== true)
    return { kind: 'error', message: failure(first) };
  const detail = first.body.data;
  const variants = [...detail.variants.items];
  let { hasMore } = detail.variants;
  for (let page = 2; hasMore; page++) {
    // Pin later pages to the first page's revision so a re-approval mid-read
    // fails loudly (CONFLICT) instead of mixing two versions.
    const response = await get(
      `${base}?page=${page}&pageSize=${DETAIL_PAGE_SIZE}&revision=${encodeURIComponent(detail.revision)}`,
    );
    if (response.status !== 200 || response.body?.ok !== true)
      return { kind: 'error', message: `configuration page ${page}: ${failure(response)}` };
    variants.push(...response.body.data.variants.items);
    hasMore = response.body.data.variants.hasMore;
  }
  return { kind: 'approved', detail, variants };
}

function compare(card, { detail, variants }) {
  const cardSide = {
    name: card.name,
    mainPhoto: photoId(card.images?.[0]),
    priceSummary: card.priceSummary,
  };
  const pageSide = {
    name: detail.name,
    mainPhoto: photoId(detail.images?.[0]),
    priceSummary: cardPriceFromDetail(detail, variants),
  };
  const fields = Object.keys(cardSide).filter(
    (field) => !isDeepStrictEqual(cardSide[field], pageSide[field]),
  );
  if (fields.length === 0) return undefined;
  const pick = (side) => Object.fromEntries(fields.map((field) => [field, side[field]]));
  return { productId: card._id, fields, card: pick(cardSide), page: pick(pageSide) };
}

/** @param {(path: string) => Promise<{status: number, body: any}>} get */
export async function auditCatalog(get, { concurrency = 8, listPageSize = LIST_PAGE_SIZE } = {}) {
  const cards = await listAll(get, listPageSize);
  const outcomes = await mapPool(cards, concurrency, async (card) => {
    try {
      return { card, ...(await readDetail(get, card._id)) };
    } catch (error) {
      return { card, kind: 'error', message: error.message };
    }
  });
  const report = { listed: cards.length, approved: 0, fallback: [], mismatches: [], errors: [] };
  for (const outcome of outcomes) {
    if (outcome.kind === 'fallback') report.fallback.push(outcome.card._id);
    else if (outcome.kind === 'error')
      report.errors.push({ productId: outcome.card._id, message: outcome.message });
    else {
      report.approved++;
      const mismatch = compare(outcome.card, outcome);
      if (mismatch) report.mismatches.push(mismatch);
    }
  }
  return report;
}

export function auditExitCode(report, { requireNoFallback = false } = {}) {
  if (report.mismatches.length > 0 || report.errors.length > 0) return 1;
  return requireNoFallback && report.fallback.length > 0 ? 1 : 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      'require-no-fallback': { type: 'boolean', default: false },
    },
  });
  const url = values.api ?? '';
  const api = URL.canParse(url) ? new URL(url) : undefined;
  if (
    !api ||
    api.origin !== url.replace(/\/$/, '') ||
    (api.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(api.hostname))
  )
    throw new Error(
      'Usage: node --experimental-strip-types scripts/catalog-consistency-audit.mjs --api https://API-ORIGIN [--require-no-fallback] (HTTP only for localhost)',
    );
  const get = async (path) => {
    const response = await fetch(`${api.origin}${path}`, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
  const report = await auditCatalog(get);
  console.log(
    JSON.stringify(
      {
        listed: report.listed,
        approved: report.approved,
        mismatched: report.mismatches.length,
        errors: report.errors.length,
        fallback: report.fallback.length,
        fallbackIds: report.fallback,
        firstMismatches: report.mismatches.slice(0, SHOWN),
        firstErrors: report.errors.slice(0, SHOWN),
      },
      null,
      2,
    ),
  );
  process.exitCode = auditExitCode(report, { requireNoFallback: values['require-no-fallback'] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
