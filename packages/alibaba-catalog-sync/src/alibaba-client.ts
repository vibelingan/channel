/**
 * Signed HTTP client for the Alibaba.com Open Platform gateway.
 *
 * Pure transport: builds system params + signature, POSTs form-encoded to
 * the gateway, enforces timeout/size caps, retries transient failures, and
 * redacts everything. Response-shape interpretation lives in
 * alibaba-contracts.ts; endpoint selection in alibaba-endpoints.ts.
 *
 * Redaction contract (ARCHITECTURE §8): no error, log line, or fingerprint
 * ever contains the app secret, access/refresh tokens, the signature, or the
 * full signed URL.
 */

import { createHash } from 'node:crypto';
import type { AlibabaEndpoints } from './alibaba-endpoints.ts';
import { signTopRequest, topTimestamp } from './alibaba-signature.ts';

export interface AlibabaClientConfig {
  appKey: string;
  appSecret: string;
  endpoints: AlibabaEndpoints;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ApiCallInput {
  /** Gateway API path, e.g. '/alibaba/icbu/product/list'. */
  apiPath: string;
  params?: Record<string, string>;
  accessToken?: string;
  timeoutMs?: number;
  /** Total attempts including the first (default 3 for reads). */
  maxAttempts?: number;
}

export type ApiCallFailureKind = 'network' | 'timeout' | 'http' | 'body-too-large';

export type ApiCallResult =
  | { ok: true; status: number; bodyText: string }
  | {
      ok: false;
      kind: ApiCallFailureKind;
      status?: number;
      error: string;
      /**
       * Response body for an `http` failure, when the gateway sent one. GOP
       * encodes a rejected credential as an error code in the body of a 4xx,
       * so discarding it leaves callers unable to tell "your token is dead"
       * from "wrong path / edge rule" — a distinction the OAuth layer needs to
       * decide whether to destroy connection state. Never logged raw.
       */
      bodyText?: string;
    };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RETRY_BASE_DELAY_MS = 500;

/** Keys that must never appear in fingerprints or errors. */
const SECRET_PARAM_KEYS = new Set([
  'access_token',
  'refresh_token',
  'sign',
  'client_secret',
  'code',
]);

/**
 * Stable, secret-free identifier for a request, stored with raw payload
 * metadata (ARCHITECTURE §3.5): sha256 over apiPath + sorted non-secret params.
 */
export function fingerprintRequest(apiPath: string, params: Record<string, string>): string {
  const hash = createHash('sha256');
  hash.update(apiPath);
  for (const key of Object.keys(params).sort()) {
    if (SECRET_PARAM_KEYS.has(key)) continue;
    // Distinct delimiters prevent concatenation collisions ("ab"+"c" vs "a"+"bc").
    hash.update('\u0000');
    hash.update(key);
    hash.update('\u0001');
    hash.update(params[key] ?? '');
  }
  return hash.digest('hex');
}

export interface AlibabaClient {
  callApi(input: ApiCallInput): Promise<ApiCallResult>;
  /** Fingerprint of the last-built request params for the given input (no call). */
  fingerprintFor(input: Pick<ApiCallInput, 'apiPath' | 'params'>): string;
}

/**
 * Accept either a TOP dotted method (`alibaba.icbu.product.list`) or a legacy
 * slash path (`/alibaba/icbu/product/list`) and always emit the dotted form.
 * Callers were written against the old GOP paths; normalising here means a
 * missed call site fails loudly at review rather than quietly at the gateway.
 */
export function topMethodName(apiPathOrMethod: string): string {
  const trimmed = apiPathOrMethod.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  return trimmed.replace(/^\/+/, '').replace(/\//g, '.');
}

export function createAlibabaClient(config: AlibabaClientConfig): AlibabaClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = config.now ?? Date.now;

  /**
   * TOP request construction. Every call — token exchange and business API
   * alike — is a form POST to ONE router URL; the operation is carried by the
   * signed `method` parameter, never by the path.
   *
   * `apiPath` on the input is therefore a METHOD NAME. Legacy slash forms are
   * normalised so a stale caller cannot silently send `/alibaba/icbu/...` as a
   * method and get an unhelpful gateway error.
   */
  const buildParams = (input: ApiCallInput): Record<string, string> => {
    const params: Record<string, string> = {
      ...input.params,
      method: topMethodName(input.apiPath),
      app_key: config.appKey,
      timestamp: topTimestamp(now()),
      format: 'json',
      v: '2.0',
      sign_method: 'hmac',
    };
    // TOP carries the user token as `session`, NOT `access_token`.
    if (input.accessToken !== undefined) params.session = input.accessToken;
    params.sign = signTopRequest({ params, appSecret: config.appSecret });
    return params;
  };

  const attemptOnce = async (
    input: ApiCallInput,
    params: Record<string, string>,
  ): Promise<ApiCallResult> => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Single router endpoint — no path concatenation.
      const response = await fetchImpl(config.endpoints.apiBaseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal,
        redirect: 'error',
      });
      const bodyText = await response.text();
      if (bodyText.length > MAX_BODY_BYTES) {
        return {
          ok: false,
          kind: 'body-too-large',
          status: response.status,
          error: `response for ${input.apiPath} exceeded ${MAX_BODY_BYTES} bytes`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          kind: 'http',
          status: response.status,
          error: `HTTP ${response.status} from ${input.apiPath}`,
          bodyText,
        };
      }
      return { ok: true, status: response.status, bodyText };
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        ok: false,
        kind: aborted ? 'timeout' : 'network',
        error: aborted
          ? `timeout after ${timeoutMs}ms calling ${input.apiPath}`
          : `network failure calling ${input.apiPath}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const retryable = (result: ApiCallResult): boolean => {
    if (result.ok) return false;
    if (result.kind === 'network' || result.kind === 'timeout') return true;
    return result.kind === 'http' && (result.status === 429 || (result.status ?? 0) >= 500);
  };

  return {
    fingerprintFor(input) {
      return fingerprintRequest(input.apiPath, input.params ?? {});
    },
    async callApi(input) {
      const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      let last: ApiCallResult = {
        ok: false,
        kind: 'network',
        error: `no attempt made for ${input.apiPath}`,
      };
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // Re-sign each attempt so the timestamp stays fresh.
        last = await attemptOnce(input, buildParams(input));
        if (!retryable(last) || attempt === maxAttempts) return last;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
      return last;
    },
  };
}
