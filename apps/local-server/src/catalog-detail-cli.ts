/** Bounded local-only rehearsal. No cloud tokens, cloud writes, or Alibaba API calls. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateCatalogSourceObservation } from '@vibelingan-channel/catalog-import/observations';
import {
  fetchSourceImage,
  migrateImageLocally,
} from '@vibelingan-channel/fn-admin/catalog-import-media';
import { getCatalogImage } from '@vibelingan-channel/fn-public-api/handler';
import express from 'express';
import {
  approveLocalDetail,
  materializeLocalDetail,
  wireLocalDetailWorkspace,
} from './catalog-detail-workspace.ts';
import { bootstrapLocalInquiryAdmin } from './catalog-inquiry-bootstrap.ts';
import { registerLocalInquiryRoutes } from './catalog-inquiry-routes.ts';
import { registerLocalQuoteRoutes } from './catalog-quote-routes.ts';
import { registerCatalogRoutes } from './catalog-routes.ts';

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: './data/shared-ui/observations.local.json' },
    'fetch-images': { type: 'boolean', default: false },
    'approve-local': { type: 'boolean', default: false },
    serve: { type: 'boolean', default: false },
    'enable-local-quotes': { type: 'boolean', default: false },
    'enable-local-quote-admin': { type: 'boolean', default: false },
    port: { type: 'string', default: '3012' },
    directory: { type: 'string', default: './data/shared-ui/ui02' },
  },
});
const directory = resolve(values.directory);
if (values['enable-local-quote-admin'] && (!values.serve || !values['enable-local-quotes']))
  throw new Error('Local inquiry admin requires --serve --enable-local-quotes');
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
// JsonFileAdapter already owns the cross-process lock and stale-owner recovery.
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
const adapter = wireLocalDetailWorkspace(
  resolve(directory, 'db.json'),
  resolve(directory, 'media'),
);

// --serve alone is read-only and can safely coexist with a stopped preparation
// process. Do not run prepare against a running JsonFileAdapter server: it caches
// file state. Restart the server after changing its local database.
if (!values.serve || values['fetch-images'] || values['approve-local']) {
  const file = resolve(values.file);
  if ((await stat(file)).size > 5 * 1024 * 1024) throw new Error('Snapshot exceeds 5 MiB');
  let input: unknown;
  try {
    input = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('Snapshot must be valid normalized observation JSON');
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 10)
    throw new Error('Expected 1–10 samples');
  const observations = input.map((value) => {
    const parsed = validateCatalogSourceObservation(value);
    if (
      !parsed.ok ||
      parsed.value.source.provider !== 'alibaba' ||
      parsed.value.identity.category?.sourceCategoryId !== '201745901'
    ) {
      throw new Error(
        'Expected the confirmed Alibaba headphone snapshot; no category inference allowed',
      );
    }
    return parsed.value;
  });
  const images = await adapter.list({ collection: 'images', page: 1, pageSize: 1000, search: '' });
  const seen = new Map<string, string>();
  const bindings = new Map<string, string>();
  for (const image of images.items) {
    if (image.status !== 'active' || image.storageProvider !== 'local-disk') continue;
    if (typeof image.checksumSha256 === 'string') seen.set(image.checksumSha256, image._id);
    if (Array.isArray(image.localSourceUrlHashes))
      for (const key of image.localSourceUrlHashes) {
        if (typeof key === 'string') bindings.set(key, image._id);
      }
  }
  const urlHash = (url: string) => createHash('sha256').update(url).digest('hex');
  const urls = [
    ...new Set(
      observations
        .flatMap((o) => [...o.content.media, ...o.variants.flatMap((v) => v.media)])
        .map((m) => m.sourceUrl),
    ),
  ];
  if (urls.length > 90) throw new Error('Sample media budget exceeded');
  const failures: { image: number; reason: string }[] = [];
  for (const [index, url] of urls.entries()) {
    if (bindings.has(urlHash(url)) || !values['fetch-images']) continue;
    const fetched = await fetchSourceImage(url);
    if (!fetched.ok) {
      failures.push({ image: index + 1, reason: fetched.reason });
      continue;
    }
    const migrated = await migrateImageLocally(fetched, `UI-02 sample image ${index + 1}`, seen);
    const record = await adapter.get('images', migrated.imageId);
    const previous = Array.isArray(record?.localSourceUrlHashes) ? record.localSourceUrlHashes : [];
    await adapter.update('images', migrated.imageId, {
      localSourceUrlHashes: [...new Set([...previous, urlHash(url)])],
    });
    bindings.set(urlHash(url), migrated.imageId);
  }
  const imageBindings = new Map(
    urls.flatMap((url) => {
      const id = bindings.get(urlHash(url));
      return id ? [[url, id] as const] : [];
    }),
  );
  const results = [];
  for (const [index, observation] of observations.entries()) {
    const materialized = await materializeLocalDetail({
      observation,
      productFamily: 'headphones',
      images: imageBindings,
    });
    const approval = values['approve-local']
      ? await approveLocalDetail(materialized.productId)
      : undefined;
    results.push({
      sample: index + 1,
      ...materialized,
      approvedLocally: !!approval,
      detailUrl: `http://127.0.0.1:${port}/api/products/${materialized.productId}/detail`,
    });
  }
  console.log(
    JSON.stringify({ mode: 'local-only', results, migratedImages: seen.size, failures }, null, 2),
  );
}

if (values.serve) {
  const app = express();
  if (values['enable-local-quotes']) registerLocalQuoteRoutes(app, adapter);
  if (values['enable-local-quote-admin']) {
    const config = await bootstrapLocalInquiryAdmin(adapter, directory);
    registerLocalInquiryRoutes(app, adapter, config);
    console.log(
      `Local inquiry admin enabled; credentials: ${resolve(directory, 'local-admin.json')}`,
    );
  }
  registerCatalogRoutes(app, 'products', '/api/products', { enableCatalogDetail: true });
  app.get('/api/images/:id', async (req, res) => {
    const result = await getCatalogImage(req.params.id);
    if (result.ok && 'body' in result) {
      for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
      res.send(Buffer.from(result.body, 'base64'));
    } else res.status(404).json(result);
  });
  app.listen(port, '127.0.0.1', () =>
    console.log(`Local detail API: http://127.0.0.1:${port}/api/products`),
  );
}
