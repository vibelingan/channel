import { readFile, writeFile } from 'node:fs/promises';
import { readProductSnapshotImages } from '../src/lib/seo/product-snapshot-images.ts';
import {
  collectProductRefreshWithImages,
  decodeProductSnapshot,
} from '../src/lib/seo/product-snapshot.ts';
const [acceptedFile, headsFile, output] = process.argv.slice(2);
if (
  !acceptedFile ||
  !headsFile ||
  !output ||
  !process.env.SITE_URL ||
  !process.env.SEO_CATALOG_API_ORIGIN
)
  throw Error('Explicit accepted snapshot, checked heads, output and public target are required');
const accepted = decodeProductSnapshot(
  JSON.parse(await readFile(acceptedFile, 'utf8')),
  process.env.SITE_URL,
);
const { snapshot, images } = await collectProductRefreshWithImages(
  accepted,
  JSON.parse(await readFile(headsFile, 'utf8')),
  process.env.SITE_URL,
  process.env.SEO_CATALOG_API_ORIGIN,
  await readProductSnapshotImages(acceptedFile, accepted),
);
await writeFile(output, JSON.stringify(snapshot), { flag: 'wx' });
await writeFile(`${output}.images.json`, JSON.stringify(images), { flag: 'wx' });
console.log(`Merged ${snapshot.total} public products without discarding unchanged details.`);
