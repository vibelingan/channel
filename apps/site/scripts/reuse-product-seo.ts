import { readFile, writeFile } from 'node:fs/promises';
import {
  createProductSnapshotImages,
  readProductSnapshotImages,
} from '../src/lib/seo/product-snapshot-images.ts';
import {
  decodeProductSnapshot,
  reuseAcceptedProductSnapshot,
} from '../src/lib/seo/product-snapshot.ts';
const [accepted, allowlist, output] = process.argv.slice(2);
if (!accepted || !allowlist || !output || !process.env.SITE_URL)
  throw Error('Explicit accepted snapshot, current public paths, output and site required');
const previous = decodeProductSnapshot(
  JSON.parse(await readFile(accepted, 'utf8')),
  process.env.SITE_URL,
);
const snapshot = reuseAcceptedProductSnapshot(
  previous,
  JSON.parse(await readFile(allowlist, 'utf8')),
  process.env.SITE_URL,
);
await writeFile(output, JSON.stringify(snapshot), { flag: 'wx' });
const images = createProductSnapshotImages(
  snapshot,
  (await readProductSnapshotImages(accepted, previous)).products,
);
await writeFile(`${output}.images.json`, JSON.stringify(images), { flag: 'wx' });
console.log(
  `Explicitly reused ${snapshot.products.length} accepted product details; withdrawn URLs excluded, no new products silently dropped.`,
);
