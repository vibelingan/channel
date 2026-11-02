import { cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import {
  resolveSalesCredential,
  salesCaptureFromEnv,
} from '@vibelingan-channel/db/sales-inquiry-submission';
import { createDeliveryStore } from './delivery-store.ts';
import { HttpInquirySender } from './inquiry-sender.ts';
import { WebsiteDelivery } from './website-delivery.ts';

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`Missing Sales delivery configuration: ${key}`);
  return value;
}
export function configuredWebsiteDelivery(
  env: Record<string, string | undefined> = process.env,
): WebsiteDelivery | null {
  if (env.SALES_SOURCE_DELIVERY_ENABLED !== '1') return null;
  const scope = salesCaptureFromEnv({ ...env, SALES_SOURCE_CAPTURE_ENABLED: '1' });
  if (!scope) throw new Error('Missing capture scope');
  const epoch = required(env, 'SALES_CONTROL_EPOCH');
  if (!/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('Invalid delivery control epoch');
  const sourceToken = required(env, 'SALES_HERMES_SOURCE_TOKEN');
  for (const key of [
    'SALES_SOURCE_GRANT_TOKEN',
    'SALES_HERMES_AUTH_TOKEN',
    'SALES_RUNTIME_TOKEN',
    'SALES_SOURCE_ACTIVATION_TOKEN',
  ])
    if (env[key] === sourceToken) throw new Error('Sales source credential reused');
  const sender = new HttpInquirySender(
    required(env, 'SALES_HERMES_EVENTS_URL'),
    sourceToken,
    scope.environment,
  );
  initCloudBase(scope.cloud_env_id);
  return new WebsiteDelivery({
    enabled: true,
    scope: {
      ...scope,
      runtime_id: required(env, 'SALES_RUNTIME_ID'),
      control_epoch: Number(epoch),
    },
    connection_id: required(env, 'SALES_CHANNEL_CONNECTION_ID'),
    source_token: sourceToken,
    store: createDeliveryStore(cloudStorageSdk().database()),
    sender,
    loadCredential: async (ref) => resolveSalesCredential(ref, env),
    now: () => Math.floor(Date.now() / 1000),
  });
}
export async function reconcileWebsiteOnce(env: Record<string, string | undefined> = process.env) {
  const worker = configuredWebsiteDelivery(env);
  return worker ? worker.tick() : { state: 'disabled', wrapped: false, results: [] };
}
if (require.main === module) {
  reconcileWebsiteOnce()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => {
      process.stderr.write('Sales website reconciliation failed\n');
      process.exitCode = 1;
    });
}
