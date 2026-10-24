import { readFile, writeFile } from 'node:fs/promises';
import { reuseAcceptedProductSnapshot } from '../src/lib/seo/product-snapshot.ts';
const [accepted, allowlist, output] = process.argv.slice(2);
if (!accepted || !allowlist || !output || !process.env.SITE_URL)
  throw Error('Explicit accepted snapshot, current public paths, output and site required');
const snapshot = reuseAcceptedProductSnapshot(
  JSON.parse(await readFile(accepted, 'utf8')),
  JSON.parse(await readFile(allowlist, 'utf8')),
  process.env.SITE_URL,
);
await writeFile(output, JSON.stringify(snapshot), { flag: 'wx' });
console.log(
  `Explicitly reused ${snapshot.products.length} accepted product details; withdrawn URLs excluded, no new products silently dropped.`,
);
