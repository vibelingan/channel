/**
 * Dianxiaomi workbook header table.
 *
 * Columns are located by NAME, never by position: the export reorders columns
 * between template revisions, and a positional reader fails silently by
 * reading the wrong column rather than loudly by not finding one.
 *
 * CALIBRATION NOTE. The alias lists below cover the Chinese headers a
 * Dianxiaomi Lazada "global product" export is known to use plus their English
 * equivalents, but the exact header row of a given template revision is a
 * fact about that file, not something that can be derived. The adapter is
 * built so this costs one line per column to fix and nothing else:
 *
 *   - unknown columns are REPORTED (`ignoredHeaders` and a HEADER_UNKNOWN
 *     warning), never silently dropped, so the first real run names every
 *     column the table does not yet recognise;
 *   - `pnpm import:dianxiaomi -- --file <path> --headers` prints the header
 *     row of any workbook without importing it;
 *   - a missing REQUIRED header rejects the workbook with a finding that
 *     lists the headers actually present.
 *
 * Adding an alias is therefore a one-line change to this table, made against
 * evidence printed by the tool rather than against a guess.
 */

/** Logical fields the adapter understands. Not part of the public contract. */
export type DianxiaomiField =
  | 'parentSku'
  | 'sku'
  | 'title'
  | 'store'
  | 'brand'
  | 'description'
  | 'shortDescription'
  | 'categoryId'
  | 'categoryName'
  | 'platformProductId'
  | 'regularPrice'
  | 'promotionPrice'
  | 'promotionStart'
  | 'promotionEnd'
  | 'stock'
  | 'attributes'
  | 'optionName1'
  | 'optionValue1'
  | 'optionName2'
  | 'optionValue2'
  | 'lengthCm'
  | 'widthCm'
  | 'heightCm'
  | 'weightKg'
  | 'sourceStatus'
  | 'sourceCreatedAt'
  | 'sourceUpdatedAt'
  | 'imageUrls'
  | 'variantImageUrl';

/**
 * Without these four there is no identity: no way to say which product a row
 * belongs to, which variant it is, or which store reported it. Their absence
 * means the file is not this template, so the workbook is rejected whole.
 */
export const REQUIRED_FIELDS: readonly DianxiaomiField[] = [
  'parentSku',
  'sku',
  'title',
  'store',
] as const;

/** Fields that legitimately span several columns (image1…image9). */
export const MULTI_VALUE_FIELDS: ReadonlySet<DianxiaomiField> = new Set(['imageUrls']);

/**
 * Normalized header aliases. Every entry must already be in the form produced
 * by `normalizeHeader` — the test suite asserts this, so a typo in the table
 * cannot quietly become a header that never matches.
 */
export const HEADER_ALIASES: Readonly<Record<DianxiaomiField, readonly string[]>> = {
  parentSku: [
    '父sku',
    '父体sku',
    '主sku',
    'parentsku',
    'parent sku',
    '商品sku',
    'spu',
    '父商品编码',
  ],
  sku: ['sku', '子sku', 'sku编码', '商品编码', 'seller sku', 'sellersku', '变体sku'],
  title: ['商品标题', '产品标题', '标题', '商品名称', '产品名称', 'title', 'product name', 'name'],
  store: ['店铺', '店铺名称', '所属店铺', 'store', 'shop', 'shop name', 'store name'],
  brand: ['品牌', 'brand'],
  description: ['商品描述', '产品描述', '描述', '详情描述', 'description', 'product description'],
  shortDescription: ['简短描述', '短描述', '卖点', 'short description', 'highlights'],
  categoryId: ['类目id', '分类id', '类目编号', 'category id', 'categoryid'],
  categoryName: ['类目', '类目名称', '分类', '分类名称', 'category', 'category name'],
  platformProductId: [
    'lazada产品id',
    'lazada商品id',
    '平台商品id',
    '平台产品id',
    '商品id',
    '产品id',
    'item id',
    'product id',
    'lazada product id',
  ],
  regularPrice: ['价格', '售价', '原价', '销售价', 'price', 'regular price', 'original price'],
  promotionPrice: ['促销价', '折扣价', '活动价', 'sale price', 'promotion price', 'special price'],
  promotionStart: [
    '促销开始时间',
    '活动开始时间',
    '促销开始',
    'promotion start',
    'sale start date',
  ],
  promotionEnd: ['促销结束时间', '活动结束时间', '促销结束', 'promotion end', 'sale end date'],
  stock: ['库存', '可用库存', '数量', 'stock', 'quantity', 'available stock'],
  attributes: ['属性', '商品属性', '销售属性', 'attributes', 'attribute'],
  optionName1: ['属性名1', '规格名1', '销售属性名1', 'variation name 1', 'option name 1'],
  optionValue1: ['属性值1', '规格值1', '销售属性值1', 'variation 1', 'option value 1'],
  optionName2: ['属性名2', '规格名2', '销售属性名2', 'variation name 2', 'option name 2'],
  optionValue2: ['属性值2', '规格值2', '销售属性值2', 'variation 2', 'option value 2'],
  lengthCm: ['长', '包装长度', '长度', 'length', 'package length'],
  widthCm: ['宽', '包装宽度', '宽度', 'width', 'package width'],
  heightCm: ['高', '包装高度', '高度', 'height', 'package height'],
  weightKg: ['重量', '包装重量', '毛重', 'weight', 'package weight'],
  sourceStatus: ['状态', '商品状态', '上架状态', 'status', 'product status'],
  sourceCreatedAt: ['创建时间', '添加时间', 'created at', 'create time'],
  sourceUpdatedAt: ['更新时间', '修改时间', 'updated at', 'update time', 'last modified'],
  imageUrls: ['图片', '图片地址', '主图', '商品图片', '图片链接', 'image', 'images', 'image url'],
  variantImageUrl: ['变体图片', 'sku图片', '规格图片', 'variation image', 'sku image'],
};

/**
 * A numbered image column (`图片1`, `image 3`, `主图2`). Matched after the
 * alias table so an exact alias always wins.
 */
const NUMBERED_IMAGE = /^(图片|主图|商品图片|图片地址|image|images|photo)\s*[-_ ]?([0-9]{1,2})$/;

const ZERO_WIDTH_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
]);

/**
 * Canonical form of a header cell. Deliberately gentler than the identifier
 * normalizer: headers are matched against a table we control, so folding is
 * about removing decoration (full-width forms, stray spaces, a trailing
 * colon or asterisk) rather than about producing a database key.
 */
export function normalizeHeader(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const char of raw.normalize('NFKC')) {
    const code = char.codePointAt(0) ?? 0;
    if (ZERO_WIDTH_CODE_POINTS.has(code)) continue;
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) continue;
    out += char;
  }
  return out
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[*＊]+/, '')
    .replace(/[:：*＊]+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Second-chance form: drops a trailing parenthetical unit such as `价格(元)`
 * or `weight (kg)`, which template revisions add and remove freely.
 */
export function stripHeaderQualifier(normalized: string): string {
  return normalized.replace(/[([【][^)\]】]*[)\]】]\s*$/u, '').trim();
}

const ALIAS_LOOKUP: ReadonlyMap<string, DianxiaomiField> = new Map(
  Object.entries(HEADER_ALIASES).flatMap(([field, aliases]) =>
    (aliases as readonly string[]).map(
      (alias) => [alias, field as DianxiaomiField] as [string, DianxiaomiField],
    ),
  ),
);

export interface MappedHeader {
  columnIndex: number;
  /** The header exactly as the workbook spelled it, for operator display. */
  label: string;
  field: DianxiaomiField;
}

export interface UnknownHeader {
  columnIndex: number;
  label: string;
}

export interface HeaderMapping {
  /** Column index for each single-valued field that was found. */
  columns: Map<DianxiaomiField, number>;
  /** Column indices, in workbook order, for each multi-valued field. */
  multiColumns: Map<DianxiaomiField, number[]>;
  unknown: UnknownHeader[];
  /** Required fields with no matching column — a structural rejection. */
  missingRequired: DianxiaomiField[];
  /** Single-valued fields matched by more than one column — ambiguous. */
  duplicates: { field: DianxiaomiField; labels: string[] }[];
  /** Every non-empty header as spelled in the file, in column order. */
  presentHeaders: string[];
}

/** Resolve one header cell to a logical field, or `null` when unrecognised. */
export function fieldForHeader(raw: string): DianxiaomiField | null {
  const normalized = normalizeHeader(raw);
  if (normalized === '') return null;
  const direct = ALIAS_LOOKUP.get(normalized);
  if (direct !== undefined) return direct;
  const stripped = stripHeaderQualifier(normalized);
  if (stripped !== normalized) {
    const viaStripped = ALIAS_LOOKUP.get(stripped);
    if (viaStripped !== undefined) return viaStripped;
  }
  if (NUMBERED_IMAGE.test(normalized) || NUMBERED_IMAGE.test(stripped)) return 'imageUrls';
  return null;
}

/**
 * Map a header row onto logical fields.
 *
 * Reordered columns are handled by construction (the result is keyed by field,
 * not by position). Unknown columns are collected rather than rejected: a
 * template that adds a column must not stop the merchant importing.
 */
export function mapHeaders(headerCells: readonly (string | undefined)[]): HeaderMapping {
  const columns = new Map<DianxiaomiField, number>();
  const multiColumns = new Map<DianxiaomiField, number[]>();
  const duplicateLabels = new Map<DianxiaomiField, string[]>();
  const unknown: UnknownHeader[] = [];
  const presentHeaders: string[] = [];

  headerCells.forEach((cell, columnIndex) => {
    const label = (cell ?? '').trim();
    if (label === '') return;
    presentHeaders.push(label);

    const field = fieldForHeader(label);
    if (field === null) {
      unknown.push({ columnIndex, label });
      return;
    }
    if (MULTI_VALUE_FIELDS.has(field)) {
      const existing = multiColumns.get(field) ?? [];
      existing.push(columnIndex);
      multiColumns.set(field, existing);
      return;
    }
    if (columns.has(field)) {
      const labels = duplicateLabels.get(field) ?? [];
      labels.push(label);
      duplicateLabels.set(field, labels);
      return;
    }
    columns.set(field, columnIndex);
  });

  const duplicates = [...duplicateLabels.entries()].map(([field, labels]) => ({ field, labels }));
  const missingRequired = REQUIRED_FIELDS.filter((field) => !columns.has(field));

  return { columns, multiColumns, unknown, missingRequired, duplicates, presentHeaders };
}
