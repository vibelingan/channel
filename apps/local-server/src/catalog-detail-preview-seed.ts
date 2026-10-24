/** One-time local CUI-04 preparation. Copies UI-02; never changes its DB or cloud state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  dianxiaomiObservationAdapter,
  parseDianxiaomiWorkbook,
} from '@vibelingan-channel/catalog-import/dianxiaomi';
import { buildAcceptanceWorkbook } from '@vibelingan-channel/catalog-import/testing/dianxiaomi-acceptance';
import { migrateImageLocally } from '@vibelingan-channel/fn-admin/catalog-import-media';
import {
  approveLocalDetail,
  materializeLocalDetail,
  wireLocalDetailWorkspace,
} from './catalog-detail-workspace.ts';

const { values } = parseArgs({
  options: {
    'content-revision': { type: 'boolean', default: false },
    'quote-phase': { type: 'boolean', default: false },
  },
});
const sourceDirectory = resolve(
  values['quote-phase']
    ? './data/shared-ui/ui04-r1'
    : values['content-revision']
      ? './data/shared-ui/ui04'
      : './data/shared-ui/ui02',
);
const targetDirectory = resolve(
  values['quote-phase']
    ? './data/shared-ui/ui05'
    : values['content-revision']
      ? './data/shared-ui/ui04-r1'
      : './data/shared-ui/ui04',
);
// Exclusive creation fails rather than overwriting a previous or live workspace.
await mkdir(targetDirectory);
await cp(resolve(sourceDirectory, 'db.json'), resolve(targetDirectory, 'db.json'), {
  errorOnExist: true,
  force: false,
});
await cp(resolve(sourceDirectory, 'media'), resolve(targetDirectory, 'media'), {
  recursive: true,
  errorOnExist: true,
  force: false,
});
wireLocalDetailWorkspace(resolve(targetDirectory, 'db.json'), resolve(targetDirectory, 'media'));
const parsed = parseDianxiaomiWorkbook(buildAcceptanceWorkbook());
const observation = dianxiaomiObservationAdapter.toObservations({
  bundle: parsed.bundle,
  observedAt: '2026-09-06T00:00:00.000Z',
}).observations[0];
assert.ok(observation, 'Excel parser must produce a grouped product');
// Generated workbook, not customer data. Use the existing acceptance pixel, not a supplier photo.
observation.identity.title = `[Excel test fixture] ${observation.identity.title}`;
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=',
  'base64',
);
const url = 'https://example.com/pixel.png';
const image = await migrateImageLocally(
  {
    ok: true,
    bytes: pixel,
    mimeType: 'image/png',
    sha256: createHash('sha256').update(pixel).digest('hex'),
    finalUrl: url,
    dimensions: { width: 1, height: 1 },
  },
  'Excel acceptance test pixel (not product photography)',
  new Map(),
);
observation.content.media = [{ sourceUrl: url, role: 'primary', position: 0 }];
for (const variant of observation.variants) variant.media = [];
const result = await materializeLocalDetail({
  observation,
  productFamily: 'headphones',
  images: new Map([[url, image.imageId]]),
});
await approveLocalDetail(result.productId);
console.log(
  JSON.stringify({
    mode: 'local-only',
    directory: targetDirectory,
    excelProductId: result.productId,
    variants: observation.variants.length,
  }),
);
