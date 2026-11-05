import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { signSession } from '@vibelingan-channel/auth/jwt';
import { manageCatalogProductOperation, setAdapter } from '@vibelingan-channel/db';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import type { CatalogSeoRecordingConfig } from '@vibelingan-channel/db/catalog-seo-requests';
import { runCatalogPreparationWorker } from '@vibelingan-channel/fn-admin/catalog-preparation-worker';
import { type AdminConfig, handleAdminRequest } from '@vibelingan-channel/fn-admin/handler';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { LocalDiskMediaStorage } from '@vibelingan-channel/media-storage/local-disk';
import {
  type CatalogProductOperationBinding,
  CatalogProductOperationStatusSchema,
} from '@vibelingan-channel/shared/catalog-product-operation';
import { fixture as sourceFixture } from '../../../functions/admin/src/testing/catalog-source-plan-fixture.ts';
import { importCandidateImage } from '../../../functions/alibaba-catalog-sync/src/media-import.ts';
import { JsonFileAdapter } from '../json-adapter.ts';

export const at = '2026-10-18T00:00:00.000Z';
export const operationId = '12345678-1234-4234-8234-123456789012';
export async function workspace(
  t: TestContext,
  count?: number,
  fullPublication = false,
  seo?: CatalogSeoRecordingConfig,
) {
  const directory = mkdtempSync(join(tmpdir(), 'channel-owned-continue-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.json');
  const productId = count === undefined ? 'manual' : 'read-product';
  const rows =
    count === undefined
      ? {
          users: [{ _id: 'admin', role: 'admin', status: 'active' }],
          products: [
            {
              _id: productId,
              name: 'Clock',
              description: 'Original draft',
              productFamily: 'misc',
              published: false,
              archived: false,
              imageIds: ['image'],
              updatedAt: at,
              catalogPricingMode: 'manual',
              manualCatalogPricing: {
                schemaVersion: 'manual-catalog-pricing-v1',
                currency: 'USD',
                tiers: [{ minQuantity: 1, unitAmountMinor: 300 }],
              },
            },
          ],
          images: [
            { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
          ],
        }
      : sourceFixture(count).adapter.rows;
  const product = rows.products?.[0];
  assert.ok(product);
  Object.assign(product, { archived: false, imageIds: ['image'], updatedAt: at });
  rows.images = [
    { _id: 'image', status: 'active', storageProvider: 'local-disk', publishedRefCount: 0 },
  ];
  writeFileSync(file, JSON.stringify(rows));
  const adapter = new JsonFileAdapter(file, false, seo);
  setAdapter(adapter);
  // Private phase tests defer only the final step. Full workflow tests use the production default.
  const config: AdminConfig = {
    jwtSecret: 'owned-continue-test-only',
    enableDetailApproval: true,
    ...(!fullPublication
      ? {
          productOperationPublisher: async (actor: string, scope: CatalogProductOperationBinding) =>
            manageCatalogProductOperation(actor, {
              action: 'product-operation-get',
              productId: scope.productId,
              operationId: scope.operationId,
            }),
        }
      : {}),
  };
  const token = await signSession(config.jwtSecret, {
    sub: 'admin',
    role: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
  });
  const invoke = (data: unknown) =>
    handleAdminRequest({ action: 'catalogDetailApproval', token, data }, config);
  const start = async (
    intent: 'publish' | 'save-draft' = 'publish',
    values: Record<string, unknown> = { description: 'My saved draft' },
  ) => {
    const response = await invoke({
      action: 'product-operation-start',
      productId,
      operationId,
      intent,
      expectedUpdatedAt: at,
      values,
    });
    assert.ok(response.ok, JSON.stringify(response));
    const status = CatalogProductOperationStatusSchema.parse(response.data);
    return { productId, operationId, inputDigest: status.inputDigest };
  };
  return {
    adapter,
    admin: (action: string, data: unknown) => handleAdminRequest({ action, data, token }, config),
    file,
    productId,
    invoke,
    start,
    invokeWithConfig: (data: unknown, extra: Partial<AdminConfig>) =>
      handleAdminRequest({ action: 'catalogDetailApproval', token, data }, { ...config, ...extra }),
    bytes: () => readFileSync(file, 'utf8'),
  };
}

export const ownedColdPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAJUlEQVQ4jWMQMglroCVmGLVAaDSIhEZTkdBoRjMZLSpMBnlpCgCQpqoQR9aKMgAAAABJRU5ErkJggg==',
  'base64',
);
export async function coldOwnedMedia(
  h: Awaited<ReturnType<typeof workspace>>,
  importSource = false,
) {
  const storage = new LocalDiskMediaStorage(join(dirname(h.file), 'cold-media'));
  setMediaStorage(storage);
  const object = await storage.putObject({
    namespace: 'catalog',
    logicalId: 'image',
    fileName: 'sample.png',
    mimeType: 'image/png',
    content: ownedColdPng,
  });
  const rows = JSON.parse(h.bytes());
  Object.assign(rows.images[0], object, {
    mimeType: 'image/png',
    byteSize: ownedColdPng.length,
    checksumSha256: createHash('sha256').update(ownedColdPng).digest('hex'),
  });
  if (importSource)
    rows.catalogSourceObservations[0].observation.variants[0].media = [
      { sourceUrl: 'https://sc04.alicdn.com/owned-cold-sku.png', position: 0, role: 'variant' },
    ];
  writeFileSync(h.file, JSON.stringify(rows));
  const authority = createCatalogPreparationAuthority({
    secret: 'owned-cold-media',
    environmentId: 'owned-cold-media',
  });
  let invocations = 0;
  let fetches = 0;
  const config: Partial<AdminConfig> = {
    preparationAuthority: authority,
    preparationInvoke: async (call) => {
      invocations++;
      return {
        result: await runCatalogPreparationWorker(
          authority,
          call,
          importSource
            ? {
                importSourceImage: (url, persistImport) =>
                  importCandidateImage(url, {
                    persistImport,
                    resolveDns: async () => ['104.16.1.1'],
                    fetchImpl: async () => {
                      fetches++;
                      return new Response(new Uint8Array(ownedColdPng));
                    },
                  }),
              }
            : {},
        ),
      };
    },
  };
  return { storage, config, invocations: () => invocations, fetches: () => fetches };
}
