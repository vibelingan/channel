/** Opt-in local HTTP intake backed by the actual approved CloudBase environment. No mail. */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import cloudbase from '@cloudbase/node-sdk';
import { validateContract } from '@vibelingan-channel/sales-contracts';
import { z } from 'zod';
import { createAssistantInquiryStore } from '../../../../packages/db/src/assistant-inquiry.ts';
import type { NodeSdkDatabase } from '../../../../packages/db/src/cloudbase-adapter.ts';
import {
  assertSalesSdkWrite,
  normalizeSalesSdkDocument,
} from '../../../../packages/db/src/sales-inquiry-read.ts';
import { readSalesInquiry } from '../../../../packages/db/src/sales-inquiry-source.ts';
import {
  planSalesSubmission,
  registrationKey,
} from '../../../../packages/db/src/sales-inquiry-submission.ts';
import { createAssistantIntake } from '../src/assistant-intake.ts';
import { createDeliveryStore } from '../src/delivery-store.ts';
import { createSalesHandler } from '../src/handler.ts';
import { HttpInquirySender } from '../src/inquiry-sender.ts';
import { createPermitClient } from '../src/permit-client.ts';
import { createSalesServer } from '../src/server.ts';
import { createCloudBaseSourceGrantStore } from '../src/source-grant-store.ts';
import { WebsiteDelivery } from '../src/website-delivery.ts';
const token = process.env.ASSISTANT_LIVE_TOKEN ?? '';
if (!/^[a-zA-Z0-9_-]{48,128}$/.test(token)) throw new Error('Dedicated live test token required');
const path = process.env.ASSISTANT_LIVE_CREDENTIALS_FILE ?? '';
if (((await stat(path)).mode & 0o077) !== 0)
  throw new Error('Temporary credential file must be private');
const credentials: { env: string; secretId: string; secretKey: string; sessionToken: string } =
  JSON.parse(await readFile(path, 'utf8'));
assert.equal(credentials.env, 'diversity-123-d9grnqfux221323bb');
assert.ok(
  [credentials.secretId, credentials.secretKey, credentials.sessionToken].every(
    (v) => typeof v === 'string' && v.length > 0,
  ),
);
const app = cloudbase.init({ ...credentials, region: 'ap-shanghai' });
const db = app.database();
type Transaction = Parameters<Parameters<NodeSdkDatabase['runTransaction']>[0]>[0];
const scope = {
  client_id: 'acceptance_20261102',
  business_line: 'website_sales',
  source_installation_id: 'assistant_acceptance_20261102',
  environment: 'test' as const,
  cloud_env_id: credentials.env,
  cutover_at: 0,
};
const { cutover_at: _cutover, ...installation } = scope;
await db.runTransaction(async (tx: Transaction) => {
  const doc = tx.collection('channelSalesInstallations').doc(scope.source_installation_id);
  const prior = normalizeSalesSdkDocument(await doc.get(), scope.source_installation_id);
  if (prior) assert.deepEqual(prior.record, { ...installation, state: 'active' });
  else
    assertSalesSdkWrite(
      await doc.set({ record: { ...installation, state: 'active' } }),
      scope.source_installation_id,
    );
});
const catalog = 'https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com';
const store = createAssistantInquiryStore(db, scope, async (id) => {
  const response = await fetch(
    `${catalog}/api/products/${encodeURIComponent(id)}/detail?pageSize=1`,
    { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Public product unavailable');
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object' || !('ok' in raw))
    throw new Error('Invalid product response');
  if (raw.ok !== true) {
    if (
      'error' in raw &&
      raw.error &&
      typeof raw.error === 'object' &&
      'code' in raw.error &&
      raw.error.code === 'NOT_FOUND'
    )
      return null;
    throw new Error('Public product unavailable');
  }
  if (!('data' in raw) || !raw.data || typeof raw.data !== 'object')
    throw new Error('Invalid product data');
  const row = raw.data;
  if (
    !('name' in row) ||
    typeof row.name !== 'string' ||
    !('revision' in row) ||
    typeof row.revision !== 'string' ||
    !('_id' in row) ||
    row._id !== id
  )
    throw new Error('Invalid public product identity');
  return { productId: id, productName: row.name, revision: row.revision };
});
let linkedReference = '';
let captureNewSubmissions = false;
const intake = createAssistantIntake(
  {
    submit: async (input) => {
      if (
        !input.submission.email.endsWith('@example.invalid') ||
        !input.submission.company.startsWith('[TEST')
      )
        throw new Error('Live acceptance refuses real customer data');
      const receipt = await store.submit(input);
      if (captureNewSubmissions) linkedReference = receipt.reference;
      return receipt;
    },
  },
  token,
);
const reply = (status: number, body: unknown) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: Buffer.from(JSON.stringify(body)),
});
// Optional full linked acceptance: only this synthetic installation and one saved reference.
const linkedFile = process.env.ASSISTANT_LIVE_LINKED_FILE;
let handler: ReturnType<typeof createSalesHandler> | undefined;
let delivery: WebsiteDelivery | undefined;
if (linkedFile) {
  assert.equal((await stat(linkedFile)).mode & 0o077, 0);
  const secret = z.string().regex(/^[A-Za-z0-9_-]{48,128}$/);
  const config = z
    .object({
      registry: z.unknown(),
      reference: z
        .string()
        .regex(/^ai_[a-f0-9]{64}$/)
        .nullable(),
      captureNewSubmissions: z.boolean().default(false),
      hubOrigin: z.string().url(),
      sourceToken: secret,
      readToken: secret,
      grantToken: secret,
      controlToken: secret,
    })
    .strict()
    .parse(JSON.parse(await readFile(linkedFile, 'utf8')));
  const registry = validateContract('client-bindings', config.registry);
  assert.equal(registry.bindings.length, 1);
  const binding = registry.bindings[0];
  assert.ok(binding);
  assert.equal(binding.client_id, scope.client_id);
  assert.equal(binding.source_installation_id, scope.source_installation_id);
  assert.equal(binding.environment, 'test');
  assert.equal(binding.automation_mode, 'draft_only');
  assert.ok(config.reference || config.captureNewSubmissions);
  captureNewSubmissions = config.captureNewSubmissions;
  const hub = new URL(config.hubOrigin);
  assert.equal(hub.protocol, 'http:');
  assert.equal(hub.hostname, '127.0.0.1');
  assert.equal(
    new Set([config.sourceToken, config.readToken, config.grantToken, config.controlToken]).size,
    4,
  );
  if (config.reference) {
    const original = normalizeSalesSdkDocument(
      await db.collection('oemProjects').doc(config.reference).get(),
      config.reference,
    );
    assert.equal(original?.client_id, scope.client_id);
    assert.equal(original?.source_installation_id, scope.source_installation_id);
    assert.equal(original?.email, 'acceptance@example.invalid');
    assert.ok(String(original?.company).startsWith('[TEST'));
  }
  await db.runTransaction(async (tx: Transaction) => {
    const target = tx.collection('channelSalesBindings').doc(scope.source_installation_id);
    const prior = normalizeSalesSdkDocument(await target.get(), scope.source_installation_id);
    if (prior) assert.deepEqual(prior.registry, registry);
    else assertSalesSdkWrite(await target.set({ registry }), scope.source_installation_id);
  });
  linkedReference = config.reference ?? '';
  const record = async (collection: string, id: string) =>
    normalizeSalesSdkDocument(await db.collection(collection).doc(id).get(), id)?.record;
  const loadRegistry = async () =>
    normalizeSalesSdkDocument(
      await db.collection('channelSalesBindings').doc(scope.source_installation_id).get(),
      scope.source_installation_id,
    )?.registry;
  const loadCredential = async (ref: string) =>
    ref === 'env:ASSISTANT_LIVE_READ'
      ? config.readToken
      : ref === 'env:ASSISTANT_LIVE_OPERATOR'
        ? config.controlToken
        : undefined;
  const now = () => Math.floor(Date.now() / 1000);
  handler = createSalesHandler({
    client_id: scope.client_id,
    business_line: scope.business_line,
    installation_id: scope.source_installation_id,
    environment: 'test',
    cloud_env_id: scope.cloud_env_id,
    loadRegistry,
    loadCredential,
    sourceGrants: {
      enabled: true,
      token: config.grantToken,
      forbiddenTokens: [config.readToken, config.controlToken],
      store: createCloudBaseSourceGrantStore(db),
      now,
    },
    taskAccess: {
      now,
      loadLease: (hash) => record('channelSalesTaskLeases', hash),
      loadHandoff: (hash) => record('channelSalesSourceHandoffs', hash),
      loadInstallation: () => record('channelSalesInstallations', scope.source_installation_id),
      fetchPermit: createPermitClient(
        `${hub.origin}/sales/authorize-read`,
        config.controlToken,
        'test',
        10000,
      ),
    },
    readDoc: async (collection, id) =>
      normalizeSalesSdkDocument(await db.collection(collection).doc(id).get(), id),
    readFile: async () => {
      throw new Error('No attachments in this live acceptance');
    },
    readApprovedProduct: async (id, page, pageSize, revision) => {
      const url = new URL(`/api/products/${encodeURIComponent(id)}/detail`, catalog);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('Live catalog unavailable');
      const body: unknown = await r.json();
      const data = body && typeof body === 'object' && 'data' in body ? body.data : null;
      if (
        revision &&
        (!data || typeof data !== 'object' || !('revision' in data) || data.revision !== revision)
      )
        return { ok: false, error: { code: 'REVISION_CHANGED' } };
      return body;
    },
  });
  const runtimeConnection = binding.connections.find((row) => row.actor.kind === 'runtime');
  assert.ok(runtimeConnection);
  const persistedDelivery = createDeliveryStore(db);
  const observedDelivery = {
    ...persistedDelivery,
    transaction: async <T,>(operation: Parameters<typeof persistedDelivery.transaction<T>>[0]) => {
      let stage = 'begin';
      try {
        return await persistedDelivery.transaction((tx) =>
          operation({
            read: async (collection, id) => {
              stage = `read:${collection}`;
              return tx.read(collection, id);
            },
            write: async (collection, id, value) => {
              stage = `write:${collection}`;
              return tx.write(collection, id, value);
            },
          }),
        );
      } catch (error) {
        const known = [
          'Untrusted source registration',
          'Source installation unavailable',
          'Source delivery connection unavailable',
          'Source credential reused',
          'Malformed source row',
          'Source submission incomplete',
          'Source registration changed',
          'Wrong delivery identity',
          'Source delivery was not registered atomically',
          'Invalid sales SDK read result',
          'Invalid sales document identity',
          'Sales SDK write not acknowledged',
        ];
        const message = error instanceof Error ? error.message : 'unknown';
        console.error(
          JSON.stringify({
            type: 'linked_gate_error',
            stage,
            reason: known.includes(message)
              ? message
              : message
                  .replace(/https?:\/\/\S+/g, '[endpoint]')
                  .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
                  .slice(0, 400),
          }),
        );
        throw error;
      }
    },
  };
  delivery = new WebsiteDelivery({
    enabled: true,
    scope: { ...scope, runtime_id: binding.runtime_id, control_epoch: binding.control_epoch },
    connection_id: runtimeConnection.connection_id,
    source_token: config.sourceToken,
    loadCredential,
    store: observedDelivery,
    now,
    sender: new HttpInquirySender(`${hub.origin}/sales/events`, config.sourceToken, 'test'),
  });
}
let delivering = false;
let deliveredReference = '';
const timer = setInterval(() => {
  const current = delivery;
  const reference = linkedReference;
  if (!current || !reference || reference === deliveredReference || delivering) return;
  delivering = true;
  void (async () => {
    const row = normalizeSalesSdkDocument(
      await db.collection('oemProjects').doc(reference).get(),
      reference,
    );
    assert.ok(row);
    const plan = await planSalesSubmission(
      scope,
      'oem',
      row,
      null,
      Math.floor(Date.parse(String(row.createdAt)) / 1000),
    );
    const outcome = await current.deliver(registrationKey(plan.registration));
    if (outcome.state === 'accepted' || outcome.state === 'already_accepted')
      deliveredReference = reference;
    console.log(
      JSON.stringify({ type: 'linked_delivery', state: outcome.state, receipt: outcome.receipt }),
    );
  })()
    .catch(() => console.error('linked_delivery_failed'))
    .finally(() => {
      delivering = false;
    });
}, 2000);
const server = createSalesServer(async (request) => {
  if (request.url === '/api/integrations/sales/assistant-inquiries') return intake(request);
  if (handler && !request.url.startsWith('/__live/')) {
    const start = Date.now();
    const result = await handler(request);
    console.log(
      JSON.stringify({
        type: 'sales_route',
        path: request.url,
        status: result.status,
        duration_ms: Date.now() - start,
      }),
    );
    return result;
  }
  if (request.headers.authorization !== `Bearer ${token}`)
    return reply(401, { code: 'UNAUTHENTICATED' });
  const id = /^\/__live\/readback\/(ai_[a-f0-9]{64})$/.exec(request.url)?.[1];
  if (!id) return reply(404, { code: 'NOT_FOUND' });
  const row = normalizeSalesSdkDocument(await db.collection('oemProjects').doc(id).get(), id);
  if (
    !row ||
    row.client_id !== scope.client_id ||
    row.source_installation_id !== scope.source_installation_id
  )
    return reply(404, { code: 'NOT_FOUND' });
  const result = await readSalesInquiry(
    {
      ...scope,
      readDoc: async (collection, key) =>
        normalizeSalesSdkDocument(await db.collection(collection).doc(key).get(), key),
    },
    'oem',
    id,
  );
  const plan = await planSalesSubmission(
    scope,
    'oem',
    row,
    null,
    Math.floor(Date.parse(String(row.createdAt)) / 1000),
  );
  const key = registrationKey(plan.registration);
  const pending = normalizeSalesSdkDocument(
    await db.collection('channelSalesSourceDeliveries').doc(key).get(),
    key,
  );
  const registered = normalizeSalesSdkDocument(
    await db.collection('channelSalesSourceRegistrations').doc(key).get(),
    key,
  );
  return reply(200, {
    reference: id,
    scope,
    view: result.view,
    registrationPresent: !!registered,
    pending: pending?.record,
    emailCalls: 0,
  });
});
const port = process.env.ASSISTANT_LIVE_PORT ? 62687 : 0;
server.listen(port, '127.0.0.1', () =>
  console.log(
    JSON.stringify({
      type: 'ready',
      port: (server.address() as { port: number }).port,
      pid: process.pid,
      cloud: credentials.env,
      scope,
    }),
  ),
);
for (const name of ['SIGINT', 'SIGTERM'] as const)
  process.once(name, () => {
    clearInterval(timer);
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
