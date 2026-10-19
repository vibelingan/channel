import { writeFile } from 'node:fs/promises';
import { collectProductSnapshot } from '../src/lib/seo/product-snapshot.ts';

const [output] = process.argv.slice(2);
if (!output || !process.env.SITE_URL || !process.env.SEO_CATALOG_API_ORIGIN)
  throw new Error(
    'Usage: SITE_URL=... SEO_CATALOG_API_ORIGIN=... tsx scripts/prepare-product-seo.ts <snapshot.json>',
  );
const snapshot = await collectProductSnapshot(
  process.env.SITE_URL,
  process.env.SEO_CATALOG_API_ORIGIN,
);
await writeFile(output, JSON.stringify(snapshot));
console.log(
  `Captured ${snapshot.products.length} public products (${snapshot.products.filter((p) => p.detail).length} structured, ${snapshot.products.filter((p) => !p.detail).length} legacy).`,
);
