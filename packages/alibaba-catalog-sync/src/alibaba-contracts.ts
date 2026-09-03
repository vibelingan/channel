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
  JsonNumberLexeme,
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
  const topCode = asLexeme(getPath(root, ['code']));
  const topMessage = asLexeme(getPath(root, ['message'])) ?? asLexeme(getPath(root, ['msg']));
  const topType = asLexeme(getPath(root, ['type']));
  const topErrorCode =
    topCode !== undefined && topCode !== '0' && (topType !== undefined || topMessage !== undefined)
      ? topCode
      : undefined;
  const errorCode =
    asLexeme(getPath(root, ['error_code'])) ??
    asLexeme(getPath(root, ['error', 'code'])) ??
    asLexeme(getPath(root, ['error_response', 'code'])) ??
    topErrorCode;
  if (errorCode !== undefined) {
    const envelope: AlibabaResponseEnvelope = { kind: 'api-error', errorCode };
    const message =
      asLexeme(getPath(root, ['error_message'])) ??
      asLexeme(getPath(root, ['error_msg'])) ??
      asLexeme(getPath(root, ['error', 'message'])) ??
      asLexeme(getPath(root, ['error_response', 'message'])) ??
      asLexeme(getPath(root, ['error_response', 'msg'])) ??
      topMessage;
    const requestId =
      asLexeme(getPath(root, ['request_id'])) ??
      asLexeme(getPath(root, ['trace_id'])) ??
      asLexeme(getPath(root, ['error_response', 'request_id']));
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

/** IOP's live JSON serializer wraps Java lists as `{type_name: [...]}`. */
function unwrapArray(
  value: LosslessJsonValue | undefined,
  wrapperKeys: string[],
): LosslessJsonValue[] | undefined {
  if (Array.isArray(value)) return value;
  for (const key of wrapperKeys) {
    const wrapped = getPath(value, [key]);
    if (Array.isArray(wrapped)) return wrapped;
    if (wrapped !== undefined && wrapped !== null) return [wrapped];
  }
  return undefined;
}

function asObject(
  value: LosslessJsonValue | undefined,
): { [key: string]: LosslessJsonValue } | undefined {
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof JsonNumberLexeme
  ) {
    return undefined;
  }
  return value;
}

interface AlibabaSkuAttributeDefinition {
  name: string;
  valuesById: Map<string, string>;
}

const MAX_SKU_SELECTION_JSON_CHARS = 64 * 1024;

function firstNonBlank(candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function extractSkuAttributeDefinitions(
  product: LosslessJsonValue | undefined,
): Map<string, AlibabaSkuAttributeDefinition> {
  const definitions = new Map<string, AlibabaSkuAttributeDefinition>();
  const container = firstDefined([
    getPath(product, ['product_sku', 'sku_attributes']),
    getPath(product, ['sku_attributes']),
  ]);
  const rawDefinitions = unwrapArray(container, ['sku_attribute']);
  if (!rawDefinitions) return definitions;

  for (const rawDefinition of rawDefinitions) {
    const attributeId = asLexeme(getPath(rawDefinition, ['attribute_id']));
    const name = firstNonBlank([
      asLexeme(getPath(rawDefinition, ['attribute_name'])),
      asLexeme(getPath(rawDefinition, ['name'])),
    ]);
    if (attributeId === undefined || name === undefined) continue;

    const rawValues = unwrapArray(getPath(rawDefinition, ['values']), ['sku_attribute_value']);
    const valuesById = new Map<string, string>();
    if (rawValues) {
      for (const rawValue of rawValues) {
        const valueId = asLexeme(getPath(rawValue, ['value_id']));
        const valueName = firstNonBlank([
          asLexeme(getPath(rawValue, ['system_value_name'])),
          asLexeme(getPath(rawValue, ['value_name'])),
          asLexeme(getPath(rawValue, ['custom_value_name'])),
        ]);
        if (valueId !== undefined && valueName !== undefined) {
          valuesById.set(valueId, valueName);
        }
      }
    }
    definitions.set(attributeId, { name, valuesById });
  }
  return definitions;
}

function extractSkuAttributeSelections(value: LosslessJsonValue | undefined): Map<string, string> {
  let selectionValue = value;
  if (typeof value === 'string') {
    const parsed = parseJsonPreservingNumbers(value, {
      maxChars: MAX_SKU_SELECTION_JSON_CHARS,
    });
    if (!parsed.ok) return new Map();
    selectionValue = parsed.value;
  }
  const selectionObject = asObject(selectionValue);
  if (!selectionObject) return new Map();

  const selections = new Map<string, string>();
  for (const [attributeId, rawValueId] of Object.entries(selectionObject)) {
    const valueId = asLexeme(rawValueId);
    if (valueId !== undefined) selections.set(attributeId, valueId);
  }
  return selections;
}

export function extractProductListPage(root: LosslessJsonValue): AlibabaProductListPage {
  const result = resolveRoot(root, LIST_RESULT_PATHS);
  const totalItems = firstDefined(TOTAL_ITEM_KEYS.map((key) => asInteger(getPath(result, [key]))));
  const rawItemsContainer = firstDefined(LIST_ITEMS_KEYS.map((key) => getPath(result, [key])));
  const rawItems = unwrapArray(rawItemsContainer, ['alibaba_product_brief_response']);
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
  ladderPrices?: AlibabaLadderPriceDraft[];
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
  const skuAttributeDefinitions = extractSkuAttributeDefinitions(product);

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
      asLexeme(getPath(product, ['sourcing_trade', 'min_order_quantity'])),
      asLexeme(getPath(product, ['wholesale_trade', 'min_order_quantity'])),
    ]),
  );

  const categoryPath = unwrapArray(getPath(product, ['category_path']), ['string']);
  if (categoryPath) {
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
  const imageItems = unwrapArray(images, ['string']);
  if (imageItems) {
    for (const image of imageItems) {
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
      asLexeme(getPath(product, ['sourcing_trade', 'fob_currency'])),
    ]),
  );
  const fobMin = firstDefined([
    asLexeme(getPath(product, ['fob_min_price'])),
    asLexeme(getPath(product, ['fob_price_min'])),
    asLexeme(getPath(product, ['sourcing_trade', 'fob_min_price'])),
  ]);
  const fobMax = firstDefined([
    asLexeme(getPath(product, ['fob_max_price'])),
    asLexeme(getPath(product, ['fob_price_max'])),
    asLexeme(getPath(product, ['sourcing_trade', 'fob_max_price'])),
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
  const ladderItems = unwrapArray(ladders, [
    'alibaba_ladder_price_response',
    'bulk_discount_price',
  ]);
  if (ladderItems) {
    for (const ladder of ladderItems) {
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

  const skuContainer = firstDefined([
    getPath(product, ['sku_infos']),
    getPath(product, ['skus']),
    getPath(product, ['product_sku', 'skus']),
  ]);
  const skus = unwrapArray(skuContainer, ['sku_definition', 'alibaba_sku_response']);
  if (skus) {
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
      const inventories = unwrapArray(getPath(sku, ['inventory_dto_list']), [
        'product_inventory_dto',
      ]);
      if (skuDraft.availableQuantity === undefined && inventories) {
        let total = 0;
        let found = false;
        for (const inventory of inventories) {
          const value = asInteger(getPath(inventory, ['inventory']));
          if (value !== undefined && value >= 0) {
            total += value;
            found = true;
          }
        }
        if (found && Number.isSafeInteger(total)) skuDraft.availableQuantity = total;
      }
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
      const attributeSelections = extractSkuAttributeSelections(getPath(sku, ['attr2_value']));
      for (const [attributeId, valueId] of attributeSelections) {
        const definition = skuAttributeDefinitions.get(attributeId);
        const valueName = definition?.valuesById.get(valueId);
        if (definition !== undefined && valueName !== undefined) {
          // `attr2_value` is the live TOP per-SKU selection and therefore wins
          // over a same-named compatibility attribute when both are present.
          skuDraft.attributes[definition.name] = valueName;
        }
      }
      const skuLadders = unwrapArray(getPath(sku, ['bulk_discount_prices']), [
        'bulk_discount_price',
      ]);
      if (skuLadders) {
        const parsed: AlibabaLadderPriceDraft[] = [];
        for (const ladder of skuLadders) {
          const minQuantity = firstDefined([
            asLexeme(getPath(ladder, ['start_quantity'])),
            asLexeme(getPath(ladder, ['min_quantity'])),
          ]);
          const ladderPrice = asLexeme(getPath(ladder, ['price']));
          const entry: AlibabaLadderPriceDraft = {};
          if (minQuantity !== undefined) entry.minQuantityLexeme = minQuantity;
          if (ladderPrice !== undefined) entry.priceLexeme = ladderPrice;
          if (entry.minQuantityLexeme !== undefined || entry.priceLexeme !== undefined) {
            parsed.push(entry);
          }
        }
        if (parsed.length > 0) skuDraft.ladderPrices = parsed;
      }
      draft.skus.push(skuDraft);
    }
  }

  return draft;
}
