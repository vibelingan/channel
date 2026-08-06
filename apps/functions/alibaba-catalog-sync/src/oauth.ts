/**
 * Alibaba OAuth connection lifecycle (ARCHITECTURE §8.1, MIU 5).
 *
 * Flow: admin-authenticated start action returns {authorizeUrl}; the browser
 * navigates; Alibaba redirects to the unauthenticated callback bound solely
 * by the stored single-use hashed state. Tokens are exchanged server-side,
 * AES-256-GCM encrypted, and never appear in logs, responses, or the browser.
 *
 * State single-use: the row is created via createDocWithId with
 * `consumeClaim: 0` and consumed by the incrementField CAS 0→1 — exactly one
 * callback wins (passwordResets.consumeClaim precedent). Expiry is checked
 * before the CAS; a replayed or expired state never reaches token exchange.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { AlibabaClient, AlibabaEndpoints } from '@vibelingan-channel/alibaba-catalog-sync';
import { buildAuthorizeUrl } from '@vibelingan-channel/alibaba-catalog-sync';
import { type AlibabaTokenEnvelope, decryptTokenPayload, encryptTokenPayload } from './crypto.ts';
import {
  createDoc,
  createDocWithId,
  getDoc,
  incrementField,
  listDocs,
  removeDoc,
  updateDoc,
  upsertDocWithId,
} from './repo.ts';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const STATE_SWEEP_LIMIT = 20;
/** Phase 2 authorizes ONE merchant account; the connection doc id is fixed. */
export const PRIMARY_CONNECTION_ID = 'primary';
/** Refresh when the access token is within this window of expiry (lazy, R1). */
const REFRESH_MARGIN_MS = 10 * 60_000;

export interface OAuthDeps {
  client: AlibabaClient;
  endpoints: AlibabaEndpoints;
  appKey: string;
  callbackUrl: string;
  tokenKey: Buffer;
  now: () => string;
  alert: (message: string) => Promise<void>;
}

export type OAuthStartResult =
  | { ok: true; authorizeUrl: string }
  | { ok: false; reason: 'state-mint-failed' };

export async function startOAuth(deps: OAuthDeps, userId: string): Promise<OAuthStartResult> {
  const now = deps.now();
  await sweepExpiredStates(now);
  const state = randomBytes(32).toString('base64url');
  const stateHash = createHash('sha256').update(state).digest('hex');
  const expiresAt = new Date(Date.parse(now) + OAUTH_STATE_TTL_MS).toISOString();
  const created = await createDocWithId('alibabaOAuthStates', stateHash, {
    requestedByUserId: userId,
    intent: 'connect',
    consumeClaim: 0,
    expiresAt,
    consumedAt: '',
    createdAt: now,
    updatedAt: now,
  });
  // 32 random bytes colliding an existing hash means the RNG is broken —
  // refuse rather than reuse someone else's state record.
  if (created !== 'created') return { ok: false, reason: 'state-mint-failed' };
  return {
    ok: true,
    authorizeUrl: buildAuthorizeUrl(deps.endpoints, {
      appKey: deps.appKey,
      redirectUri: deps.callbackUrl,
      state,
    }),
  };
}

async function sweepExpiredStates(now: string): Promise<void> {
  try {
    const page = await listDocs('alibabaOAuthStates', STATE_SWEEP_LIMIT);
    for (const doc of page) {
      if (typeof doc.expiresAt === 'string' && doc.expiresAt < now) {
        await removeDoc('alibabaOAuthStates', doc._id);
      }
    }
  } catch {
    // Best-effort hygiene; never blocks the start action.
  }
}

export type OAuthCallbackOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing-params'
        | 'unknown-state'
        | 'expired-state'
        | 'replayed-state'
        | 'exchange-failed';
    };

interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  accountLabel?: string;
}

function readTokenResponse(bodyText: string, now: string): TokenGrant | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  // Some GOP responses nest the grant under a wrapper key; accept both.
  const source =
    typeof root.access_token === 'string'
      ? root
      : ((root.data ?? root.result ?? root.token_result) as Record<string, unknown> | undefined);
  if (!source || typeof source.access_token !== 'string' || source.access_token.length === 0) {
    return null;
  }
  const grant: TokenGrant = { accessToken: source.access_token };
  if (typeof source.refresh_token === 'string' && source.refresh_token.length > 0) {
    grant.refreshToken = source.refresh_token;
  }
  // Expiry fields must come from the response, never hardcoded
  // (docs/accio-alibaba-integration/REPORT.md §3.2).
  const expiresIn = Number(source.expires_in ?? source.expire_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    grant.accessTokenExpiresAt = new Date(Date.parse(now) + expiresIn * 1000).toISOString();
  }
  const refreshExpiresIn = Number(source.refresh_expires_in ?? source.refresh_token_timeout);
  if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
    grant.refreshTokenExpiresAt = new Date(Date.parse(now) + refreshExpiresIn * 1000).toISOString();
  }
  const account = source.account ?? source.resource_owner ?? source.seller_account;
  if (typeof account === 'string' && account.length > 0) grant.accountLabel = account;
  return grant;
}

export async function handleOAuthCallback(
  deps: OAuthDeps,
  code: string | undefined,
  state: string | undefined,
): Promise<OAuthCallbackOutcome> {
  if (!code || !state) return { ok: false, reason: 'missing-params' };
  const now = deps.now();
  const stateHash = createHash('sha256').update(state).digest('hex');
  const record = await getDoc('alibabaOAuthStates', stateHash);
  if (!record) return { ok: false, reason: 'unknown-state' };
  if (typeof record.expiresAt !== 'string' || record.expiresAt <= now) {
    return { ok: false, reason: 'expired-state' };
  }
  // Single-use CAS: exactly one caller flips 0→1.
  const claim = await incrementField('alibabaOAuthStates', stateHash, 'consumeClaim', 1);
  if (claim !== 1) return { ok: false, reason: 'replayed-state' };
  await updateDoc('alibabaOAuthStates', stateHash, { consumedAt: now });

  const result = await deps.client.callApi({
    apiPath: deps.endpoints.tokenCreatePath,
    params: { code },
    maxAttempts: 1,
  });
  if (!result.ok) {
    await deps.alert('Alibaba OAuth token exchange failed (transport).');
    return { ok: false, reason: 'exchange-failed' };
  }
  const grant = readTokenResponse(result.bodyText, now);
  if (!grant) {
    await deps.alert('Alibaba OAuth token exchange failed (unexpected response shape).');
    return { ok: false, reason: 'exchange-failed' };
  }

  const envelopePayload: Record<string, unknown> = { accessToken: grant.accessToken };
  if (grant.refreshToken !== undefined) envelopePayload.refreshToken = grant.refreshToken;
  const envelope = encryptTokenPayload(deps.tokenKey, envelopePayload);
  const requestedBy = typeof record.requestedByUserId === 'string' ? record.requestedByUserId : '';
  await upsertDocWithId('alibabaConnections', PRIMARY_CONNECTION_ID, {
    status: 'active',
    accountLabel: grant.accountLabel ?? '',
    tokenEnvelope: envelope,
    accessTokenExpiresAt: grant.accessTokenExpiresAt ?? '',
    refreshTokenExpiresAt: grant.refreshTokenExpiresAt ?? '',
    authorizedByUserId: requestedBy,
    authorizedAt: now,
    lastAuthErrorAt: '',
  });
  return { ok: true };
}

export async function disconnectConnection(deps: Pick<OAuthDeps, 'now'>): Promise<boolean> {
  const existing = await getDoc('alibabaConnections', PRIMARY_CONNECTION_ID);
  if (!existing) return false;
  // Destroy the secret material, keep the audit shell.
  await updateDoc('alibabaConnections', PRIMARY_CONNECTION_ID, {
    status: 'disconnected',
    tokenEnvelope: null,
    accessTokenExpiresAt: '',
    refreshTokenExpiresAt: '',
  });
  return true;
}

export type AccessTokenResult =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      reason: 'not-connected' | 'authorization-expired' | 'decrypt-failed' | 'refresh-unavailable';
    };

/**
 * Current access token with LAZY refresh (test env has no timer — R1): refresh
 * when inside the margin, mark authorization_expired + alert on
 * non-recoverable failure.
 */
export async function getConnectionAccessToken(deps: OAuthDeps): Promise<AccessTokenResult> {
  const connection = await getDoc('alibabaConnections', PRIMARY_CONNECTION_ID);
  if (!connection || connection.status !== 'active') return { ok: false, reason: 'not-connected' };
  const payload = decryptTokenPayload(deps.tokenKey, connection.tokenEnvelope);
  if (!payload || typeof payload.accessToken !== 'string') {
    return { ok: false, reason: 'decrypt-failed' };
  }
  const now = deps.now();
  const expiresAt =
    typeof connection.accessTokenExpiresAt === 'string' ? connection.accessTokenExpiresAt : '';
  const needsRefresh =
    expiresAt !== '' && Date.parse(expiresAt) - Date.parse(now) < REFRESH_MARGIN_MS;
  if (!needsRefresh) return { ok: true, accessToken: payload.accessToken };

  const refreshToken = typeof payload.refreshToken === 'string' ? payload.refreshToken : '';
  if (!refreshToken) return await markAuthorizationExpired(deps, 'no refresh token');
  const result = await deps.client.callApi({
    apiPath: deps.endpoints.tokenRefreshPath,
    params: { refresh_token: refreshToken },
    maxAttempts: 1,
  });
  if (!result.ok) {
    // Classify the failure (review R2 #4 + R2-verify): an HTTP 4xx other than
    // 429 is the gateway REJECTING the refresh token (revoked app, elapsed
    // refresh_expires_in) — non-recoverable, so ARCHITECTURE §8 demands the
    // terminal state plus an alert. Everything else (network, timeout, 429,
    // 5xx, oversized body) is transport noise: keep the current token if it is
    // still valid this instant, otherwise report an outage and retry next tick.
    const rejected =
      result.kind === 'http' &&
      result.status !== undefined &&
      result.status >= 400 &&
      result.status < 500 &&
      result.status !== 429;
    if (rejected) return await markAuthorizationExpired(deps, 'refresh rejected by gateway');
    if (expiresAt > now) return { ok: true, accessToken: payload.accessToken };
    return { ok: false, reason: 'refresh-unavailable' };
  }
  const grant = readTokenResponse(result.bodyText, now);
  // A successful HTTP exchange whose body rejects the refresh token IS
  // non-recoverable — the merchant must re-authorize.
  if (!grant) return await markAuthorizationExpired(deps, 'refresh rejected');
  const nextPayload: Record<string, unknown> = { accessToken: grant.accessToken };
  if (grant.refreshToken !== undefined) nextPayload.refreshToken = grant.refreshToken;
  else nextPayload.refreshToken = refreshToken;
  await updateDoc('alibabaConnections', PRIMARY_CONNECTION_ID, {
    tokenEnvelope: encryptTokenPayload(deps.tokenKey, nextPayload),
    accessTokenExpiresAt: grant.accessTokenExpiresAt ?? '',
    ...(grant.refreshTokenExpiresAt !== undefined
      ? { refreshTokenExpiresAt: grant.refreshTokenExpiresAt }
      : {}),
  });
  return { ok: true, accessToken: grant.accessToken };
}

export type ConnectionProbe =
  | { ok: true }
  | { ok: false; reason: 'not-connected' | 'authorization-expired' | 'decrypt-failed' };

/**
 * READ-ONLY connection health probe (review R2-verify #4): reads the doc and
 * verifies the envelope decrypts, but NEVER refreshes — so it is safe outside
 * the sync lease, where a refresh would race the rotating refresh token. The
 * interactive runNow path uses it so a dead credential reports a conflict
 * instead of a success-shaped 'idle' when nothing happens to be due.
 */
export async function probeConnection(deps: OAuthDeps): Promise<ConnectionProbe> {
  const connection = await getDoc('alibabaConnections', PRIMARY_CONNECTION_ID);
  if (!connection) return { ok: false, reason: 'not-connected' };
  if (connection.status === 'authorization_expired') {
    return { ok: false, reason: 'authorization-expired' };
  }
  if (connection.status !== 'active') return { ok: false, reason: 'not-connected' };
  const payload = decryptTokenPayload(deps.tokenKey, connection.tokenEnvelope);
  if (!payload || typeof payload.accessToken !== 'string') {
    return { ok: false, reason: 'decrypt-failed' };
  }
  return { ok: true };
}

async function markAuthorizationExpired(
  deps: OAuthDeps,
  cause: string,
): Promise<AccessTokenResult> {
  await updateDoc('alibabaConnections', PRIMARY_CONNECTION_ID, {
    status: 'authorization_expired',
    lastAuthErrorAt: deps.now(),
  });
  // The cause is an internal category, never token material.
  await deps.alert(`Alibaba connection authorization expired (${cause}). Re-connect required.`);
  return { ok: false, reason: 'authorization-expired' };
}

/** Redacted connection view for the admin panel — never the envelope. */
export async function connectionStatusView(): Promise<Record<string, unknown>> {
  const connection = await getDoc('alibabaConnections', PRIMARY_CONNECTION_ID);
  if (!connection) return { status: 'not_connected' };
  return {
    status: connection.status ?? 'unknown',
    accountLabel: connection.accountLabel ?? '',
    accessTokenExpiresAt: connection.accessTokenExpiresAt ?? '',
    refreshTokenExpiresAt: connection.refreshTokenExpiresAt ?? '',
    authorizedAt: connection.authorizedAt ?? '',
    lastAuthErrorAt: connection.lastAuthErrorAt ?? '',
  };
}

// createDoc is re-exported so handler-level rate limiting shares one repo seam.
export { createDoc };
