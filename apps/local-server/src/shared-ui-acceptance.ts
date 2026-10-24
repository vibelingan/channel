/** Test harness only: ephemeral copy, real HTTP handlers, no cloud/Alibaba wiring. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCatalogImage } from '@vibelingan-channel/fn-public-api/handler';
import express from 'express';
import { z } from 'zod';
import { wireLocalDetailWorkspace } from './catalog-detail-workspace.ts';
import { bootstrapLocalInquiryAdmin } from './catalog-inquiry-bootstrap.ts';
import { registerLocalInquiryRoutes } from './catalog-inquiry-routes.ts';
import { registerLocalQuoteRoutes } from './catalog-quote-routes.ts';
import { closeServer, registerCatalogRoutes } from './catalog-routes.ts';
import { acceptanceReadback } from './shared-ui-acceptance-contract.ts';

const rows = z.array(z.record(z.unknown()).and(z.object({ _id: z.string().min(1) })));
const samples = z.object({ products: rows, productVariants: rows, images: rows });
export function acceptanceCatalog(input: unknown) {
  const data = samples.parse(input);
  assert.ok(
    data.products.length > 0 && data.products.length <= 10,
    'Expected bounded local samples',
  );
  for (const product of data.products)
    assert.equal(product.localDetailClone, true, 'Not a local clone');
  return data;
}

export async function startSharedUiAcceptance(source: string) {
  const sourceFile = join(source, 'db.json');
  const original = await readFile(sourceFile);
  const catalog = acceptanceCatalog(JSON.parse(original.toString('utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'channel-shared-ui-e2e-'));
  const file = join(directory, 'db.json');
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  let close = async () => {};
  try {
    await cp(join(source, 'media'), join(directory, 'media'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const adapter = wireLocalDetailWorkspace(file, join(directory, 'media'));
    for (const [collection, documents] of Object.entries(catalog))
      for (const document of documents) await adapter.create(collection, document);
    const config = await bootstrapLocalInquiryAdmin(adapter, directory);
    const credentials = z
      .object({ email: z.string(), password: z.string() })
      .parse(JSON.parse(await readFile(join(directory, 'local-admin.json'), 'utf8')));
    const app = express();
    registerLocalQuoteRoutes(app, adapter);
    registerLocalInquiryRoutes(app, adapter, config);
    registerCatalogRoutes(app, 'products', '/api/products', { enableCatalogDetail: true });
    app.get('/api/images/:id', async (req, res) => {
      const result = await getCatalogImage(req.params.id);
      if (result.ok && 'body' in result)
        res.set(result.headers).send(Buffer.from(result.body, 'base64'));
      else res.status(404).json(result);
    });
    const server = app.listen(0, '127.0.0.1');
    close = async () => {
      if (server.listening) await closeServer(server);
    };
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      apiUrl: `http://127.0.0.1:${address.port}`,
      credentials,
      file,
      async readDisk() {
        return acceptanceReadback.parse(JSON.parse(await readFile(file, 'utf8')));
      },
      async dispose() {
        try {
          await close();
          assert.equal(
            hash(await readFile(sourceFile)),
            hash(original),
            'Source sample DB changed during acceptance',
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
