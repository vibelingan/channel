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

async function startAndExtractState(token: string, fetchImpl: typeof fetch): Promise<string> {
  const result = await handleAlibabaSyncRequest(
    { action: 'oauthStart', token },
    baseConfig,
    {},
    overrides(fetchImpl),
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
  const tampered = { ...envelope, data: envelope.data.slice(0, -4) + 'AAAA' };
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
