/**
 * A synthetic Dianxiaomi export that reproduces the VERIFIED cardinalities of
 * the customer workbook (handoff §3), exactly:
 *
 *   rows            312
 *   parent SKUs      77
 *   SKUs            289
 *   store products  100   distinct (store, parent SKU)
 *   store variants  312   distinct (store, SKU)
 *   stores            4
 *   marketplace ids  16   carried by 129 rows
 *   unique images   452   referenced 1,549 times
 *   SKUs repeated across stores: 23, every one with EQUAL stock in both
 *
 * WHY THIS EXISTS. The customer workbook is not present on this machine, so
 * the grouping and reconciliation logic is proven against a file with the same
 * shape rather than against the file itself. Those numbers are the shape: 312
 * rows collapsing to 289 variants under 77 families across 4 shops is what
 * makes the "do not sum repeated store stock" rule matter at all.
 *
 * This is not a substitute for running the real workbook. It is what makes the
 * first real run a CALIBRATION (do the header names match?) rather than a
 * debugging session (does grouping work at all?).
 *
 * Everything here is deterministic — index arithmetic, no randomness — so two
 * runs produce byte-identical files and the repeat-import test means something.
 */
import type { Buffer } from 'node:buffer';
import { type FixtureCell, buildXlsx } from './xlsx-fixture.ts';

export const ACCEPTANCE_HEADERS = [
  '父SKU',
  'SKU',
  '商品标题',
  '店铺',
  '品牌',
  '商品描述',
  '价格',
  '促销价',
  '促销结束时间',
  '库存',
  '属性',
  'Lazada产品ID',
  '类目ID',
  '图片1',
  '图片2',
  '属性名1',
  '属性值1',
  '创建时间',
] as const;

/** The counts this fixture is built to reproduce. */
export const ACCEPTANCE_COUNTS = {
  rows: 312,
  parentSkus: 77,
  skus: 289,
  storeProducts: 100,
  storeVariants: 312,
  stores: 4,
  uniqueImageUrls: 452,
  imageReferences: 1549,
  marketplaceIds: 16,
  rowsWithMarketplaceId: 129,
  skusRepeatedAcrossStores: 23,
} as const;

const STORES = ['LingAn_MY', 'LingAn_SG', 'LingAn_PH', 'LingAn_TH'] as const;

/**
 * Family sizes, chosen so the totals above fall out exactly:
 *   16 families carry a marketplace id and 129 SKUs between them (15x8 + 1x9),
 *   61 families carry the remaining 160 SKUs (39x3 + 21x2 + 1x1).
 * 129 + 160 = 289 SKUs across 77 families.
 */
const LISTED_FAMILY_COUNT = 16;
const FAMILY_SIZES: readonly number[] = [
  ...Array.from({ length: 15 }, () => 8),
  9,
  ...Array.from({ length: 39 }, () => 3),
  ...Array.from({ length: 21 }, () => 2),
  1,
];

const IMAGE_POOL_SIZE = ACCEPTANCE_COUNTS.uniqueImageUrls;

const pad = (value: number, width: number) => String(value).padStart(width, '0');

interface PlannedRow {
  familyIndex: number;
  skuIndex: number;
  parentSku: string;
  sku: string;
  store: string;
  /** True for the second store of a SKU that is listed in two shops. */
  isRepeat: boolean;
  quantity: number;
}

/**
 * Lay out every row before rendering, so the counts are a property of the plan
 * and can be asserted without opening a spreadsheet.
 */
export function planAcceptanceRows(): PlannedRow[] {
  const rows: PlannedRow[] = [];
  let skuCounter = 0;

  // The SKUs listed in a second shop are drawn from the families that have NO
  // marketplace id, so the 129 rows carrying an id stay in one shop each.
  const repeatFamilies = new Set(
    Array.from(
      { length: ACCEPTANCE_COUNTS.skusRepeatedAcrossStores },
      (_v, index) => LISTED_FAMILY_COUNT + index,
    ),
  );

  FAMILY_SIZES.forEach((size, familyIndex) => {
    const parentSku = `P-${pad(familyIndex + 1, 3)}`;
    const primaryStore = STORES[familyIndex % STORES.length] as string;
    for (let position = 0; position < size; position += 1) {
      skuCounter += 1;
      const sku = `SKU-${pad(skuCounter, 4)}`;
      // A quantity that varies by family but is IDENTICAL for the same SKU in
      // both shops, which is what the real workbook shows.
      const quantity = (familyIndex * 7 + position * 3) % 120;
      rows.push({
        familyIndex,
        skuIndex: position,
        parentSku,
        sku,
        store: primaryStore,
        isRepeat: false,
        quantity,
      });
      if (position === 0 && repeatFamilies.has(familyIndex)) {
        rows.push({
          familyIndex,
          skuIndex: position,
          parentSku,
          sku,
          store: STORES[(familyIndex + 1) % STORES.length] as string,
          isRepeat: true,
          quantity,
        });
      }
    }
  });

  return rows;
}

/**
 * Images per row: 301 rows carry 5 and 11 carry 4, which is 1,549 references.
 * URLs are drawn from a 452-entry pool by a cyclic walk, so the pool is fully
 * covered (1,549 > 452) and no row repeats a URL within itself.
 */
function imagesForRow(rowIndex: number, cursor: number): { urls: string[]; nextCursor: number } {
  const count = rowIndex < 11 ? 4 : 5;
  const urls: string[] = [];
  let position = cursor;
  for (let index = 0; index < count; index += 1) {
    urls.push(`https://cdn.example.test/img/${pad(position % IMAGE_POOL_SIZE, 4)}.jpg`);
    position += 1;
  }
  return { urls, nextCursor: position % IMAGE_POOL_SIZE };
}

export interface AcceptanceFixtureOptions {
  /**
   * `changed` shifts one family's price, stock and title and drops one SKU,
   * so a repeat import produces a delta an operator can read. Everything else
   * is byte-identical to `base`.
   */
  revision?: 'base' | 'changed';
  /** Optional export scope for partial-store overwrite regressions. */
  stores?: readonly string[];
}

/** Build the acceptance workbook. */
export function buildAcceptanceWorkbook(options: AcceptanceFixtureOptions = {}): Buffer {
  const revision = options.revision ?? 'base';
  const planned = planAcceptanceRows();
  const rows: FixtureCell[][] = [[...ACCEPTANCE_HEADERS]];

  let imageCursor = 0;
  planned.forEach((row, rowIndex) => {
    if (options.stores && !options.stores.includes(row.store)) return;
    // The `changed` revision removes exactly one SKU so the delta report has a
    // source-missing record to show; it must never be deleted automatically.
    if (revision === 'changed' && row.sku === 'SKU-0002') return;

    const { urls, nextCursor } = imagesForRow(rowIndex, imageCursor);
    imageCursor = nextCursor;

    const listed = row.familyIndex < LISTED_FAMILY_COUNT;
    // Family index 1 is inside the bounded publish sample, so the delta this
    // produces is one an operator can actually see against stored state.
    const bumped = revision === 'changed' && row.familyIndex === 1;
    const priceMinorish = 1999 + row.familyIndex * 100 + row.skuIndex * 25 + (bumped ? 500 : 0);

    rows.push([
      row.parentSku,
      { inline: row.sku },
      `${bumped ? 'Updated ' : ''}Family ${row.familyIndex + 1} product`,
      row.store,
      `Brand${row.familyIndex % 9}`,
      // Every third family ships the documented placeholder description.
      row.familyIndex % 3 === 0
        ? { inline: '<p>1</p>' }
        : { inline: `<p>Family ${row.familyIndex + 1} description</p>` },
      { inline: (priceMinorish / 100).toFixed(2) },
      row.skuIndex % 4 === 0 ? { inline: ((priceMinorish - 300) / 100).toFixed(2) } : null,
      row.skuIndex % 4 === 0 ? { inline: '2101-12-31 23:59:59' } : null,
      row.quantity + (bumped ? 5 : 0),
      { inline: `{"material":"ABS","batch":${row.familyIndex + 1}}` },
      listed ? { inline: `LZD${pad(row.familyIndex + 1, 6)}` } : null,
      { inline: `CAT-${pad(row.familyIndex % 12, 2)}` },
      { inline: urls.slice(0, Math.ceil(urls.length / 2)).join(',') },
      { inline: urls.slice(Math.ceil(urls.length / 2)).join(',') },
      'Color',
      `Shade ${row.skuIndex + 1}`,
      { dateSerial: 46260 - row.familyIndex },
    ]);
  });

  return buildXlsx({ sheets: [{ name: '全球产品', rows }] });
}
