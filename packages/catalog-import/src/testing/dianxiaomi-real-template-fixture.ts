/**
 * The REAL Dianxiaomi Lazada export template — its 44 column headings in their
 * actual order — with entirely synthetic cell values.
 *
 * WHY THIS SHAPE. Column headings are template structure, not customer data:
 * they are the same for every merchant using this Dianxiaomi export and they
 * are the one thing that could not be derived without the file. Every VALUE
 * here is invented, so the fixture is committable while still pinning the
 * calibration that the real workbook produced on 2026-08-26.
 *
 * What it exists to catch: an edit that breaks the alias table for this
 * template. The header names below are the evidence; a test asserts they map
 * with zero unknown columns.
 *
 * Non-obvious things this template does, all reproduced here:
 *   - the gallery is a main column plus 附图1…附图7, not `图片N`
 *   - option slots are numbered with Chinese numerals (一 / 二), not 1 / 2
 *   - 关键属性 carries the attributes JSON
 *   - 产品id and 平台刊登时间 are populated together or not at all
 *   - 促销结束时间 is the far-future open-ended sentinel
 *   - 营销图-*, 视频URL, 包装内容 and 备注 exist but are empty throughout
 *   - 来源URL is a supplier page address, NOT a product image
 */
import type { Buffer } from 'node:buffer';
import { type FixtureCell, buildXlsx } from './xlsx-fixture.ts';

/** The 44 headings of the real export, in file order. */
export const REAL_TEMPLATE_HEADERS = [
  'parent SKU',
  '分类ID',
  '产品标题',
  '产品描述',
  '短描述',
  'SKU',
  '品牌',
  '质保类型',
  '关键属性',
  '变种名称',
  '变种属性名称一',
  '变种属性值一',
  '变种属性名称二',
  '变种属性值二',
  '价格',
  '库存',
  '促销价',
  '促销开始时间',
  '促销结束时间',
  '产品图片主图(URL)',
  '附图1',
  '附图2',
  '附图3',
  '附图4',
  '附图5',
  '附图6',
  '附图7',
  '变种图片',
  '营销图-场景图',
  '营销图-白底图',
  '视频URL',
  '税',
  '包装重量(kg)',
  '长(cm)',
  '宽(cm)',
  '高(cm)',
  '包装内容',
  '来源URL',
  '备注',
  '店铺',
  '产品id',
  '创建时间',
  '更新时间',
  '平台刊登时间',
] as const;

const OPEN_ENDED = '2101-12-31 23:59:59';

export interface RealTemplateRowOptions {
  parentSku?: string;
  sku?: string;
  title?: string;
  store?: string;
  /** Omit or pass `'1'` to reproduce the template's placeholder description. */
  description?: string;
  shortDescription?: string;
  brand?: string;
  /** Number of gallery images (0–8: the main column plus 附图1…附图7). */
  galleryImages?: number;
  variantImage?: string | null;
  /** A marketplace listing: sets 产品id AND 平台刊登时间 together. */
  listedAs?: string | null;
  stock?: number;
  price?: string;
  promotionPrice?: string | null;
}

/** One row shaped exactly like a real export row, with invented values. */
export function realTemplateRow(options: RealTemplateRowOptions = {}): FixtureCell[] {
  const {
    parentSku = 'PS-1001',
    sku = 'SK-2001',
    title = 'Synthetic product title',
    store = 'SyntheticShop_MY',
    description = '1',
    shortDescription = '<p>1</p>',
    brand = 'SyntheticBrand',
    galleryImages = 3,
    variantImage = 'https://images.example.test/variant/1.jpg',
    listedAs = null,
    stock = 12,
    price = '19.90',
    promotionPrice = '17.90',
  } = options;

  const gallery: (FixtureCell | null)[] = Array.from({ length: 8 }, (_v, index) =>
    index < galleryImages
      ? { inline: `https://images.example.test/g/${parentSku}-${index}.jpg` }
      : null,
  );

  return [
    parentSku,
    { inline: '7001' },
    title,
    { inline: description },
    { inline: shortDescription },
    { inline: sku },
    brand,
    'Synthetic warranty',
    { inline: '{"Material":"ABS","Origin":"Synthetic"}' },
    'Synthetic variation label',
    'Colour',
    'Black',
    null,
    null,
    { inline: price },
    stock,
    promotionPrice === null ? null : { inline: promotionPrice },
    promotionPrice === null ? null : { inline: '2026-08-01 00:00:00' },
    promotionPrice === null ? null : { inline: OPEN_ENDED },
    ...gallery,
    variantImage === null ? null : { inline: variantImage },
    null, // 营销图-场景图 — present but empty in the real export
    null, // 营销图-白底图
    null, // 视频URL
    'Synthetic tax class',
    1,
    12,
    8,
    4,
    null, // 包装内容
    { inline: 'https://supplier.example.test/listing/1' },
    null, // 备注
    store,
    listedAs === null ? null : { inline: listedAs },
    { inline: '2026-08-01 09:00:00' },
    { inline: '2026-08-20 09:00:00' },
    listedAs === null ? null : { inline: '2026-08-02 10:00:00' },
  ];
}

/** A workbook using the real template's headers and synthetic rows. */
export function buildRealTemplateWorkbook(
  rows: readonly FixtureCell[][] = [realTemplateRow()],
): Buffer {
  return buildXlsx({
    sheets: [{ name: 'lazada_quanqiuchanpin_', rows: [[...REAL_TEMPLATE_HEADERS], ...rows] }],
  });
}
