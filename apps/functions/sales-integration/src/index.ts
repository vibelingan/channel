import * as cloudbase from '@cloudbase/node-sdk';
import type { CloudBase } from '@cloudbase/node-sdk';
import { createAssistantInquiryStore } from '@vibelingan-channel/db/assistant-inquiry';
import { readSalesSourceRecord } from '@vibelingan-channel/db/sales-inquiry-read';
import { salesCaptureFromEnv } from '@vibelingan-channel/db/sales-inquiry-submission';
import { resolveSalesCredential } from '@vibelingan-channel/db/sales-inquiry-submission';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { scfRuntimeCredential } from '@vibelingan/tencent-service-auth';
import { createApprovedProductReader } from '../../public-api/src/catalog-detail.ts';
import { createAssistantIntake } from './assistant-intake.ts';
import { createCatalogReadPort } from './catalog-read-port.ts';
import { createDeliveryReconcileRoute } from './delivery-reconcile-route.ts';
import { type SalesRequest, type SalesResponse, createSalesHandler } from './handler.ts';
import { createPermitClient } from './permit-client.ts';
import { readPrivateFile } from './private-file.ts';
import { configuredWebsiteDelivery, submissionDelivery } from './runtime-delivery.ts';
import { createSalesServer } from './server.ts';
import { createCloudBaseSourceGrantStore } from './source-grant-store.ts';

export function createSalesRuntime(
  app?: CloudBase,
): (request: SalesRequest) => Promise<SalesResponse> {
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
  if (
    process.env.SALES_ASSISTANT_INTAKE_ENABLED === '1' &&
    [process.env.SALES_SOURCE_GRANT_TOKEN, process.env.SALES_HERMES_AUTH_TOKEN].includes(
      required('SALES_ASSISTANT_INTAKE_TOKEN'),
    )
  )
    throw new Error('Assistant credential must be dedicated');
  const permitClient = createPermitClient(
    required('SALES_HERMES_AUTH_URL'),
    required('SALES_HERMES_AUTH_TOKEN'),
    environment === 'test' ? 'test' : 'production',
    Number(process.env.SALES_PERMIT_TIMEOUT_MS ?? 3000),
  );
  if (!app) throw Error('A request-scoped CloudBase app is required');
  const database = app.database({ throwOnNotFound: false });
  const getProductDetail = createApprovedProductReader(createCatalogReadPort(database));
  const storage = createCloudBaseMediaStorage(app);
  const delivery = configuredWebsiteDelivery(process.env, app);
  return createSalesHandler({
    client_id: clientId,
    business_line: businessLine,
    installation_id: installationId,
    environment: environment === 'test' ? 'test' : 'production',
    cloud_env_id: envId,
    ...(delivery
      ? {
          deliveryReconcile: createDeliveryReconcileRoute(
            delivery,
            required('SALES_SOURCE_DELIVERY_TOKEN'),
            [
              process.env.SALES_ASSISTANT_INTAKE_TOKEN,
              process.env.SALES_SOURCE_GRANT_TOKEN,
              process.env.SALES_HERMES_AUTH_TOKEN,
              process.env.SALES_HERMES_SOURCE_TOKEN,
              process.env.SALES_RUNTIME_TOKEN,
              process.env.SALES_SOURCE_ACTIVATION_TOKEN,
            ],
          ),
        }
      : {}),
    ...(process.env.SALES_ASSISTANT_INTAKE_ENABLED === '1'
      ? {
          assistantIntake: createAssistantIntake(
            createAssistantInquiryStore(
              database,
              (() => {
                const scope = salesCaptureFromEnv(process.env);
                if (!scope) throw new Error('Assistant intake requires sales source capture');
                return scope;
              })(),
              async (id) => {
                if (process.env.CATALOG_DETAIL_APPROVAL_ENABLED !== '1')
                  throw new Error('Approved product reader not enabled');
                const result = await getProductDetail(id, 1, 1);
                if (!result.ok) {
                  if (result.error.code === 'NOT_FOUND') return null;
                  throw new Error('Public product unavailable');
                }
                if (!result.data.revision) throw new Error('Public revision missing');
                return {
                  productId: id,
                  productName: result.data.name,
                  revision: result.data.revision,
                };
              },
            ),
            required('SALES_ASSISTANT_INTAKE_TOKEN'),
            submissionDelivery(delivery),
          ),
        }
      : {}),
    ...(process.env.SALES_SOURCE_GRANTS_ENABLED === '1'
      ? {
          sourceGrants: {
            enabled: true,
            token: required('SALES_SOURCE_GRANT_TOKEN'),
            forbiddenTokens: [required('SALES_HERMES_AUTH_TOKEN')],
            store: createCloudBaseSourceGrantStore(database),
            now: () => Math.floor(Date.now() / 1000),
          },
        }
      : {}),
    taskAccess: {
      now: () => Math.floor(Date.now() / 1000),
      loadLease: (hash) => loadSalesRecord(database, 'channelSalesTaskLeases', hash),
      loadHandoff: (hash) => loadSalesRecord(database, 'channelSalesSourceHandoffs', hash),
      loadInstallation: () =>
        loadSalesRecord(database, 'channelSalesInstallations', installationId),
      fetchPermit: permitClient,
    },
    loadRegistry: async () => {
      const result = await database.collection('channelSalesBindings').doc(installationId).get();
      const row: unknown = Array.isArray(result.data) ? result.data[0] : result.data;
      return row && typeof row === 'object' && 'registry' in row ? row.registry : undefined;
    },
    loadCredential: async (ref) => {
      return resolveSalesCredential(ref, process.env);
    },
    readDoc: (collection, id) => readSalesSourceRecord(database, collection, id),
    readFile: (id) => readPrivateFile(storage, id, storageHosts),
    readApprovedProduct: (id, page, size, revision) =>
      process.env.CATALOG_DETAIL_APPROVAL_ENABLED === '1'
        ? getProductDetail(id, page, size, revision, true, true, true)
        : Promise.resolve({
            ok: false,
            error: {
              code: 'NOT_FOUND',
              message: 'Approved catalog unavailable',
            },
          }),
  });
}

async function loadSalesRecord(
  database: ReturnType<CloudBase['database']>,
  collection: 'channelSalesTaskLeases' | 'channelSalesSourceHandoffs' | 'channelSalesInstallations',
  id: string,
): Promise<unknown> {
  const result = await database.collection(collection).doc(id).get();
  const row: unknown = Array.isArray(result.data) ? result.data[0] : result.data;
  return row && typeof row === 'object' && 'record' in row ? row.record : undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function createScfSalesHandler(
  initialize: (
    credential: ReturnType<typeof scfRuntimeCredential>,
  ) => ReturnType<typeof createSalesRuntime> = (credential) =>
    createSalesRuntime(cloudbase.init({ env: required('TCB_ENV'), ...credential })),
): ReturnType<typeof createSalesRuntime> {
  return async (request) => {
    if (process.env.SALES_INTEGRATION_ENABLED !== '1') return createSalesRuntime()(request);
    const application = request.headers['x-sales-authorization'];
    if (typeof application !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(application))
      return {
        status: 401,
        headers: { 'Cache-Control': 'private, no-store' },
        body: Buffer.from('{"code":"UNAUTHENTICATED"}'),
      };
    try {
      const identity = scfRuntimeCredential(request.headers, {
        namespace: required('TCB_ENV'),
        name: 'sales-integration',
      });
      const {
        authorization: _platformAuthorization,
        'x-sales-authorization': _application,
        ...headers
      } = request.headers;
      return await initialize(identity)({
        ...request,
        headers: { ...headers, authorization: application },
      });
    } catch {
      return {
        status: 503,
        headers: { 'Cache-Control': 'private, no-store' },
        body: Buffer.from('{"code":"SERVICE_UNAVAILABLE"}'),
      };
    }
  };
}

if (require.main === module) {
  const server = createSalesServer(createScfSalesHandler());
  server.listen(9000, '0.0.0.0');
}
