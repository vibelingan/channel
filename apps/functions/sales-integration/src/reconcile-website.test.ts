import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredWebsiteDelivery, reconcileWebsiteOnce } from './reconcile-website.ts';

test('delivery defaults off without touching configuration or opening a backend', async () => {
  assert.equal(configuredWebsiteDelivery({ TCB_ENV: 'unused-invalid-environment' }), null);
  assert.deepEqual(await reconcileWebsiteOnce({}), {
    state: 'disabled',
    wrapped: false,
    results: [],
  });
});

test('explicit delivery enable requires complete fixed capture and connection configuration', () => {
  assert.throws(() => configuredWebsiteDelivery({ SALES_SOURCE_DELIVERY_ENABLED: '1' }));
  const base = {
    SALES_SOURCE_DELIVERY_ENABLED: '1',
    SALES_CLIENT_ID: 'client_a',
    SALES_BUSINESS_LINE: 'website_sales',
    SALES_INSTALLATION_ID: 'site_a',
    SALES_ENVIRONMENT: 'test',
    TCB_ENV: 'env_a',
    SALES_SOURCE_CUTOVER_AT: '0',
    SALES_CONTROL_EPOCH: '1',
    SALES_RUNTIME_ID: 'runtime_a',
    SALES_CHANNEL_CONNECTION_ID: 'agent_a',
    SALES_HERMES_EVENTS_URL: 'http://127.0.0.1:1/sales/events',
    SALES_HERMES_SOURCE_TOKEN: 's'.repeat(48),
  };
  for (const key of ['SALES_HERMES_AUTH_TOKEN', 'SALES_SOURCE_GRANT_TOKEN', 'SALES_RUNTIME_TOKEN'])
    assert.throws(
      () => configuredWebsiteDelivery({ ...base, [key]: 's'.repeat(48) }),
      /credential reused/,
    );
  assert.throws(
    () =>
      configuredWebsiteDelivery({
        ...base,
        SALES_HERMES_EVENTS_URL: 'http://remote.invalid/sales/events',
      }),
    /fixed Sales intake/,
  );
  assert.throws(
    () => configuredWebsiteDelivery({ ...base, SALES_CONTROL_EPOCH: 'NaN' }),
    /control epoch/,
  );
});
