/**
 * Client for the alibaba-catalog-sync function's admin actions (MIU 13).
 * Same Bearer/JSON envelope as the admin API: {action, token, data} POSTs —
 * the session rides the body, never a cookie (ARCHITECTURE §8.1). Responses
 * never contain token material; the panel renders redacted status only.
 */
import { apiUrl } from '../../../lib/api-url.ts';
import { getToken } from '../../../lib/session.ts';

const ENDPOINT = apiUrl('/api/alibaba-catalog-sync');

export class AlibabaSyncApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AlibabaSyncApiError';
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function call<T>(action: string, data?: unknown): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token: getToken() }),
  });
  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    envelope = null;
  }
  if (!envelope) {
    throw new AlibabaSyncApiError(
      res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR',
      `Request failed (${res.status})`,
    );
  }
  if (!envelope.ok || envelope.data === undefined) {
    throw new AlibabaSyncApiError(
      envelope.error?.code ?? 'INTERNAL_ERROR',
      envelope.error?.message ?? 'Request failed.',
    );
  }
  return envelope.data;
}

export interface ConnectionStatus {
  status: string;
  accountLabel?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  authorizedAt?: string;
  lastAuthErrorAt?: string;
  notConfigured: boolean;
  missing?: string[];
}

export function fetchConnectionStatus(): Promise<ConnectionStatus> {
  return call<ConnectionStatus>('connectionStatus');
}

export function startOAuthFlow(): Promise<{ authorizeUrl: string }> {
  return call<{ authorizeUrl: string }>('oauthStart');
}

export function disconnectAlibaba(): Promise<{ disconnected: boolean }> {
  return call<{ disconnected: boolean }>('disconnect');
}

export interface TickReport {
  outcome: string;
  runId?: string;
  detail?: string;
}

export function runSyncNow(): Promise<TickReport> {
  return call<TickReport>('runNow');
}

export function approveQuarantine(
  runId: string,
  candidateHash: string,
): Promise<{ runId: string; promoted: number }> {
  return call('approveQuarantine', { runId, candidateHash });
}

export function linkSourceProduct(
  sourceKey: string,
  productId: string,
): Promise<{ sourceKey: string; productId: string; alreadyLinked: boolean }> {
  return call('linkProduct', { sourceKey, productId });
}

export function unlinkSourceProduct(
  productId: string,
): Promise<{ productId: string; clearedLinks: number }> {
  return call('unlinkProduct', { productId });
}
