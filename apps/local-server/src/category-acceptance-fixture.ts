/** Synthetic records shaped from the dated audit table; NOT a live database export. */
import { readFileSync } from 'node:fs';
import type { CollectionDoc } from '@vibelingan-channel/shared';

export function categoryAcceptanceFixture(): Record<string, CollectionDoc[]> {
  const decision = readFileSync(
    new URL(
      '../../../docs/shared-product-ui/CATEGORY-LAUNCH-DECISION-2026-09-07.md',
      import.meta.url,
    ),
    'utf8',
  );
  const products: CollectionDoc[] = [];
  const add = (id: string, categoryId: string, name: string) =>
    products.push({
      _id: id,
      name: `[LOCAL FIXTURE] ${name}`,
      published: false,
      archived: false,
      alibabaSourceCategoryId: categoryId,
      alibabaPrimarySourceKey: `fixture-${id}`,
    });
  for (const match of decision.matchAll(/^\| (\d+) \| (\d+) \| ([^|]+) \| ([^|]+) \|$/gm)) {
    const [, id, count, , title] = match;
    if (!id || !count || !title || id === '63708' || id === '100001765') continue;
    for (let i = 0; i < Number(count); i++)
      add(`fixture-${id}-${String(i).padStart(3, '0')}`, id, title.trim());
  }
  for (const match of decision.matchAll(
    /^\| ([a-f0-9-]{36}) \| (\d+) \| ([^|]+) \| ([^|]+) \|$/gm,
  )) {
    const [, id, category, , title] = match;
    if (id && category && title) add(id, category, title.trim());
  }
  // Existing assignments must remain untouched, including legacy website rows.
  for (let i = 0; i < 720; i++)
    products.push({
      _id: `existing-headphone-${String(i).padStart(3, '0')}`,
      name: '[LOCAL FIXTURE] Existing headphone',
      productFamily: 'headphones',
      published: i === 0,
    });
  for (let i = 0; i < 3; i++)
    products.push({
      _id: `existing-toy-${i}`,
      name: '[LOCAL FIXTURE] Existing toy',
      productFamily: 'toys',
      published: false,
    });
  return {
    products,
    alibabaSourceProducts: products
      .filter((row) => row.alibabaPrimarySourceKey)
      .map((row) => ({
        _id: String(row.alibabaPrimarySourceKey),
        sourceCategoryId: row.alibabaSourceCategoryId,
        active: true,
      })),
    alibabaProductLinks: products
      .filter((row) => row.alibabaPrimarySourceKey)
      .map((row) => ({ _id: String(row.alibabaPrimarySourceKey), productId: row._id })),
  };
}
