import { writeFile } from 'node:fs/promises';
import { collectPublicProductPaths } from '../src/lib/seo/product-snapshot.ts';
const [output] = process.argv.slice(2);
if (!output || !process.env.SITE_URL || process.env.SEO_CATALOG_API_ORIGIN !== process.env.SITE_URL)
  throw Error('Explicit same-site public inventory target required');
const paths = await collectPublicProductPaths(process.env.SITE_URL);
await writeFile(output, JSON.stringify(paths), { flag: 'wx' });
console.log(`Confirmed ${paths.length} current public product URLs without detail requests.`);
