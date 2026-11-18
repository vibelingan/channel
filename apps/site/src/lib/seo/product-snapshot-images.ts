import { readFile } from 'node:fs/promises';
import {
  CatalogImagePresentationSchema,
  imagePresentationMatchesSources,
} from '@vibelingan-channel/shared/catalog-image-presentation';
import { z } from 'zod';
import type { ProductSnapshot, ProductSnapshotEntry } from './product-snapshot.ts';

const schema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal('product-snapshot-images'),
    siteOrigin: z.string(),
    products: z
      .array(
        z
          .object({
            productId: z.string().min(1).max(200),
            revision: z.string().min(1),
            images: CatalogImagePresentationSchema,
          })
          .strict(),
      )
      .max(50_000),
  })
  .strict();
export type ProductSnapshotImages = z.infer<typeof schema>;
export type ProductSnapshotImageEntry = ProductSnapshotImages['products'][number];

function detailSources(entry: ProductSnapshotEntry) {
  return entry.detail
    ? [...entry.detail.images, ...entry.detail.variants.items.flatMap((variant) => variant.images)]
    : [];
}

/** Display hints are separate from the unchanged, strictly decoded content snapshot. */
export function decodeProductSnapshotImages(value: unknown, snapshot: ProductSnapshot) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4 * 1024 * 1024)
    throw Error('Product image hints exceed the build input limit');
  const parsed = schema.parse(value);
  if (parsed.siteOrigin !== snapshot.siteOrigin) throw Error('Product image hints site differs');
  const entries = new Map(snapshot.products.map((entry) => [entry.product._id, entry]));
  const seen = new Set<string>();
  for (const row of parsed.products) {
    const entry = entries.get(row.productId);
    if (
      seen.has(row.productId) ||
      !entry?.detail ||
      row.revision !== entry.revision ||
      !imagePresentationMatchesSources(row.images, detailSources(entry))
    )
      throw Error(`Unrelated product image hints: ${row.productId}`);
    seen.add(row.productId);
  }
  return parsed;
}

/** Retain only unchanged approved records; withdrawals and replaced revisions lose their hints. */
export function createProductSnapshotImages(
  snapshot: ProductSnapshot,
  previous: readonly ProductSnapshotImageEntry[] = [],
): ProductSnapshotImages {
  const entries = new Map(snapshot.products.map((entry) => [entry.product._id, entry]));
  return decodeProductSnapshotImages(
    {
      schemaVersion: 1,
      purpose: 'product-snapshot-images',
      siteOrigin: snapshot.siteOrigin,
      products: previous.filter((row) => {
        const entry = entries.get(row.productId);
        return (
          entry?.detail && entry.revision === row.revision && Object.keys(row.images).length > 0
        );
      }),
    },
    snapshot,
  );
}

export async function readProductSnapshotImages(file: string, snapshot: ProductSnapshot) {
  let bytes: Buffer;
  try {
    bytes = await readFile(`${file}.images.json`);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return createProductSnapshotImages(snapshot);
    throw error;
  }
  if (bytes.byteLength > 4 * 1024 * 1024)
    throw Error('Product image hints exceed the build input limit');
  return decodeProductSnapshotImages(JSON.parse(bytes.toString('utf8')), snapshot);
}

/** Only the in-memory rendering view receives hints. No saved detail/revision is rewritten. */
export function presentProductSnapshot(snapshot: ProductSnapshot, value: unknown): ProductSnapshot {
  const images = decodeProductSnapshotImages(value, snapshot);
  const byId = new Map(images.products.map((row) => [row.productId, row.images]));
  return {
    ...snapshot,
    products: snapshot.products.map((entry) => {
      const imagePresentation = byId.get(entry.product._id);
      return imagePresentation && entry.detail
        ? { ...entry, detail: { ...entry.detail, imagePresentation } }
        : entry;
    }),
  };
}
