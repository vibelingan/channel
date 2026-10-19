import { writeFile } from 'node:fs/promises';
import { detailFixture } from '../src/catalog/testing/detail-fixture.ts';
import { collectProductSnapshot, decodeProductSnapshot } from '../src/lib/seo/product-snapshot.ts';

const [output, stage = 'initial'] = process.argv.slice(2);
if (!output) throw new Error('Provide a local fixture output file');
if (!['initial', 'updated', 'withdrawn'].includes(stage)) throw new Error('Unknown fixture stage');
const site = process.env.SITE_URL || 'http://localhost:4321';
const rows = [
  {
    _id: 'canonical-product',
    name: 'Synthetic headset',
    description: 'Synthetic public product body.',
    productFamily: 'headphones',
  },
  {
    _id: 'legacy-without-slug',
    name: 'Synthetic legacy product',
    description: 'Legacy description without a slug.',
    category: '',
  },
].filter((row) => stage !== 'withdrawn' || row._id !== 'canonical-product');
const detail = {
  ...detailFixture(3),
  revision: stage === 'updated' ? 'approved-r2' : 'approved-r1',
  name: 'Synthetic headset',
  images: [],
  descriptionText:
    stage === 'updated' ? 'Updated approved description.' : 'Synthetic approved description.',
};
const fetcher: typeof fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/products')
    return Response.json({
      ok: true,
      data: { items: rows, total: rows.length, page: 1, pageSize: 48 },
    });
  if (url.pathname.endsWith('canonical-product/detail'))
    return Response.json({ ok: true, data: detail });
  if (url.pathname.endsWith('legacy-without-slug/detail'))
    return new Response(null, { status: 404 });
  return Response.json({ ok: true, data: rows.find((row) => row._id === 'legacy-without-slug') });
};
const captured = await collectProductSnapshot(site, 'https://seo-fixture.invalid', fetcher);
const snapshot = decodeProductSnapshot({ ...captured, purpose: 'fixture' }, site);
await writeFile(output, JSON.stringify(snapshot));
console.log(`Prepared ${snapshot.total} synthetic public products for a local-only build.`);
