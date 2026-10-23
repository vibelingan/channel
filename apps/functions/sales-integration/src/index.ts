import { get, setAdapter } from '@vibelingan-channel/db';
import { cloudBaseAdapter, cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { getProductDetail } from '../../public-api/src/catalog-detail.ts';
import { type SalesRequest, type SalesResponse, createSalesHandler } from './handler.ts';
import { readPrivateFile } from './private-file.ts';
import { createSalesServer } from './server.ts';

export function createSalesRuntime(): (request: SalesRequest) => Promise<SalesResponse> {
  if (process.env.SALES_INTEGRATION_ENABLED !== '1')
    return async () => ({
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
      body: Buffer.from('{"code":"NOT_ENABLED"}'),
    });
  const clientId = required('SALES_CLIENT_ID');
  const businessLine = required('SALES_BUSINESS_LINE');
  const installationId = required('SALES_INSTALLATION_ID');
  const envId = required('TCB_ENV');
  const environment = required('SALES_ENVIRONMENT');
  const storageHosts = required('SALES_STORAGE_HOSTS')
    .split(',')
    .map((host) => host.trim().toLowerCase());
  if (storageHosts.some((host) => !/^[a-z0-9.-]+$/.test(host)))
    throw new Error('Invalid SALES_STORAGE_HOSTS');
  if (!['test', 'production'].includes(environment)) throw new Error('Invalid SALES_ENVIRONMENT');
  initCloudBase(envId);
  setAdapter(cloudBaseAdapter);
  const storage = createCloudBaseMediaStorage(cloudStorageSdk());
  return createSalesHandler({
    client_id: clientId,
    business_line: businessLine,
    installation_id: installationId,
    environment: environment === 'test' ? 'test' : 'production',
    cloud_env_id: envId,
    loadRegistry: async () => {
      const result = await cloudStorageSdk()
        .database()
        .collection('channelSalesBindings')
        .doc(installationId)
        .get();
      const row: unknown = Array.isArray(result.data) ? result.data[0] : result.data;
      return row && typeof row === 'object' && 'registry' in row ? row.registry : undefined;
    },
    loadCredential: async (ref) => {
      const name = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(ref)?.[1];
      return name ? process.env[name] : undefined;
    },
    readDoc: (collection, id) => get(collection, id),
    readFile: (id) => readPrivateFile(storage, id, storageHosts),
    readApprovedProduct: (id, page, size, revision) =>
      process.env.CATALOG_DETAIL_APPROVAL_ENABLED === '1'
        ? getProductDetail(id, page, size, revision, true, true, true)
        : Promise.resolve({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Approved catalog unavailable' },
          }),
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

if (require.main === module) {
  const server = createSalesServer(createSalesRuntime());
  server.listen(9000, '0.0.0.0');
}
