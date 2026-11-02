import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setAdapter, type DbAdapter } from '@vibelingan-channel/db';
import type { NodeSdkDatabase } from '@vibelingan-channel/db/cloudbase';
import { saveQuoteInCloud } from '../../../../packages/db/src/catalog-inquiry-cloud.ts';
import {
  saveFinalizedOemInCloud,
  validateSourceRegistration,
  type SalesCaptureScope,
} from '@vibelingan-channel/db/sales-inquiry-submission';
import { type CollectionDoc, compareBySort, matchesFilter } from '@vibelingan-channel/shared';
import { setMediaStorage, type MediaStorageAdapter } from '@vibelingan-channel/media-storage';
import { handleAdminRequest, type AdminConfig } from '../../admin/src/handler.ts';
import { handleQuoteEvent } from '../../public-api/src/catalog-quote-http.ts';

/** Synthetic transactional documents; real producer functions use this mechanical SDK port. */
export function createWebsiteFixture() {
  const rows = new Map<string, CollectionDoc>();
  const objects = new Map<string, Buffer>();
  const scope: SalesCaptureScope = {
    client_id: 'client_a',
    business_line: 'website_sales',
    source_installation_id: 'site_a',
    environment: 'test',
    cloud_env_id: 'env_a',
    cutover_at: 0,
  };
  const registry = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/sales-contracts/fixtures/client-bindings.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  rows.set('channelSalesBindings/site_a', { _id: 'site_a', registry });
  rows.set('channelSalesInstallations/site_a', {
    _id: 'site_a',
    record: {
      client_id: scope.client_id,
      business_line: scope.business_line,
      source_installation_id: scope.source_installation_id,
      environment: scope.environment,
      cloud_env_id: scope.cloud_env_id,
      state: 'active',
    },
  });
  rows.set('products/product_a', {
    _id: 'product_a',
    published: true,
    archived: false,
    catalogDetailPublication: {
      state: 'approved',
      revision: 'r1',
      variantCount: 0,
      header: {
        schemaVersion: 'catalog-product-detail-v1',
        _id: 'product_a',
        name: 'Approved headphones',
        images: [],
        facts: [],
        offers: [],
      },
    },
  });
  let queue = Promise.resolve();
  let failAtWrite: number | undefined;
  let failAfterCommit = false;
  let beforeRead: ((id: string) => Promise<void>) | undefined;
  const database: NodeSdkDatabase = {
    command: { set: (value) => value },
    runTransaction: async (operation) => {
      const prior = queue;
      let unlock = () => {};
      queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await prior;
      const copy = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
      let writes = 0;
      let writing = false;
      try {
        const result = await operation({
          collection: (collection) => ({
            doc: (id) => ({
              get: async () => {
                if (writing) throw new Error('Read after write in website transaction');
                return { data: structuredClone(copy.get(`${collection}/${id}`) ?? null) };
              },
              set: async (data) => {
                writing = true;
                writes++;
                if (writes === failAtWrite) throw new Error('Synthetic write failure');
                if (Object.hasOwn(data, '_id')) throw new Error('SDK set id');
                copy.set(`${collection}/${id}`, { ...structuredClone(data), _id: id });
                return { upserted: [{ _id: id }] };
              },
              update: async () => {
                throw new Error('unused transaction update');
              },
              remove: async () => {
                throw new Error('unused transaction remove');
              },
            }),
          }),
        });
        rows.clear();
        for (const [key, value] of copy) rows.set(key, value);
        if (failAfterCommit) throw new Error('Synthetic committed response loss');
        return result;
      } finally {
        unlock();
      }
    },
  };
  const adapter: DbAdapter = {
    get: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) ?? null),
    findByField: async (collection, field, value) =>
      structuredClone(
        [...rows].find(
          ([key, row]) => key.startsWith(collection + '/') && row[field] === value,
        )?.[1] ?? null,
      ),
    list: async (query) => {
      let items = [...rows]
        .filter(([key]) => key.startsWith(query.collection + '/'))
        .map(([, row]) => structuredClone(row));
      if (query.filter) items = items.filter((row) => matchesFilter(row, query.filter!));
      if (query.sort) items.sort((a, b) => compareBySort(a, b, query.sort!));
      return {
        items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        total: items.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    },
    create: async (collection, data) => {
      const at = new Date().toISOString();
      const row = { ...structuredClone(data), _id: randomUUID(), createdAt: at, updatedAt: at };
      rows.set(`${collection}/${row._id}`, row);
      return row;
    },
    update: async (collection, id, data) => {
      const old = rows.get(`${collection}/${id}`);
      if (!old) return null;
      const row = { ...old, ...structuredClone(data), updatedAt: new Date().toISOString() };
      rows.set(`${collection}/${id}`, row);
      return row;
    },
    remove: async (collection, id) => rows.delete(`${collection}/${id}`),
    incrementField: async (collection, id, field, delta) => {
      const row = rows.get(`${collection}/${id}`);
      if (!row) return null;
      const value = Number(row[field] ?? 0) + delta;
      row[field] = value;
      return value;
    },
    submitCatalogQuote: (input, capture) => saveQuoteInCloud(database, input, capture),
    saveFinalizedSalesOemSubmission: (input, capture) =>
      saveFinalizedOemInCloud(database, input, capture),
  };
  const media: MediaStorageAdapter = {
    putObject: async () => {
      throw new Error('unused put');
    },
    getTempUrl: async () => {
      throw new Error('unused URL');
    },
    deleteObject: async (id) => {
      objects.delete(id);
    },
    getObjectAsBase64: async (id) => {
      if (beforeRead) await beforeRead(id);
      const bytes = objects.get(id);
      if (!bytes) throw new Error('Synthetic missing object');
      return { body: bytes.toString('base64'), byteSize: bytes.length };
    },
    getUploadCredential: async (path) => ({
      method: 'PUT',
      uploadUrl: 'https://offline.invalid/upload',
      headers: {
        Signature: 'offline',
        'x-cos-security-token': 'offline',
        'x-cos-meta-fileid': 'offline',
        authorization: 'offline',
        key: path,
      },
      storageFileId: `cloud://env_a.bucket/${path}`,
    }),
  };
  const install = () => {
    setAdapter(adapter);
    setMediaStorage(media);
  };
  const callOem = async (
    action: string,
    data: unknown,
    capture: SalesCaptureScope | null = scope,
  ) => {
    if (process.env.EMAIL_USER || process.env.EMAIL_PASSWORD)
      throw new Error('Offline website fixture requires SMTP credentials to be unset');
    install();
    const config: AdminConfig = {
      jwtSecret: 'offline-synthetic-secret',
      ...(capture ? { salesCapture: capture } : {}),
    };
    return handleAdminRequest({ action, data }, config, { sourceIp: '192.0.2.1' });
  };
  const quoteInput = () => ({
    idempotencyKey: randomUUID(),
    target: { intent: 'customization', productId: 'product_a', revision: 'r1' },
    fields: {
      intent: 'customization',
      quantity: '500',
      deliveryDate: '',
      customizationTypes: ['logo'],
      brief: 'Please add our company logo',
      contactName: 'Alex',
      email: 'buyer@example.invalid',
      company: 'Buyer',
      country: 'US',
    },
  });
  const submitProduct = async (
    input: unknown = quoteInput(),
    capture: SalesCaptureScope | null = scope,
  ) => {
    install();
    return handleQuoteEvent(
      {
        httpMethod: 'POST',
        headers: { origin: 'https://website.example.invalid', 'content-type': 'application/json' },
        body: JSON.stringify(input),
      },
      {
        enableInquiries: true,
        corsAllowedOrigins: ['https://website.example.invalid'],
        ...(capture ? { salesCapture: capture } : {}),
      },
      (body, owner) => saveQuoteInCloud(database, body, owner),
    );
  };
  const registrations = () =>
    [...rows]
      .filter(([key]) => key.startsWith('channelSalesSourceRegistrations/'))
      .map(([, row]) => validateSourceRegistration(row.record));
  return {
    rows,
    database,
    adapter,
    media,
    objects,
    scope,
    registry,
    install,
    callOem,
    quoteInput,
    submitProduct,
    registrations,
    setFailAtWrite: (value: number | undefined) => {
      failAtWrite = value;
    },
    setFailAfterCommit: (value: boolean) => {
      failAfterCommit = value;
    },
    setBeforeRead: (hook: typeof beforeRead) => {
      beforeRead = hook;
    },
  };
}
