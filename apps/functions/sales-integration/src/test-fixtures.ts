import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CollectionDoc } from '@vibelingan-channel/shared';
import { type SalesRequest, createSalesHandler } from './handler.ts';

export function setup() {
  const registry = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/sales-contracts/fixtures/client-bindings.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const pdf = Buffer.from('%PDF-1.7\nsynthetic drawing\n');
  const file = {
    _id: 'drawing_a',
    name: 'design.pdf',
    purpose: 'oem-drawing',
    status: 'active',
    ownerProjectId: 'oem_a',
    storageProvider: 'cloudbase-storage',
    storageFileId: 'cloud://env_a.bucket/oem/2026/drawing',
    uploadSecretHash: '',
    storagePath: 'oem/2026/drawing',
    byteSize: pdf.byteLength,
    checksumSha256: createHash('sha256').update(pdf).digest('hex'),
    mimeType: 'application/pdf',
  };
  const oem = {
    _id: 'oem_a',
    company: 'Buyer A',
    contact: 'Alex',
    email: 'buyer@example.invalid',
    whatsapp: '123',
    category: 'headphones',
    quantity: 500,
    drawing: 'drawing_a',
    status: 'new',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    uploadSecret: 'never-project-private-fields',
  };
  const quoteId = '12345678-1234-4234-8234-123456789012';
  const quote = {
    _id: quoteId,
    schemaVersion: 'catalog-quote-request-v1',
    target: { intent: 'customization', productId: 'product_a', revision: 'r1' },
    fields: {
      intent: 'customization',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: ['logo'],
      brief: 'Please print our company logo',
      contactName: 'Alex',
      email: 'buyer@example.invalid',
      company: 'Buyer A',
      country: 'US',
    },
    snapshot: {
      productName: 'Approved headphones',
      productId: 'product_a',
      revision: 'r1',
      images: [],
      productOffers: [],
    },
    status: 'new',
    version: 0,
    notification: 'disabled',
    createdAt: oem.createdAt,
    updatedAt: oem.updatedAt,
    events: new Array<Record<string, unknown>>(),
    privateSupplierCost: 'must-not-project',
  };
  const rows = new Map<string, CollectionDoc>([
    ['oemProjects/oem_a', oem],
    ['files/drawing_a', file],
    [`catalogQuoteRequests/${quoteId}`, quote],
  ]);
  const calls: string[] = [];
  let failReads = false;
  let downloaded: Buffer = Buffer.from(pdf);
  const handler = createSalesHandler({
    client_id: 'client_a',
    business_line: 'website_sales',
    installation_id: 'site_a',
    environment: 'test',
    cloud_env_id: 'env_a',
    loadRegistry: async () => structuredClone(registry),
    loadCredential: async (ref) => (ref === 'env:AGENT_a' ? 'a'.repeat(48) : 'b'.repeat(48)),
    readDoc: async (collection, id) => {
      if (failReads) throw new Error('private-provider-error');
      calls.push(`${collection}/${id}`);
      return structuredClone(rows.get(`${collection}/${id}`) ?? null);
    },
    readFile: async (id) => {
      calls.push(id);
      return { body: downloaded.toString('base64'), byteSize: downloaded.byteLength };
    },
    readApprovedProduct: async (id, page, pageSize, revision) => {
      calls.push(`product/${id}/${page}/${pageSize}/${revision ?? ''}`);
      return {
        ok: true,
        data: {
          _id: id,
          name: 'Approved product',
          revision: 'r2',
          offers: [],
          variants: { items: [], page, pageSize, total: 0, hasMore: false },
        },
      };
    },
  });
  const request = (url = '/integrations/sales/inquiries/oem/oem_a'): SalesRequest => ({
    method: 'GET',
    url,
    headers: {
      authorization: `Bearer ${'a'.repeat(48)}`,
      'x-sales-connection-id': 'agent_a',
      'x-sales-context': Buffer.from(
        JSON.stringify({
          client_id: 'client_a',
          business_line: 'website_sales',
          source_installation_id: 'site_a',
          runtime_id: 'runtime_a',
          environment: 'test',
          control_epoch: 1,
        }),
      ).toString('base64url'),
    },
  });
  return {
    registry,
    handler,
    request,
    rows,
    calls,
    file,
    oem,
    quote,
    quoteId,
    pdf,
    setReadFailure: () => {
      failReads = true;
    },
    setDownload: (bytes: Buffer) => {
      downloaded = bytes;
    },
  };
}
