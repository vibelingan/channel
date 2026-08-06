/**
 * Response contracts for the Alibaba ICBU product APIs.
 *
 * Everything here interprets ALREADY-PERSISTED raw bodies (raw-before-parse,
 * DESIGN_CHARTER §5.2) through the lossless JSON layer, so money lexemes
 * survive exactly. Field paths follow the documented ICBU response shapes;
 * they are table-driven and exported so the MIU 15 live-fixture gate can
 * correct them in one place. Extraction is defensive: a missing field yields
 * `undefined`, never a throw — malformed source pricing must degrade to the
 * `unavailable` mode downstream, not crash a run.
 */

import {
  type LosslessJsonValue,
  asInteger,
  asLexeme,
  getPath,
  parseJsonPreservingNumbers,
} from './alibaba-json.ts';

// --- envelope ---------------------------------------------------------------

export type AlibabaResponseEnvelope =
  | { kind: 'success'; root: LosslessJsonValue }
  | { kind: 'api-error'; errorCode: string; errorMessage?: string; requestId?: string }
  | { kind: 'malformed'; error: string };

export function parseAlibabaApiResponse(bodyText: string): AlibabaResponseEnvelope {
  const parsed = parseJsonPreservingNumbers(bodyText);
  if (!parsed.ok) return { kind: 'malformed', error: parsed.error };
  const root = parsed.value;
  // GOP error envelope: {"error_code": "...", "error_message"/"error_msg": "...", "request_id": "..."}
  const errorCode =
    asLexeme(getPath(root, ['error_code'])) ?? asLexeme(getPath(root, ['error', 'code']));
  if (errorCode !== undefined) {
    const envelope: AlibabaResponseEnvelope = { kind: 'api-error', errorCode };
    const message =
      asLexeme(getPath(root, ['error_message'])) ??
      asLexeme(getPath(root, ['error_msg'])) ??
      asLexeme(getPath(root, ['error', 'message']));
    const requestId =
      asLexeme(getPath(root, ['request_id'])) ?? asLexeme(getPath(root, ['trace_id']));
    if (message !== undefined) envelope.errorMessage = message;
    if (requestId !== undefined) envelope.requestId = requestId;
    return envelope;
  }
  return { kind: 'success', root };
}

/** Error codes that mean the merchant authorization is no longer usable. */
export const AUTHORIZATION_ERROR_CODES = new Set([
  'IllegalAccessToken',
  'InvalidAccessToken',
  'AccessTokenExpired',
  'MissingAccessToken',
  '27', // TOP-lineage invalid session
]);

export function isAuthorizationError(envelope: AlibabaResponseEnvelope): boolean {
  return envelope.kind === 'api-error' && AUTHORIZATION_ERROR_CODES.has(envelope.errorCode);
}

// --- shared path tables (adjust in ONE place after live-fixture evidence) ---

const LIST_RESULT_PATHS: (string | number)[][] = [
  ['alibaba_icbu_product_list_response'],
  ['result'],
  [],
];
const TOTAL_ITEM_KEYS = ['total_item', 'total_count', 'total'];
const LIST_ITEMS_KEYS = ['products', 'product_list', 'items'];
const DETAIL_ROOT_PATHS: (string | number)[][] = [
  ['alibaba_icbu_product_get_response', 'product'],
  ['result', 'product'],
  ['product'],
  ['result'],
];

// --- product list -----------------------------------------------------------

export interface AlibabaProductListItem {
  sourceProductId: string;
  gmtModified?: string;
  subject?: string;
}

export interface AlibabaProductListPage {
  totalItems?: number;
  items: AlibabaProductListItem[];
}

function firstDefined<T>(candidates: (T | undefined)[]): T | undefined {
  for (const candidate of candidates) if (candidate !== undefined) return candidate;
  return undefined;
}

function resolveRoot(
  root: LosslessJsonValue,
  paths: (string | number)[][],
): LosslessJsonValue | undefined {
  for (const path of paths) {
    const value = path.length === 0 ? root : getPath(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function extractProductListPage(root: LosslessJsonValue): AlibabaProductListPage {
  const result = resolveRoot(root, LIST_RESULT_PATHS);
  const totalItems = firstDefined(TOTAL_ITEM_KEYS.map((key) => asInteger(getPath(result, [key]))));
  const rawItems = firstDefined(LIST_ITEMS_KEYS.map((key) => getPath(result, [key])));
  const items: AlibabaProductListItem[] = [];
  if (Array.isArray(rawItems)) {
    for (const raw of rawItems) {
      const sourceProductId = firstDefined([
        asLexeme(getPath(raw, ['product_id'])),
        asLexeme(getPath(raw, ['id'])),
      ]);
      if (sourceProductId === undefined) continue;
      const item: AlibabaProductListItem = { sourceProductId };
      const gmtModified = firstDefined([
        asLexeme(getPath(raw, ['gmt_modified'])),
        asLexeme(getPath(raw, ['modify_time'])),
      ]);
      const subject = firstDefined([
        asLexeme(getPath(raw, ['subject'])),
        asLexeme(getPath(raw, ['title'])),
      ]);
      if (gmtModified !== undefined) item.gmtModified = gmtModified;
      if (subject !== undefined) item.subject = subject;
      items.push(item);
    }
  }
  const page: AlibabaProductListPage = { items };
  if (totalItems !== undefined) page.totalItems = totalItems;
  return page;
}

// --- product detail ---------------------------------------------------------

export interface AlibabaSkuDraft {
  sourceSkuId: string;
  priceLexeme?: string;
  availableQuantity?: number;
  attributes: Record<string, string>;
}

export interface AlibabaLadderPriceDraft {
  minQuantityLexeme?: string;
  priceLexeme?: string;
}

export interface AlibabaProductDetailDraft {
  sourceProductId?: string;
  subject?: string;
  description?: string;
  categoryId?: string;
  categoryPath?: string[];
  imageUrls: string[];
  moqLexeme?: string;
  currencyLexeme?: string;
  fobMinLexeme?: string;
  fobMaxLexeme?: string;
  ladderPrices: AlibabaLadderPriceDraft[];
  skus: AlibabaSkuDraft[];
  gmtModified?: string;
  status?: string;
}

export function extractProductDetail(root: LosslessJsonValue): AlibabaProductDetailDraft {
  const product = resolveRoot(root, DETAIL_ROOT_PATHS);
  const draft: AlibabaProductDetailDraft = { imageUrls: [], ladderPrices: [], skus: [] };

  const setIf = <K extends keyof AlibabaProductDetailDraft>(
    key: K,
    value: AlibabaProductDetailDraft[K] | undefined,
  ) => {
    if (value !== undefined) draft[key] = value;
  };

  setIf(
    'sourceProductId',
    firstDefined([asLexeme(getPath(product, ['product_id'])), asLexeme(getPath(product, ['id']))]),
  );
  setIf(
    'subject',
    firstDefined([asLexeme(getPath(product, ['subject'])), asLexeme(getPath(product, ['title']))]),
  );
  setIf('description', asLexeme(getPath(product, ['description'])));
  setIf(
    'categoryId',
    firstDefined([
      asLexeme(getPath(product, ['category_id'])),
      asLexeme(getPath(product, ['cat_id'])),
    ]),
  );
  setIf(
    'gmtModified',
    firstDefined([
      asLexeme(getPath(product, ['gmt_modified'])),
      asLexeme(getPath(product, ['modify_time'])),
    ]),
  );
  setIf('status', asLexeme(getPath(product, ['status'])));
  setIf(
    'moqLexeme',
    firstDefined([
      asLexeme(getPath(product, ['min_order_quantity'])),
      asLexeme(getPath(product, ['moq'])),
    ]),
  );

  const categoryPath = getPath(product, ['category_path']);
  if (Array.isArray(categoryPath)) {
    const segments = categoryPath
      .map((seg) => asLexeme(seg))
      .filter((seg): seg is string => seg !== undefined);
    if (segments.length > 0) draft.categoryPath = segments;
  }

  const images = firstDefined([
    getPath(product, ['image', 'images']),
    getPath(product, ['images']),
    getPath(product, ['main_image', 'images']),
  ]);
  if (Array.isArray(images)) {
    for (const image of images) {
      const url = firstDefined([asLexeme(image), asLexeme(getPath(image, ['url']))]);
      if (url !== undefined) draft.imageUrls.push(url);
    }
  }

  // FOB pricing: either flat min/max fields or a "1.50-2.30" range lexeme.
  setIf(
    'currencyLexeme',
    firstDefined([
      asLexeme(getPath(product, ['fob_currency'])),
      asLexeme(getPath(product, ['currency'])),
    ]),
  );
  const fobMin = firstDefined([
    asLexeme(getPath(product, ['fob_min_price'])),
    asLexeme(getPath(product, ['fob_price_min'])),
  ]);
  const fobMax = firstDefined([
    asLexeme(getPath(product, ['fob_max_price'])),
    asLexeme(getPath(product, ['fob_price_max'])),
  ]);
  const fobRange = asLexeme(getPath(product, ['fob_price']));
  if (fobMin !== undefined || fobMax !== undefined) {
    setIf('fobMinLexeme', fobMin);
    setIf('fobMaxLexeme', fobMax);
  } else if (fobRange !== undefined) {
    const rangeMatch = /^([0-9.]+)\s*-\s*([0-9.]+)$/.exec(fobRange);
    if (rangeMatch) {
      setIf('fobMinLexeme', rangeMatch[1]);
      setIf('fobMaxLexeme', rangeMatch[2]);
    } else {
      setIf('fobMinLexeme', fobRange);
      setIf('fobMaxLexeme', fobRange);
    }
  }

  const ladders = firstDefined([
    getPath(product, ['ladder_prices']),
    getPath(product, ['ladder_price']),
  ]);
  if (Array.isArray(ladders)) {
    for (const ladder of ladders) {
      const entry: AlibabaLadderPriceDraft = {};
      const minQuantity = firstDefined([
        asLexeme(getPath(ladder, ['min_quantity'])),
        asLexeme(getPath(ladder, ['quantity'])),
      ]);
      const price = asLexeme(getPath(ladder, ['price']));
      if (minQuantity !== undefined) entry.minQuantityLexeme = minQuantity;
      if (price !== undefined) entry.priceLexeme = price;
      if (entry.minQuantityLexeme !== undefined || entry.priceLexeme !== undefined) {
        draft.ladderPrices.push(entry);
      }
    }
  }

  const skus = firstDefined([getPath(product, ['sku_infos']), getPath(product, ['skus'])]);
  if (Array.isArray(skus)) {
    for (const sku of skus) {
      const sourceSkuId = firstDefined([
        asLexeme(getPath(sku, ['sku_id'])),
        asLexeme(getPath(sku, ['id'])),
      ]);
      if (sourceSkuId === undefined) continue;
      const skuDraft: AlibabaSkuDraft = { sourceSkuId, attributes: {} };
      const price = asLexeme(getPath(sku, ['price']));
      if (price !== undefined) skuDraft.priceLexeme = price;
      const available =
        asInteger(getPath(sku, ['available_quantity'])) ?? asInteger(getPath(sku, ['stock']));
      if (available !== undefined) skuDraft.availableQuantity = available;
      const attributes = getPath(sku, ['attributes']);
      if (Array.isArray(attributes)) {
        for (const attribute of attributes) {
          const name = firstDefined([
            asLexeme(getPath(attribute, ['attribute_name'])),
            asLexeme(getPath(attribute, ['name'])),
          ]);
          const value = firstDefined([
            asLexeme(getPath(attribute, ['attribute_value'])),
            asLexeme(getPath(attribute, ['value'])),
          ]);
          if (name !== undefined && value !== undefined) skuDraft.attributes[name] = value;
        }
      }
      draft.skus.push(skuDraft);
    }
  }

  return draft;
}
