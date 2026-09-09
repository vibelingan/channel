import { tmpdir } from 'node:os';
// Owned, disposable database only. No live credentials, API calls or product writes.
import { basename, dirname, resolve } from 'node:path';
import { JsonFileAdapter } from '../../apps/local-server/src/json-adapter.ts';
import { seed } from '../../apps/local-server/src/seed.ts';
import { setAdapter } from '../../packages/db/src/index.ts';

const file = resolve(process.argv[2] ?? '');
if (
  basename(file) !== 'db.json' ||
  !basename(dirname(file)).startsWith('channel-catalog-e2e-') ||
  dirname(dirname(file)) !== resolve(tmpdir())
)
  throw new Error('Refusing non-disposable catalog DB.');
const db = new JsonFileAdapter(file);
setAdapter(db);
await seed(db);
const product = await db.findByField('products', 'name', 'SonicAir Move');
if (!product) throw new Error('Owned seed fixture missing');
await db.update('products', product._id, {
  slug: 'local-linked-pricing',
  unitPrice: undefined,
  wholesalePrice: undefined,
  alibabaPrimarySourceKey: 'a'.repeat(64),
  alibabaCatalogPricing: {
    schemaVersion: 'alibaba-catalog-pricing-v1',
    source: 'alibaba',
    mode: 'tiered',
    currency: 'USD',
    sourceMoq: 2,
    syncedAt: '2026-09-03T08:16:00.000Z',
    tiers: [
      { minQuantity: 2, maxQuantity: 499, unitAmountMinor: 570 },
      { minQuantity: 500, maxQuantity: 999, unitAmountMinor: 500 },
      { minQuantity: 1000, unitAmountMinor: 380 },
    ],
  },
});
