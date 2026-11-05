import { readFile, writeFile } from 'node:fs/promises';
import { collectProductRefresh } from '../src/lib/seo/product-snapshot.ts';
const [acceptedFile, headsFile, output] = process.argv.slice(2);
if (
  !acceptedFile ||
  !headsFile ||
  !output ||
  !process.env.SITE_URL ||
  !process.env.SEO_CATALOG_API_ORIGIN
)
  throw Error('Explicit accepted snapshot, checked heads, output and public target are required');
const snapshot = await collectProductRefresh(
  JSON.parse(await readFile(acceptedFile, 'utf8')),
  JSON.parse(await readFile(headsFile, 'utf8')),
  process.env.SITE_URL,
  process.env.SEO_CATALOG_API_ORIGIN,
);
await writeFile(output, JSON.stringify(snapshot), { flag: 'wx' });
console.log(`Merged ${snapshot.total} public products without discarding unchanged details.`);
