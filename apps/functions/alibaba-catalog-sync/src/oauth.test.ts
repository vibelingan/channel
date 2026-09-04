import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { type SessionClaims, signSession } from '@vibelingan-channel/auth/jwt';
import type { AdapterListQuery, DbAdapter } from '@vibelingan-channel/db';
import { setAdapter } from '@vibelingan-channel/db';
import {
  type CollectionDoc,
  type ListResult,
  compareBySort,
  matchesFilter,
} from '@vibelingan-channel/shared';
import { decryptTokenPayload, encryptTokenPayload, parseTokenEncryptionKey } from './crypto.ts';
import {
  type AlibabaSyncFunctionConfig,
  handleAlibabaSyncRequest,
  handleOAuthCallbackRequest,
  resolveRuntime,
} from './handler.ts';
import { handleAlibabaSyncFunctionEvent } from './http-adapter.ts';
import { OAUTH_CALLBACK_RATE_MAX_PER_SOURCE } from './rate-limit.ts';

// --- harness -----------------------------------------------------------------

type Store = Record<string, CollectionDoc[]>;

class MemoryAdapter implements DbAdapter {
  private nextId = 1;
  constructor(readonly store: Store) {}

  private docs(collection: string): CollectionDoc[] {
    this.store[collection] ??= [];
    return this.store[collection] as CollectionDoc[];
  }
  async list(query: AdapterListQuery): Promise<ListResult<CollectionDoc>> {
    let docs = [...this.docs(query.collection)];
    if (query.filter) {
      const filter = query.filter;
      docs = docs.filter((doc) => matchesFilter(doc, filter));
    }
    if (query.sort && query.sort.length > 0) {
      docs.sort((a, b) => compareBySort(a, b, query.sort ?? []));
    }
    const start = (query.page - 1) * query.pageSize;
    return {
      items: docs.slice(start, start + query.pageSize),
      total: docs.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(collection: string, id: string): Promise<CollectionDoc | null> {
    return this.docs(collection).find((d) => d._id === id) ?? null;
  }
  async findByField(): Promise<CollectionDoc | null> {
    return null;
  }
  async create(collection: string, data: Record<string, unknown>): Promise<CollectionDoc> {
    const doc = { _id: `mem-${this.nextId++}`, ...data } as CollectionDoc;
    this.docs(collection).push(doc);
    return doc;
  }
  async update(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return null;
    docs[index] = { ...(docs[index] as CollectionDoc), ...data };
    return docs[index] as CollectionDoc;
  }
  async remove(collection: string, id: string): Promise<boolean> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return false;
    docs.splice(index, 1);
    return true;
  }
  async incrementField(
    collection: string,
    id: string,
    field: string,
    delta: number,
  ): Promise<number | null> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    if (index < 0) return null;
    const current = Number((docs[index] as CollectionDoc)[field] ?? 0);
    const next = current + delta;
    docs[index] = { ...(docs[index] as CollectionDoc), [field]: next };
    return next;
  }
  async createDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<'created' | 'exists'> {
    const docs = this.docs(collection);
    if (docs.some((d) => d._id === id)) return 'exists';
    const { _id, ...payload } = data as Record<string, unknown> & { _id?: unknown };
    docs.push({ _id: id, ...payload } as CollectionDoc);
    return 'created';
  }
  async upsertDocWithId(
    collection: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<CollectionDoc> {
    const docs = this.docs(collection);
    const index = docs.findIndex((d) => d._id === id);
    const { _id, ...patch } = data as Record<string, unknown> & { _id?: unknown };
    if (index >= 0) {
      docs[index] = { ...(docs[index] as CollectionDoc), ...patch };
      return docs[index] as CollectionDoc;
    }
    const created = { _id: id, ...patch } as CollectionDoc;
    docs.push(created);
    return created;
  }
}

const KEY_HEX = randomBytes(32).toString('hex');
const TOKEN_KEY = parseTokenEncryptionKey(KEY_HEX) as Buffer;
const NOW = '2026-08-06T09:00:00.000Z';

const baseConfig: AlibabaSyncFunctionConfig = {
  jwtSecret: 'test-secret',
  corsAllowedOrigins: ['https://site.example'],
  siteUrl: 'https://site.example',
  appKey: '511630',
  appSecret: 'app-secret',
  callbackUrl: 'https://env.service.tcloudbase.com/api/alibaba-catalog-sync/oauth/callback',
  tokenKeyHex: KEY_HEX,
};

let currentStore: Store = {};
function setup(store: Store = {}): Store {
  currentStore = store;
  setAdapter(new MemoryAdapter(store));
  return store;
}

function seedUser(claims: SessionClaims, status = 'active'): void {
  currentStore.users ??= [];
  currentStore.users.push({
    _id: claims.sub,
    username: claims.name,
    email: claims.email,
    role: claims.role,
    status,
  } as CollectionDoc);
}

async function adminToken(status = 'active'): Promise<string> {
  const claims: SessionClaims = {
    sub: 'admin-1',
    email: 'a@example.com',
    name: 'admin',
    role: 'admin',
  };
  seedUser(claims, status);
  return signSession('test-secret', claims);
}

async function contributorToken(): Promise<string> {
  const claims: SessionClaims = {
    sub: 'contrib-1',
    email: 'c@example.com',
    name: 'contrib',
    role: 'contributor',
  };
  seedUser(claims);
  return signSession('test-secret', claims);
}

interface FetchLogEntry {
  url: string;
  body: string;
}

function fakeAlibabaFetch(
  log: FetchLogEntry[],
  tokenResponse: Record<string, unknown> = {
    access_token: 'live-access-token',
    refresh_token: 'live-refresh-token',
    expires_in: 36_000,
    refresh_expires_in: 5_184_000,
    account: 'merchant@example.com',
  },
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    log.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(tokenResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const alerts: string[] = [];
function overrides(fetchImpl: typeof fetch, now = NOW) {
  return {
    fetchImpl,
    now: () => now,
    alert: async (message: string) => {
      alerts.push(message);
    },
  };
}

async function startAndExtractState(
  token: string,
  fetchImpl: typeof fetch,
  at?: string,
): Promise<string> {
  const result = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token },
    baseConfig,
    {},
    overrides(fetchImpl, at),
  );
  assert.equal(result.ok, true, `oauthStart failed: ${JSON.stringify(result)}`);
  const authorizeUrl = (result as { ok: true; data: { authorizeUrl: string } }).data.authorizeUrl;
  const state = new URL(authorizeUrl).searchParams.get('state');
  assert.ok(state);
  return state;
}

// --- crypto ------------------------------------------------------------------

test('token envelope roundtrips and fails closed on tamper or wrong key', () => {
  const envelope = encryptTokenPayload(TOKEN_KEY, { accessToken: 't1', refreshToken: 'r1' });
  assert.equal(envelope.v, 'v1');
  const decrypted = decryptTokenPayload(TOKEN_KEY, envelope);
  assert.deepEqual(decrypted, { accessToken: 't1', refreshToken: 'r1' });
  const tampered = { ...envelope, data: `${envelope.data.slice(0, -4)}AAAA` };
  assert.equal(decryptTokenPayload(TOKEN_KEY, tampered), null);
  const otherKey = parseTokenEncryptionKey(randomBytes(32).toString('hex')) as Buffer;
  assert.equal(decryptTokenPayload(otherKey, envelope), null);
  assert.equal(decryptTokenPayload(TOKEN_KEY, 'not-an-envelope'), null);
});

test('key parsing enforces 64 lowercase hex chars', () => {
  assert.equal(parseTokenEncryptionKey(undefined), null);
  assert.equal(parseTokenEncryptionKey('short'), null);
  assert.equal(parseTokenEncryptionKey(KEY_HEX.toUpperCase()), null);
  assert.equal(parseTokenEncryptionKey(KEY_HEX)?.length, 32);
});

// --- oauth start -------------------------------------------------------------

test('oauthStart stores only the HASHED single-use state and returns the authorize URL', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const state = await startAndExtractState(token, fakeAlibabaFetch(log));

  const stateHash = createHash('sha256').update(state).digest('hex');
  const rows = currentStore.alibabaOAuthStates ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?._id, stateHash, 'doc id is sha256(state)');
  assert.equal(rows[0]?.consumeClaim, 0);
  assert.equal(rows[0]?.requestedByUserId, 'admin-1');
  assert.ok((rows[0]?.expiresAt as string) > NOW);
  assert.ok(!JSON.stringify(rows).includes(state), 'plaintext state never persisted');
  assert.equal(log.length, 0, 'start performs no Alibaba call');
});

test('oauthStart requires a live admin role (contributor forbidden, suspended rejected)', async () => {
  setup();
  const contrib = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token: contrib },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');

  setup();
  const suspended = await adminToken('suspended');
  const rejected = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token: suspended },
    baseConfig,
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'UNAUTHORIZED');

  const anonymous = await handleAlibabaSyncRequest({ action: 'oauthStart' }, baseConfig);
  assert.equal(anonymous.ok, false);
  if (!anonymous.ok) assert.equal(anonymous.error.code, 'UNAUTHORIZED');
});

test('oauthStart reports not-configured with the missing variable names', async () => {
  setup();
  const token = await adminToken();
  const { appKey, appSecret, ...withoutKeys } = baseConfig;
  const result = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token },
    withoutKeys as AlibabaSyncFunctionConfig,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'CONFLICT');
    assert.ok(result.error.message.includes('ALI_APP_KEY'));
    assert.ok(result.error.message.includes('ALI_APP_SECRET'));
  }
});

// --- oauth callback ----------------------------------------------------------

test('callback exchanges the code, encrypts tokens, activates the connection, redirects', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);

  const redirect = await handleOAuthCallbackRequest(
    { code: 'auth-code-1', state },
    baseConfig,
    { sourceIp: '203.0.113.5' },
    overrides(fetchImpl),
  );
  assert.equal(redirect.location, 'https://site.example/admin?alibaba=connected');

  assert.equal(log.length, 1, 'exactly one token exchange');
  assert.ok(log[0]?.url.endsWith('/auth/token/create'));
  const sentParams = new URLSearchParams(log[0]?.body ?? '');
  assert.equal(sentParams.get('code'), 'auth-code-1');
  assert.equal(sentParams.get('app_key'), '511630');
  assert.ok(sentParams.get('sign'));

  const connection = currentStore.alibabaConnections?.[0];
  assert.ok(connection);
  assert.equal(connection._id, 'primary');
  assert.equal(connection.status, 'active');
  assert.equal(connection.accountLabel, 'merchant@example.com');
  assert.equal(connection.authorizedByUserId, 'admin-1');
  const payload = decryptTokenPayload(TOKEN_KEY, connection.tokenEnvelope);
  assert.deepEqual(payload, {
    accessToken: 'live-access-token',
    refreshToken: 'live-refresh-token',
  });
  assert.ok(
    !JSON.stringify(currentStore).includes('live-access-token'),
    'no plaintext token at rest',
  );

  const stateRow = currentStore.alibabaOAuthStates?.[0];
  assert.equal(stateRow?.consumeClaim, 1);
  assert.equal(stateRow?.consumedAt, NOW);
});

test('callback replay loses the CAS and never re-exchanges', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);

  const first = await handleOAuthCallbackRequest(
    { code: 'c', state },
    baseConfig,
    { sourceIp: '203.0.113.5' },
    overrides(fetchImpl),
  );
  assert.ok(first.location.endsWith('alibaba=connected'));
  const replay = await handleOAuthCallbackRequest(
    { code: 'c', state },
    baseConfig,
    { sourceIp: '203.0.113.5' },
    overrides(fetchImpl),
  );
  assert.ok(replay.location.endsWith('alibaba=error-replayed-state'));
  assert.equal(log.length, 1, 'replay never reaches token exchange');
});

test('callback rejects unknown, expired, and missing states without exchanging', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);

  const missing = await handleOAuthCallbackRequest({}, baseConfig, {}, overrides(fetchImpl));
  assert.ok(missing.location.endsWith('alibaba=error-missing-params'));

  const unknown = await handleOAuthCallbackRequest(
    { code: 'c', state: 'forged-state' },
    baseConfig,
    {},
    overrides(fetchImpl),
  );
  assert.ok(unknown.location.endsWith('alibaba=error-unknown-state'));

  const state = await startAndExtractState(token, fetchImpl);
  const afterExpiry = '2026-08-06T09:10:00.001Z'; // TTL is 10 minutes
  const expired = await handleOAuthCallbackRequest(
    { code: 'c', state },
    baseConfig,
    {},
    overrides(fetchImpl, afterExpiry),
  );
  assert.ok(expired.location.endsWith('alibaba=error-expired-state'));
  assert.equal(log.length, 0, 'no exchange for any rejected state');
});

test('callback is rate-limited per source (reserve-first ledger)', async () => {
  setup();
  const fetchImpl = fakeAlibabaFetch([]);
  let limited = 0;
  for (let i = 0; i < OAUTH_CALLBACK_RATE_MAX_PER_SOURCE + 2; i += 1) {
    const redirect = await handleOAuthCallbackRequest(
      { code: 'c', state: `bogus-${i}` },
      baseConfig,
      { sourceIp: '198.51.100.7' },
      overrides(fetchImpl),
    );
    if (redirect.location.endsWith('alibaba=rate-limited')) limited += 1;
  }
  assert.ok(limited >= 2, `expected the tail of the burst to be limited, got ${limited}`);
  const hashed = createHash('sha256').update('198.51.100.7').digest('hex');
  const rows = currentStore.rateLimitHits ?? [];
  assert.ok(rows.every((row) => row.sourceHash === hashed || row.sourceHash === ''));
  assert.ok(!JSON.stringify(rows).includes('198.51.100.7'), 'raw IP never stored');
});

// --- status / disconnect -----------------------------------------------------

test('connectionStatus is redacted and disconnect destroys the envelope', async () => {
  setup();
  const token = await adminToken();
  const fetchImpl = fakeAlibabaFetch([]);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const status = await handleAlibabaSyncRequest(
    { action: 'connectionStatus', token },
    baseConfig,
    {},
    overrides(fetchImpl),
  );
  assert.equal(status.ok, true);
  if (status.ok) {
    const data = status.data as Record<string, unknown>;
    assert.equal(data.status, 'active');
    assert.equal(data.notConfigured, false);
    assert.ok(!('tokenEnvelope' in data), 'envelope never leaves the server');
    assert.ok(!JSON.stringify(data).includes('live-access-token'));
  }

  const disconnect = await handleAlibabaSyncRequest(
    { action: 'disconnect', token },
    baseConfig,
    {},
    overrides(fetchImpl),
  );
  assert.equal(disconnect.ok, true);
  const connection = currentStore.alibabaConnections?.[0];
  assert.equal(connection?.status, 'disconnected');
  assert.equal(connection?.tokenEnvelope, null, 'secret material destroyed');
});

test('inspectProductDetail is admin-only and validates one bounded provider id', async () => {
  setup();
  const contributor = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    {
      action: 'inspectProductDetail',
      token: contributor,
      data: { sourceProductId: 'AAGmBBhgAOVTpOOZBg7MoZq_' },
    },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');

  const admin = await adminToken();
  const invalid = await handleAlibabaSyncRequest(
    {
      action: 'inspectProductDetail',
      token: admin,
      data: { sourceProductId: '../not-a-product-id' },
    },
    baseConfig,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'VALIDATION_ERROR');
});

test('draft materialization is admin-only and validates its bounded cursor page', async () => {
  setup();
  const contributor = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    { action: 'materializeDrafts', token: contributor, data: { afterSourceKey: '', limit: 20 } },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');

  const admin = await adminToken();
  const invalid = await handleAlibabaSyncRequest(
    { action: 'materializeDrafts', token: admin, data: { limit: 21 } },
    baseConfig,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'VALIDATION_ERROR');

  const empty = await handleAlibabaSyncRequest(
    { action: 'materializeDrafts', token: admin, data: { afterSourceKey: '', limit: 20 } },
    baseConfig,
  );
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.deepEqual(empty.data, {
      afterSourceKey: '',
      nextSourceKey: '',
      done: true,
      visited: 0,
      created: 0,
      existing: 0,
      failures: [],
    });
  }
});

test('manual sync cannot be started by a contributor', async () => {
  setup();
  const contributor = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    { action: 'runNow', token: contributor },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');
  assert.equal(currentStore.alibabaSyncRuns?.length ?? 0, 0);
});

test('selected product sync is admin-only and rejects malformed provider ids', async () => {
  setup();
  const contributor = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    {
      action: 'syncProduct',
      token: contributor,
      data: { sourceProductId: 'AAGmBBhgAOVTpOOZBg7MoZq_' },
    },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');

  const admin = await adminToken();
  const invalid = await handleAlibabaSyncRequest(
    { action: 'syncProduct', token: admin, data: { sourceProductId: '../../secret' } },
    baseConfig,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'VALIDATION_ERROR');
});

test('raw observation replay is admin-only and apply requires hash, total and manifest', async () => {
  setup();
  const contributor = await contributorToken();
  const forbidden = await handleAlibabaSyncRequest(
    {
      action: 'replaySourceObservations',
      token: contributor,
      data: { mode: 'dry-run', limit: 10 },
    },
    baseConfig,
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, 'FORBIDDEN');

  const admin = await adminToken();
  const missingHash = await handleAlibabaSyncRequest(
    {
      action: 'replaySourceObservations',
      token: admin,
      data: { mode: 'apply', limit: 10 },
    },
    baseConfig,
  );
  assert.equal(missingHash.ok, false);
  if (!missingHash.ok) assert.equal(missingHash.error.code, 'VALIDATION_ERROR');

  const missingTotal = await handleAlibabaSyncRequest(
    {
      action: 'replaySourceObservations',
      token: admin,
      data: { mode: 'apply', limit: 10, expectedPageHash: 'a'.repeat(64) },
    },
    baseConfig,
  );
  assert.equal(missingTotal.ok, false);
  if (!missingTotal.ok) assert.equal(missingTotal.error.code, 'VALIDATION_ERROR');

  const missingManifest = await handleAlibabaSyncRequest(
    {
      action: 'replaySourceObservations',
      token: admin,
      data: {
        mode: 'apply',
        limit: 10,
        expectedPageHash: 'a'.repeat(64),
        expectedTotalSourceProducts: 1,
      },
    },
    baseConfig,
  );
  assert.equal(missingManifest.ok, false);
  if (!missingManifest.ok) assert.equal(missingManifest.error.code, 'VALIDATION_ERROR');

  const unknownField = await handleAlibabaSyncRequest(
    {
      action: 'replaySourceObservations',
      token: admin,
      data: { mode: 'dry-run', limit: 10, raw: true },
    },
    baseConfig,
  );
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.equal(unknownField.error.code, 'VALIDATION_ERROR');
});

// --- http adapter ------------------------------------------------------------

test('http adapter: OPTIONS preflight, health, callback redirect, POST envelope, 405', async () => {
  setup();
  const token = await adminToken();
  const fetchImpl = fakeAlibabaFetch([]);

  const preflight = (await handleAlibabaSyncFunctionEvent(
    {
      httpMethod: 'OPTIONS',
      path: '/api/alibaba-catalog-sync',
      headers: { origin: 'https://site.example' },
    },
    baseConfig,
  )) as { statusCode: number; headers: Record<string, string> };
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://site.example');

  const health = (await handleAlibabaSyncFunctionEvent(
    { httpMethod: 'GET', path: '/api/alibaba-catalog-sync/health', headers: {} },
    baseConfig,
  )) as { statusCode: number; body: string };
  assert.equal(health.statusCode, 200);
  assert.ok(health.body.includes('alibaba-catalog-sync'));

  const state = await startAndExtractState(token, fetchImpl);
  const callback = (await handleAlibabaSyncFunctionEvent(
    {
      httpMethod: 'GET',
      path: '/api/alibaba-catalog-sync/oauth/callback',
      queryStringParameters: { code: 'c', state },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    },
    baseConfig,
    overrides(fetchImpl),
  )) as { statusCode: number; headers: Record<string, string> };
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.Location, 'https://site.example/admin?alibaba=connected');

  const post = (await handleAlibabaSyncFunctionEvent(
    {
      httpMethod: 'POST',
      path: '/api/alibaba-catalog-sync',
      headers: { origin: 'https://site.example' },
      body: JSON.stringify({ action: 'connectionStatus', token }),
    },
    baseConfig,
    overrides(fetchImpl),
  )) as { statusCode: number; body: string };
  assert.equal(post.statusCode, 200);
  assert.ok(post.body.includes('"status":"active"'));

  const put = (await handleAlibabaSyncFunctionEvent(
    { httpMethod: 'PUT', path: '/api/alibaba-catalog-sync', headers: {} },
    baseConfig,
  )) as { statusCode: number };
  assert.equal(put.statusCode, 405);
});

// --- lazy refresh ------------------------------------------------------------

test('access token refreshes lazily near expiry and expires the connection on failure', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  assert.equal(log.length, 1);

  const { getConnectionAccessToken } = await import('./oauth.ts');
  const runtime = resolveRuntime(baseConfig, overrides(fetchImpl));
  assert.equal(runtime.ok, true);
  if (!runtime.ok) return;

  // Fresh token (10h expiry) — no refresh call.
  const fresh = await getConnectionAccessToken(runtime.runtime.deps);
  assert.deepEqual(fresh, { ok: true, accessToken: 'live-access-token' });
  assert.equal(log.length, 1);

  // Near expiry — refresh fires and the envelope re-encrypts.
  const nearExpiry = '2026-08-06T18:55:00.000Z'; // 9h55m after NOW, inside 10min margin
  const refreshFetch = fakeAlibabaFetch(log, {
    access_token: 'rotated-access-token',
    refresh_token: 'rotated-refresh-token',
    expires_in: 36_000,
  });
  const refreshRuntime = resolveRuntime(baseConfig, overrides(refreshFetch, nearExpiry));
  if (!refreshRuntime.ok) return;
  const rotated = await getConnectionAccessToken(refreshRuntime.runtime.deps);
  assert.deepEqual(rotated, { ok: true, accessToken: 'rotated-access-token' });
  assert.ok(log[log.length - 1]?.url.endsWith('/auth/token/refresh'));
  const connection = currentStore.alibabaConnections?.[0];
  const payload = decryptTokenPayload(TOKEN_KEY, connection?.tokenEnvelope);
  assert.equal(payload?.accessToken, 'rotated-access-token');

  // Refresh REJECTED after full expiry -> authorization_expired + alert.
  const afterFullExpiry = '2026-08-07T09:00:00.000Z';
  const failingFetch = (async () =>
    new Response(JSON.stringify({ error_code: 'InvalidRefreshToken' }), {
      status: 200,
    })) as typeof fetch;
  const failedRuntime = resolveRuntime(baseConfig, overrides(failingFetch, afterFullExpiry));
  if (!failedRuntime.ok) return;
  const failed = await getConnectionAccessToken(failedRuntime.runtime.deps);
  assert.deepEqual(failed, { ok: false, reason: 'authorization-expired' });
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'authorization_expired');
  assert.equal(alerts.length, 1);
  assert.ok(!alerts[0]?.includes('rotated'), 'alert carries no token material');
});

test('an HTTP 4xx WITHOUT a rejection code is not terminal — and escalates', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // The refresh HOST + PATH are ASSUMED-UNVERIFIED until the MIU 15 live
  // smoke, so a bare 4xx is as likely to be a moved path or an edge rule as a
  // revocation. Destroying the connection on that guess needs a human to undo.
  const afterFullExpiry = '2026-08-07T09:00:00.000Z';
  for (const status of [400, 401, 403, 404, 408]) {
    const opaqueFetch = (async () =>
      new Response('<html>Not Found</html>', { status })) as typeof fetch;
    const runtime = resolveRuntime(baseConfig, overrides(opaqueFetch, afterFullExpiry));
    if (!runtime.ok) return;
    const result = await getConnectionAccessToken(runtime.runtime.deps);
    assert.deepEqual(result, { ok: false, reason: 'refresh-unavailable' }, `status ${status}`);
    assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active', `status ${status}`);
  }
  assert.equal(alerts.length, 1, 'paged once up front, not once per tick');
  assert.ok(!alerts[0]?.includes('Re-connect required'));

  // The outage START is preserved so its duration stays computable, and the
  // panel has something to render.
  const outageStart = currentStore.alibabaConnections?.[0]?.firstAuthErrorAt;
  assert.equal(outageStart, afterFullExpiry, 'first failure time pinned, not overwritten');

  // Still failing 7h later: it escalates with a re-connect recommendation.
  const laterFetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  const later = resolveRuntime(baseConfig, overrides(laterFetch, '2026-08-07T16:30:00.000Z'));
  if (!later.ok) return;
  await getConnectionAccessToken(later.runtime.deps);
  assert.equal(alerts.length, 2, 'a persistent outage escalates — never silent forever');
  assert.ok(alerts[1]?.includes('re-connect'), 'the escalation recommends reconnecting');
  assert.ok(alerts[1]?.includes('7h'), 'and states how long it has been failing');
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active', 'still not destroyed');

  // A recovery clears the whole outage window.
  const recoveredFetch = fakeAlibabaFetch(log, {
    access_token: 'post-outage-token',
    refresh_token: 'post-outage-refresh',
    expires_in: 36_000,
  });
  const recovered = resolveRuntime(
    baseConfig,
    overrides(recoveredFetch, '2026-08-07T17:00:00.000Z'),
  );
  if (!recovered.ok) return;
  assert.deepEqual(await getConnectionAccessToken(recovered.runtime.deps), {
    ok: true,
    accessToken: 'post-outage-token',
  });
  assert.equal(currentStore.alibabaConnections?.[0]?.firstAuthErrorAt, '', 'outage window cleared');
  assert.equal(currentStore.alibabaConnections?.[0]?.lastAuthErrorAt, '');
});

test('a REJECTION CODE in the error body is terminal, whatever the status', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // The merchant revoked the app: RFC 6749 §5.2 encodes that as HTTP 400 with
  // error=invalid_grant. The gateway's OWN words are the evidence — a status
  // code alone never is.
  const revokedFetch = (async () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }), {
      status: 400,
    })) as typeof fetch;
  const runtime = resolveRuntime(baseConfig, overrides(revokedFetch, '2026-08-07T09:00:00.000Z'));
  assert.equal(runtime.ok, true);
  if (!runtime.ok) return;
  const result = await getConnectionAccessToken(runtime.runtime.deps);
  assert.deepEqual(result, { ok: false, reason: 'authorization-expired' });
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'authorization_expired');
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0]?.includes('Re-connect required'), 'ops is told to re-authorize');
  assert.ok(!alerts[0]?.includes('invalid_grant'), 'no gateway text echoed into the alert');
});

test('APP-scoped errors are never terminal — re-authorizing cannot fix provisioning', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // `access_denied` / `unauthorized_client` name the APP (unprovisioned API
  // path, IP allowlist, wrong grant type), not the merchant's grant. Treating
  // them as terminal creates a destroy -> re-authorize -> destroy loop that
  // re-authorization can never break, because the fault is provisioning.
  for (const code of ['access_denied', 'unauthorized_client', 'isv.access_denied']) {
    const deniedFetch = (async () =>
      new Response(JSON.stringify({ error: code }), { status: 403 })) as typeof fetch;
    const runtime = resolveRuntime(baseConfig, overrides(deniedFetch, '2026-08-07T09:00:00.000Z'));
    if (!runtime.ok) return;
    const result = await getConnectionAccessToken(runtime.runtime.deps);
    assert.deepEqual(result, { ok: false, reason: 'refresh-unavailable' }, code);
    assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active', code);
  }
  // It is still reported, and still escalates if the gateway keeps refusing.
  assert.equal(alerts.length, 1);
  assert.ok(!alerts[0]?.includes('Re-connect required'));
});

test('re-connecting clears the whole outage window (no false alarm, no lost escalation)', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken, connectionStatusView } = await import('./oauth.ts');

  // Drive an outage so the window is populated.
  const downFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  const down = resolveRuntime(baseConfig, overrides(downFetch, '2026-08-07T09:00:00.000Z'));
  if (!down.ok) return;
  await getConnectionAccessToken(down.runtime.deps);
  assert.equal(currentStore.alibabaConnections?.[0]?.firstAuthErrorAt, '2026-08-07T09:00:00.000Z');

  // The operator re-connects. upsertDocWithId MERGES, so the window must be
  // explicitly cleared or the panel keeps crying wolf over a healthy link.
  const reconnectFetch = fakeAlibabaFetch(log, {
    access_token: 'fresh-access',
    refresh_token: 'fresh-refresh',
    expires_in: 36_000,
  });
  const state2 = await startAndExtractState(token, reconnectFetch, '2026-08-07T10:00:00.000Z');
  await handleOAuthCallbackRequest(
    { code: 'c2', state: state2 },
    baseConfig,
    {},
    overrides(reconnectFetch, '2026-08-07T10:00:00.000Z'),
  );
  const view = await connectionStatusView();
  assert.equal(view.status, 'active');
  assert.equal(view.firstAuthErrorAt, '', 'no false "refresh failing" banner');
  assert.equal(view.lastAuthErrorAt, '');

  // A NEW outage therefore starts its own escalation ladder from zero.
  alerts.length = 0;
  const down2 = resolveRuntime(baseConfig, overrides(downFetch, '2026-08-07T21:00:00.000Z'));
  if (!down2.ok) return;
  await getConnectionAccessToken(down2.runtime.deps);
  assert.equal(currentStore.alibabaConnections?.[0]?.firstAuthErrorAt, '2026-08-07T21:00:00.000Z');
  assert.equal(alerts.length, 1, 'the new outage pages immediately, not on an inherited clock');
});

test('a rotated refresh token never inherits the OLD token expiry', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  // Connect: access 1h, refresh 2h.
  const fetchImpl = fakeAlibabaFetch(log, {
    access_token: 'live-access-token',
    refresh_token: 'live-refresh-token',
    expires_in: 3_600,
    refresh_expires_in: 7_200,
  });
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  assert.equal(
    currentStore.alibabaConnections?.[0]?.refreshTokenExpiresAt,
    '2026-08-06T11:00:00.000Z',
  );

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // A healthy refresh rotates the token but omits refresh_expires_in — the
  // stored deadline now describes a token that no longer exists, so it must
  // be cleared rather than left to condemn a fresh credential.
  const rotatingFetch = fakeAlibabaFetch(log, {
    access_token: 'rotated-access',
    refresh_token: 'rotated-refresh',
    expires_in: 3_600,
  });
  const mid = resolveRuntime(baseConfig, overrides(rotatingFetch, '2026-08-06T09:55:00.000Z'));
  if (!mid.ok) return;
  assert.deepEqual(await getConnectionAccessToken(mid.runtime.deps), {
    ok: true,
    accessToken: 'rotated-access',
  });
  assert.equal(
    currentStore.alibabaConnections?.[0]?.refreshTokenExpiresAt,
    '',
    'the stale deadline is dropped with the token it described',
  );

  // Past the OLD deadline the connection is still healthy and refreshes fine.
  const laterFetch = fakeAlibabaFetch(log, {
    access_token: 'later-access',
    refresh_token: 'later-refresh',
    expires_in: 3_600,
  });
  const late = resolveRuntime(baseConfig, overrides(laterFetch, '2026-08-06T11:30:00.000Z'));
  if (!late.ok) return;
  assert.deepEqual(await getConnectionAccessToken(late.runtime.deps), {
    ok: true,
    accessToken: 'later-access',
  });
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active');
  assert.equal(alerts.length, 0, 'no connection was ever destroyed');
});

test('an ELAPSED stored refresh expiry is terminal — our own record, not a guess', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  // The grant states refresh_expires_in = 1h; the access token lasts 10h.
  const fetchImpl = fakeAlibabaFetch(log, {
    access_token: 'live-access-token',
    refresh_token: 'live-refresh-token',
    expires_in: 36_000,
    refresh_expires_in: 3_600,
  });
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  const callsAfterConnect = log.length;

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // Past both expiries, the gateway ALSO refuses. Record + failed call
  // together are evidence; the record alone would not be (rotation can leave
  // it stale), and the call is always attempted so a working gateway wins.
  const refusingFetch = (async () => new Response('nope', { status: 400 })) as typeof fetch;
  const late = resolveRuntime(baseConfig, overrides(refusingFetch, '2026-08-07T09:00:00.000Z'));
  assert.equal(late.ok, true);
  if (!late.ok) return;
  const result = await getConnectionAccessToken(late.runtime.deps);
  assert.deepEqual(result, { ok: false, reason: 'authorization-expired' });
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'authorization_expired');
  assert.equal(alerts.length, 1, 'operations is paged to re-connect');
  assert.ok(alerts[0]?.includes('Re-connect required'));
  assert.ok(log.length >= callsAfterConnect, 'the gateway was asked, not assumed');
});

test('a refresh 5xx / 429 is transport noise — retryable, connection stays active', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');
  const afterFullExpiry = '2026-08-07T09:00:00.000Z';

  for (const status of [429, 503]) {
    const failingFetch = (async () => new Response('upstream busy', { status })) as typeof fetch;
    const runtime = resolveRuntime(baseConfig, overrides(failingFetch, afterFullExpiry));
    if (!runtime.ok) return;
    const result = await getConnectionAccessToken(runtime.runtime.deps);
    assert.deepEqual(result, { ok: false, reason: 'refresh-unavailable' }, `status ${status}`);
    assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active', `status ${status}`);
  }
  assert.equal(alerts.length, 1, 'one outage page, and never an expiry alert');
  assert.ok(!alerts[0]?.includes('Re-connect required'));
  assert.equal(currentStore.alibabaConnections?.[0]?.firstAuthErrorAt !== '', true);
});

test('a still-valid access token keeps serving through a refresh outage', async () => {
  // The graceful-degradation arm: inside the refresh margin but BEFORE expiry,
  // a failing refresh must return the current token and NOT page anyone.
  // (Deleting that branch previously left the whole suite green.)
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');
  // Connected at 09:00 with expires_in 10h -> expiry 19:00. 18:55 is inside
  // the 10-minute margin, so a refresh fires, but the token is still valid.
  const downFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  const runtime = resolveRuntime(baseConfig, overrides(downFetch, '2026-08-06T18:55:00.000Z'));
  assert.equal(runtime.ok, true);
  if (!runtime.ok) return;
  const result = await getConnectionAccessToken(runtime.runtime.deps);
  assert.deepEqual(result, { ok: true, accessToken: 'live-access-token' }, 'keeps serving');
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active');
  assert.equal(alerts.length, 0, 'no page while the current token still works');
  assert.equal(
    currentStore.alibabaConnections?.[0]?.firstAuthErrorAt ?? '',
    '',
    'no outage window opened — nothing is degraded yet',
  );
});

test('probeConnection is read-only: reports health without any refresh call', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);

  const { probeConnection } = await import('./oauth.ts');
  const before = resolveRuntime(baseConfig, overrides(fetchImpl));
  assert.equal(before.ok, true);
  if (!before.ok) return;
  assert.deepEqual(await probeConnection(before.runtime.deps), {
    ok: false,
    reason: 'not-connected',
  });

  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  const callsAfterConnect = log.length;

  // Connected and healthy — even PAST full expiry the probe never refreshes.
  const late = resolveRuntime(baseConfig, overrides(fetchImpl, '2026-08-07T09:00:00.000Z'));
  if (!late.ok) return;
  assert.deepEqual(await probeConnection(late.runtime.deps), { ok: true });
  assert.equal(log.length, callsAfterConnect, 'zero network calls from the probe');

  // A rotated encryption key is caught without touching the network.
  const wrongKeyConfig = { ...baseConfig, tokenKeyHex: 'b'.repeat(64) };
  const rotated = resolveRuntime(wrongKeyConfig, overrides(fetchImpl));
  if (!rotated.ok) return;
  assert.deepEqual(await probeConnection(rotated.runtime.deps), {
    ok: false,
    reason: 'decrypt-failed',
  });
  assert.equal(log.length, callsAfterConnect, 'still zero network calls');
});

test('a refresh TRANSPORT outage is retryable — never authorization_expired', async () => {
  setup();
  alerts.length = 0;
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));

  const { getConnectionAccessToken } = await import('./oauth.ts');

  // Network down PAST full expiry: report an outage, keep the connection
  // active — flipping to the terminal state would demand a needless
  // re-authorization for a transient failure (review R2 #4).
  const afterFullExpiry = '2026-08-07T09:00:00.000Z';
  const downFetch = (async () => {
    throw new Error('ECONNRESET');
  }) as typeof fetch;
  const downRuntime = resolveRuntime(baseConfig, overrides(downFetch, afterFullExpiry));
  assert.equal(downRuntime.ok, true);
  if (!downRuntime.ok) return;
  const outage = await getConnectionAccessToken(downRuntime.runtime.deps);
  assert.deepEqual(outage, { ok: false, reason: 'refresh-unavailable' });
  assert.equal(currentStore.alibabaConnections?.[0]?.status, 'active', 'stays active');
  assert.equal(alerts.length, 1, 'the outage is reported, never silently');
  assert.ok(!alerts[0]?.includes('Re-connect required'), 'but not as an expiry');

  // Network back: the SAME refresh token still rotates successfully.
  const recoveredFetch = fakeAlibabaFetch(log, {
    access_token: 'recovered-access-token',
    refresh_token: 'recovered-refresh-token',
    expires_in: 36_000,
  });
  const recoveredRuntime = resolveRuntime(baseConfig, overrides(recoveredFetch, afterFullExpiry));
  if (!recoveredRuntime.ok) return;
  const recovered = await getConnectionAccessToken(recoveredRuntime.runtime.deps);
  assert.deepEqual(recovered, { ok: true, accessToken: 'recovered-access-token' });
});

// --- OAuth attempt diagnostics ------------------------------------------------

test('a successful connect leaves a durable attempt trail ending in connected', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);

  const started = currentStore.alibabaOAuthAttempts ?? [];
  assert.equal(started.length, 1, 'Connect opens an attempt');
  assert.equal(started[0]?.status, 'started');
  assert.equal(started[0]?.authorizationHost, 'open-api.alibaba.com');
  // Parameter NAMES only — never values.
  assert.equal(
    started[0]?.authorizationParameterNames,
    'client_id,force_auth,redirect_uri,response_type,state',
  );

  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  const done = (currentStore.alibabaOAuthAttempts ?? [])[0] as CollectionDoc;
  assert.equal(done.status, 'connected');
  assert.ok(String(done.callbackReceivedAt) !== '', 'callback boundary timestamped');
  assert.ok(String(done.exchangeStartedAt) !== '', 'exchange boundary timestamped');
  assert.ok(String(done.completedAt) !== '', 'completion timestamped');
});

test('the attempt trail NEVER stores state, code, or token material', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest(
    { code: 'SECRET-CODE', state },
    baseConfig,
    {},
    overrides(fetchImpl),
  );
  const serialized = JSON.stringify(currentStore.alibabaOAuthAttempts ?? []);
  for (const secret of [state, 'SECRET-CODE', 'live-access-token', 'live-refresh-token']) {
    assert.ok(!serialized.includes(secret), `attempt row leaked: ${secret.slice(0, 12)}`);
  }
});

test('a replayed callback is recorded as rejected_replayed_state, not a silent failure', async () => {
  setup();
  const token = await adminToken();
  const log: FetchLogEntry[] = [];
  const fetchImpl = fakeAlibabaFetch(log);
  const state = await startAndExtractState(token, fetchImpl);
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  await handleOAuthCallbackRequest({ code: 'c', state }, baseConfig, {}, overrides(fetchImpl));
  assert.equal(
    (currentStore.alibabaOAuthAttempts ?? [])[0]?.status,
    'rejected_replayed_state',
    'the second use is attributable, not lost',
  );
});

test('an attempt that never gets a callback stays at started — the Alibaba-side signal', async () => {
  // This is the whole point of the trail: distinguishing "Alibaba never came
  // back" from "our callback rejected it".
  setup();
  const token = await adminToken();
  await startAndExtractState(token, fakeAlibabaFetch([]));
  const attempt = (currentStore.alibabaOAuthAttempts ?? [])[0] as CollectionDoc;
  assert.equal(attempt.status, 'started');
  assert.equal(attempt.callbackReceivedAt, '', 'no callback was ever received');
});

test('attempt retention outlives the 10-minute state TTL', async () => {
  setup();
  const token = await adminToken();
  await startAndExtractState(token, fakeAlibabaFetch([]));
  const attempt = (currentStore.alibabaOAuthAttempts ?? [])[0] as CollectionDoc;
  const retainedMs = Date.parse(String(attempt.expiresAt)) - Date.parse(NOW);
  assert.equal(retainedMs, 7 * 24 * 60 * 60_000, 'seven days');
  assert.ok(retainedMs > 10 * 60_000, 'and far longer than the state TTL');
});

test('a diagnostics write failure does NOT break authorization', async () => {
  setup();
  const token = await adminToken();
  // Make every attempts write throw; Connect must still hand back a URL.
  const store = currentStore as Record<string, unknown>;
  Object.defineProperty(store, 'alibabaOAuthAttempts', {
    get() {
      throw new Error('diagnostics backend down');
    },
    configurable: true,
  });
  const result = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token },
    baseConfig,
    {},
    overrides(fakeAlibabaFetch([])),
  );
  // Restore a plain data property — assigning undefined would hit the throwing
  // accessor, and the getter must not survive into later tests.
  Object.defineProperty(store, 'alibabaOAuthAttempts', {
    value: [],
    writable: true,
    configurable: true,
  });
  assert.equal(result.ok, true, 'OAuth proceeds even with diagnostics broken');
});
