/**
 * Client for the alibaba-catalog-sync function's admin actions (MIU 13).
 * Same Bearer/JSON envelope as the admin API: {action, token, data} POSTs —
 * the session rides the body, never a cookie (ARCHITECTURE §8.1). Responses
 * never contain token material; the panel renders redacted status only.
 */
import { apiUrl } from '../../../lib/api-url.ts';
import { getToken } from '../../../lib/session.ts';

const ENDPOINT = apiUrl('/api/alibaba-catalog-sync');
const SOURCE_PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

export class AlibabaSyncApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AlibabaSyncApiError';
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function call<T>(action: string, data?: unknown): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: getToken() }),
  });
  // VALIDATED, not cast: `res.json()` returns unknown, and a gateway error
  // page or a proxy's own JSON would satisfy a cast while leaving `ok`
  // undefined — which then reads as a failure with no error code, and the
  // caller reports a blank message. Check the shape we actually rely on.
  let envelope: Envelope<T> | null = null;
  try {
    const parsed: unknown = await res.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { ok?: unknown }).ok === 'boolean'
    ) {
      envelope = parsed as Envelope<T>;
    }
  } catch {
    envelope = null;
  }
  if (!envelope) {
    throw new AlibabaSyncApiError(
      res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
      `Request failed (${res.status})`,
    );
  }
  if (!envelope.ok || envelope.data === undefined) {
    throw new AlibabaSyncApiError(
      envelope.error?.code ?? 'INTERNAL_ERROR',
      envelope.error?.message ?? 'Request failed.',
    );
  }
  return envelope.data;
}

export interface ConnectionStatus {
  status: string;
  accountLabel?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  authorizedAt?: string;
  firstAuthErrorAt?: string;
  lastAuthErrorAt?: string;
  notConfigured: boolean;
  missing?: string[];
}

export function fetchConnectionStatus(): Promise<ConnectionStatus> {
  return call<ConnectionStatus>('connectionStatus');
}

export function startOAuthFlow(): Promise<{ authorizeUrl: string }> {
  return call<{ authorizeUrl: string }>('oauthStart');
}

export function disconnectAlibaba(): Promise<{ disconnected: boolean }> {
  return call<{ disconnected: boolean }>('disconnect');
}

export interface TickReport {
  outcome: string;
  runId?: string;
  detail?: string;
}

export function runSyncNow(): Promise<TickReport> {
  return call<TickReport>('runNow');
}

export type SourceObservationReplayMode = 'dry-run' | 'apply';

export interface SourceObservationReplayCounts {
  sourceProducts: number;
  observations: number;
  variants: number;
  offers: number;
  attributedVariants: number;
  attributePairs: number;
  warnings: number;
}

export interface SourceObservationReplayFailure {
  sourceKey: string;
  reason: string;
}

export interface SourceObservationReplayPage {
  ok: true;
  mode: SourceObservationReplayMode;
  ready: boolean;
  pageHash: string;
  totalSourceProducts: number;
  afterSourceKey: string;
  nextSourceKey: string;
  done: boolean;
  counts: SourceObservationReplayCounts;
  priceModes: Partial<Record<ProductDetailPriceMode, number>>;
  failures: SourceObservationReplayFailure[];
  applied: number;
}

export interface SourceObservationReplayPlan {
  pages: SourceObservationReplayPage[];
  counts: SourceObservationReplayCounts;
  priceModes: Partial<Record<ProductDetailPriceMode, number>>;
  ready: boolean;
  totalSourceProducts: number;
}

const REPLAY_MODES = new Set<SourceObservationReplayMode>(['dry-run', 'apply']);
const REPLAY_FAILURE_REASONS = new Set([
  'invalid-source-row',
  'payload-missing',
  'invalid-payload-metadata',
  'raw-read-failed',
  'raw-too-large',
  'raw-size-mismatch',
  'raw-hash-mismatch',
  'malformed-response',
  'provider-api-error',
  'missing-product-id',
  'product-id-mismatch',
  'source-key-mismatch',
  'offer-set-mismatch',
  'invalid-source-observation',
]);
const REPLAY_COUNT_KEYS = [
  'sourceProducts',
  'observations',
  'variants',
  'offers',
  'attributedVariants',
  'attributePairs',
  'warnings',
] as const satisfies readonly (keyof SourceObservationReplayCounts)[];
const MAX_REPLAY_PAGES = 1_000;
const REPLAY_PAGE_SIZE = 20;

function decodeReplayCounts(value: unknown): SourceObservationReplayCounts | null {
  if (!isRecord(value) || !hasExactKeys(value, REPLAY_COUNT_KEYS)) return null;
  const counts = {} as SourceObservationReplayCounts;
  for (const key of REPLAY_COUNT_KEYS) {
    const count = readNonNegativeSafeInteger(value[key]);
    if (count === null) return null;
    counts[key] = count;
  }
  return counts;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function decodeReplayPriceModes(
  value: unknown,
): Partial<Record<ProductDetailPriceMode, number>> | null {
  if (!isRecord(value)) return null;
  const result: Partial<Record<ProductDetailPriceMode, number>> = {};
  for (const [key, rawCount] of Object.entries(value)) {
    if (!PRICE_MODES.has(key as ProductDetailPriceMode)) return null;
    const count = readNonNegativeSafeInteger(rawCount);
    if (count === null) return null;
    result[key as ProductDetailPriceMode] = count;
  }
  return result;
}

/** Closed decoder: provider or proxy drift becomes an error, never renderable state. */
export function decodeSourceObservationReplayPage(
  value: unknown,
): SourceObservationReplayPage | null {
  const pageKeys = [
    'ok',
    'mode',
    'ready',
    'pageHash',
    'totalSourceProducts',
    'afterSourceKey',
    'nextSourceKey',
    'done',
    'counts',
    'priceModes',
    'failures',
    'applied',
  ] as const;
  if (!isRecord(value) || value.ok !== true || !hasExactKeys(value, pageKeys)) return null;
  if (
    typeof value.mode !== 'string' ||
    !REPLAY_MODES.has(value.mode as SourceObservationReplayMode) ||
    typeof value.ready !== 'boolean' ||
    typeof value.pageHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.pageHash) ||
    typeof value.afterSourceKey !== 'string' ||
    value.afterSourceKey.length > 128 ||
    typeof value.nextSourceKey !== 'string' ||
    value.nextSourceKey.length > 128 ||
    typeof value.done !== 'boolean' ||
    !Array.isArray(value.failures) ||
    value.failures.length > REPLAY_PAGE_SIZE
  ) {
    return null;
  }
  const counts = decodeReplayCounts(value.counts);
  const priceModes = decodeReplayPriceModes(value.priceModes);
  const applied = readNonNegativeSafeInteger(value.applied);
  const totalSourceProducts = readNonNegativeSafeInteger(value.totalSourceProducts);
  if (!counts || !priceModes || applied === null || totalSourceProducts === null) return null;
  const failures: SourceObservationReplayFailure[] = [];
  for (const failure of value.failures) {
    if (
      !isRecord(failure) ||
      !hasExactKeys(failure, ['sourceKey', 'reason']) ||
      typeof failure.sourceKey !== 'string' ||
      failure.sourceKey.length === 0 ||
      failure.sourceKey.length > 128 ||
      typeof failure.reason !== 'string' ||
      !REPLAY_FAILURE_REASONS.has(failure.reason)
    ) {
      return null;
    }
    failures.push({ sourceKey: failure.sourceKey, reason: failure.reason });
  }
  const pricedOffers = Object.values(priceModes).reduce((total, count) => total + (count ?? 0), 0);
  const cursorIsValid =
    counts.sourceProducts === 0
      ? value.done === true && value.nextSourceKey === value.afterSourceKey
      : value.nextSourceKey !== '' && value.nextSourceKey !== value.afterSourceKey;
  if (
    counts.sourceProducts > REPLAY_PAGE_SIZE ||
    counts.observations + failures.length !== counts.sourceProducts ||
    counts.attributedVariants > counts.variants ||
    counts.attributePairs < counts.attributedVariants ||
    pricedOffers !== counts.offers ||
    totalSourceProducts < counts.sourceProducts ||
    !cursorIsValid ||
    (value.done && counts.sourceProducts >= REPLAY_PAGE_SIZE) ||
    (!value.done && counts.sourceProducts !== REPLAY_PAGE_SIZE) ||
    value.ready !== (failures.length === 0) ||
    (value.mode === 'dry-run' && applied !== 0) ||
    (value.mode === 'apply' && value.ready && applied !== counts.observations)
  ) {
    return null;
  }
  return {
    ok: true,
    mode: value.mode as SourceObservationReplayMode,
    ready: value.ready,
    pageHash: value.pageHash,
    totalSourceProducts,
    afterSourceKey: value.afterSourceKey,
    nextSourceKey: value.nextSourceKey,
    done: value.done,
    counts,
    priceModes,
    failures,
    applied,
  };
}

async function replaySourceObservationPage(
  mode: SourceObservationReplayMode,
  afterSourceKey: string,
  expectedPageHash?: string,
  expectedTotalSourceProducts?: number,
): Promise<SourceObservationReplayPage> {
  const raw = await call<unknown>('replaySourceObservations', {
    mode,
    afterSourceKey,
    limit: REPLAY_PAGE_SIZE,
    ...(expectedPageHash === undefined ? {} : { expectedPageHash }),
    ...(expectedTotalSourceProducts === undefined ? {} : { expectedTotalSourceProducts }),
  });
  if (isRecord(raw) && raw.ok === false && typeof raw.reason === 'string') {
    throw new AlibabaSyncApiError('CONFLICT', `Replay stopped: ${raw.reason}.`);
  }
  const page = decodeSourceObservationReplayPage(raw);
  if (!page || page.mode !== mode || page.afterSourceKey !== afterSourceKey) {
    throw new AlibabaSyncApiError('INTERNAL_ERROR', 'Replay returned an invalid page summary.');
  }
  return page;
}

function emptyReplayCounts(): SourceObservationReplayCounts {
  return {
    sourceProducts: 0,
    observations: 0,
    variants: 0,
    offers: 0,
    attributedVariants: 0,
    attributePairs: 0,
    warnings: 0,
  };
}

function addReplayCounts(
  total: SourceObservationReplayCounts,
  next: SourceObservationReplayCounts,
): void {
  for (const key of REPLAY_COUNT_KEYS) total[key] += next[key];
}

function addReplayPriceModes(
  total: Partial<Record<ProductDetailPriceMode, number>>,
  next: Partial<Record<ProductDetailPriceMode, number>>,
): void {
  for (const mode of PRICE_MODES) total[mode] = (total[mode] ?? 0) + (next[mode] ?? 0);
}

export async function validateSourceObservationReplay(
  onPage?: (pageCount: number, sourceProductCount: number) => void,
): Promise<SourceObservationReplayPlan> {
  const pages: SourceObservationReplayPage[] = [];
  const counts = emptyReplayCounts();
  const priceModes: Partial<Record<ProductDetailPriceMode, number>> = {};
  let cursor = '';
  let totalSourceProducts: number | null = null;
  for (let pageCount = 1; pageCount <= MAX_REPLAY_PAGES; pageCount += 1) {
    const page = await replaySourceObservationPage('dry-run', cursor);
    totalSourceProducts ??= page.totalSourceProducts;
    if (page.totalSourceProducts !== totalSourceProducts) {
      throw new AlibabaSyncApiError('CONFLICT', 'Replay source total changed during validation.');
    }
    pages.push(page);
    addReplayCounts(counts, page.counts);
    addReplayPriceModes(priceModes, page.priceModes);
    onPage?.(pageCount, counts.sourceProducts);
    if (!page.ready) return { pages, counts, priceModes, ready: false, totalSourceProducts };
    if (page.done) {
      if (counts.sourceProducts !== totalSourceProducts) {
        throw new AlibabaSyncApiError(
          'CONFLICT',
          'Replay did not cover the authoritative source total.',
        );
      }
      return { pages, counts, priceModes, ready: true, totalSourceProducts };
    }
    if (!page.nextSourceKey || page.nextSourceKey === cursor) {
      throw new AlibabaSyncApiError('INTERNAL_ERROR', 'Replay cursor did not advance.');
    }
    cursor = page.nextSourceKey;
  }
  throw new AlibabaSyncApiError('INTERNAL_ERROR', 'Replay exceeded the page safety limit.');
}

export async function applySourceObservationReplay(
  plan: SourceObservationReplayPlan,
  onPage?: (pageCount: number, appliedCount: number) => void,
): Promise<number> {
  if (!plan.ready || plan.pages.length === 0 || plan.pages.length > MAX_REPLAY_PAGES) {
    throw new AlibabaSyncApiError('CONFLICT', 'A complete successful validation is required.');
  }
  let applied = 0;
  for (const [index, expected] of plan.pages.entries()) {
    const page = await replaySourceObservationPage(
      'apply',
      expected.afterSourceKey,
      expected.pageHash,
      plan.totalSourceProducts,
    );
    if (!page.ready) {
      const reasonCounts = new Map<string, number>();
      for (const failure of page.failures) {
        reasonCounts.set(failure.reason, (reasonCounts.get(failure.reason) ?? 0) + 1);
      }
      const summary = [...reasonCounts.entries()]
        .map(([reason, count]) => `${reason} (${count})`)
        .join(', ');
      throw new AlibabaSyncApiError(
        'CONFLICT',
        `Replay page preflight failed: ${summary || 'unknown failure'}.`,
      );
    }
    if (
      page.pageHash !== expected.pageHash ||
      page.totalSourceProducts !== plan.totalSourceProducts ||
      page.nextSourceKey !== expected.nextSourceKey ||
      page.done !== expected.done
    ) {
      throw new AlibabaSyncApiError('CONFLICT', 'Replay page changed after validation.');
    }
    applied += page.applied;
    onPage?.(index + 1, applied);
  }
  return applied;
}

export type ProductDetailPriceMode = 'fixed' | 'tiered' | 'range' | 'negotiable' | 'unavailable';

export interface ProductDetailInspectionSummary {
  sourceProductId: string;
  payloadId: string;
  deduplicated: boolean;
  rawByteLength: number;
  hasSubject: boolean;
  hasCategory: boolean;
  hasMoq: boolean;
  description: { kind: 'empty' | 'html' | 'text'; characterCount: number };
  imageCount: number;
  skuCount: number;
  skusWithAttributes: number;
  attributeNameCount: number;
  attributeNames: string[];
  productTierCount: number;
  skuTieredPriceCount: number;
  normalizedOfferCount: number;
  normalizedPriceModes: ProductDetailPriceMode[];
  currency?: string;
  sourceStatus?: string;
}

type ProductDetailDescriptionKind = ProductDetailInspectionSummary['description']['kind'];

const DESCRIPTION_KINDS = new Set<ProductDetailDescriptionKind>(['empty', 'html', 'text']);
const PRICE_MODES = new Set<ProductDetailPriceMode>([
  'fixed',
  'tiered',
  'range',
  'negotiable',
  'unavailable',
]);

function isDescriptionKind(value: unknown): value is ProductDetailDescriptionKind {
  return typeof value === 'string' && DESCRIPTION_KINDS.has(value as ProductDetailDescriptionKind);
}

export function isAlibabaSourceProductId(value: string): boolean {
  return SOURCE_PRODUCT_ID_PATTERN.test(value.trim());
}

/** Runtime gate for the provider-derived summary before any field reaches React. */
export function decodeProductDetailInspectionSummary(
  value: unknown,
): ProductDetailInspectionSummary | null {
  if (!isRecord(value) || !isRecord(value.description)) return null;
  if (
    typeof value.sourceProductId !== 'string' ||
    !isAlibabaSourceProductId(value.sourceProductId) ||
    typeof value.payloadId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.payloadId) ||
    typeof value.deduplicated !== 'boolean' ||
    typeof value.hasSubject !== 'boolean' ||
    typeof value.hasCategory !== 'boolean' ||
    typeof value.hasMoq !== 'boolean'
  ) {
    return null;
  }
  const rawByteLength = readNonNegativeSafeInteger(value.rawByteLength);
  const imageCount = readNonNegativeSafeInteger(value.imageCount);
  const skuCount = readNonNegativeSafeInteger(value.skuCount);
  const skusWithAttributes = readNonNegativeSafeInteger(value.skusWithAttributes);
  const attributeNameCount = readNonNegativeSafeInteger(value.attributeNameCount);
  const productTierCount = readNonNegativeSafeInteger(value.productTierCount);
  const skuTieredPriceCount = readNonNegativeSafeInteger(value.skuTieredPriceCount);
  const normalizedOfferCount = readNonNegativeSafeInteger(value.normalizedOfferCount);
  const descriptionCharacterCount = readNonNegativeSafeInteger(value.description.characterCount);
  if (
    rawByteLength === null ||
    imageCount === null ||
    skuCount === null ||
    skusWithAttributes === null ||
    attributeNameCount === null ||
    productTierCount === null ||
    skuTieredPriceCount === null ||
    normalizedOfferCount === null ||
    descriptionCharacterCount === null
  ) {
    return null;
  }
  if (!isDescriptionKind(value.description.kind)) {
    return null;
  }
  if (
    !Array.isArray(value.attributeNames) ||
    value.attributeNames.length > 24 ||
    !value.attributeNames.every(
      (name) => typeof name === 'string' && name.length > 0 && name.length <= 128,
    ) ||
    !Array.isArray(value.normalizedPriceModes) ||
    value.normalizedPriceModes.length > PRICE_MODES.size ||
    !value.normalizedPriceModes.every(
      (mode): mode is ProductDetailPriceMode =>
        typeof mode === 'string' && PRICE_MODES.has(mode as ProductDetailPriceMode),
    )
  ) {
    return null;
  }
  if (
    skusWithAttributes > skuCount ||
    skuTieredPriceCount > skuCount ||
    value.attributeNames.length > attributeNameCount ||
    new Set(value.attributeNames).size !== value.attributeNames.length ||
    new Set(value.normalizedPriceModes).size !== value.normalizedPriceModes.length
  ) {
    return null;
  }
  if (
    (value.currency !== undefined &&
      (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) ||
    (value.sourceStatus !== undefined &&
      (typeof value.sourceStatus !== 'string' ||
        value.sourceStatus.length === 0 ||
        value.sourceStatus.length > 128))
  ) {
    return null;
  }

  return {
    sourceProductId: value.sourceProductId,
    payloadId: value.payloadId,
    deduplicated: value.deduplicated,
    rawByteLength,
    hasSubject: value.hasSubject,
    hasCategory: value.hasCategory,
    hasMoq: value.hasMoq,
    description: {
      kind: value.description.kind as ProductDetailInspectionSummary['description']['kind'],
      characterCount: descriptionCharacterCount,
    },
    imageCount,
    skuCount,
    skusWithAttributes,
    attributeNameCount,
    attributeNames: [...value.attributeNames],
    productTierCount,
    skuTieredPriceCount,
    normalizedOfferCount,
    normalizedPriceModes: [...value.normalizedPriceModes],
    ...(value.currency ? { currency: value.currency } : {}),
    ...(value.sourceStatus ? { sourceStatus: value.sourceStatus } : {}),
  };
}

export async function inspectProductDetail(
  sourceProductId: string,
): Promise<ProductDetailInspectionSummary> {
  const raw = await call<unknown>('inspectProductDetail', { sourceProductId });
  const summary = decodeProductDetailInspectionSummary(raw);
  if (!summary) {
    throw new AlibabaSyncApiError(
      'INTERNAL_ERROR',
      'Alibaba returned an invalid inspection summary.',
    );
  }
  return summary;
}

export function approveQuarantine(
  runId: string,
  candidateHash: string,
): Promise<{ runId: string; promoted: number }> {
  return call('approveQuarantine', { runId, candidateHash });
}

export function linkSourceProduct(
  sourceKey: string,
  productId: string,
): Promise<{ sourceKey: string; productId: string; alreadyLinked: boolean }> {
  return call('linkProduct', { sourceKey, productId });
}

export function unlinkSourceProduct(
  productId: string,
): Promise<{ productId: string; clearedLinks: number }> {
  return call('unlinkProduct', { productId });
}
