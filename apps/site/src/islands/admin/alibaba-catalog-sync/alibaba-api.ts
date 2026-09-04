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
