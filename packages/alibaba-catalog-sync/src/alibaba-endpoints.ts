/**
 * Alibaba.com Open Platform endpoint configuration (ARCHITECTURE §8.2).
 *
 * Platform variant is PINNED: Alibaba.com International Station Open Platform
 * (open.alibaba.com) — established by the verified 2026-07-28 research in
 * docs/accio-alibaba-integration/REPORT.md. The default base URLs below are
 * the documented GOP hosts but are ASSUMED-UNVERIFIED against the live
 * gateway (official docs were unreachable at revision time); they are
 * overridable via env exactly so a wrong default cannot strand a deployed
 * test environment, and live verification is a mandatory MIU 15 smoke gate.
 *
 * Overrides are constrained to HTTPS on *.alibaba.com so a mis-set env var
 * can never redirect token exchange off-platform.
 */

export interface AlibabaEndpoints {
  /** OAuth authorize page the merchant's browser is sent to. */
  authorizeBaseUrl: string;
  /** Signed REST gateway base (system + business APIs). */
  apiBaseUrl: string;
  /** System API path for authorization-code token exchange. */
  tokenCreatePath: string;
  /** System API path for refresh-token exchange. */
  tokenRefreshPath: string;
}

export const DEFAULT_ALIBABA_ENDPOINTS: AlibabaEndpoints = {
  // Alibaba.com Open Platform — host CONFIRMED by Alibaba support on
  // 2026-08-16 and verified live the same day.
  //
  // `oauth.alibaba.com` is the OLD domain. It still answers, and it still
  // redirects to a login page, which is exactly why this took so long to find:
  // the flow looked healthy right up until the authenticated merchant was told
  // `param-appkey.not.exists`. The key was never missing — it lives in the
  // NEW platform's registry and the old host cannot see it.
  //
  // Proof (no credentials needed, reproducible):
  //   open-api.alibaba.com  + app_key 511630   -> IncompleteSignature  (key KNOWN)
  //   open-api.alibaba.com  + app_key 999999999 -> InvalidAppKey       (control)
  // Reaching signature validation means the key resolved.
  //
  // Note the hostname carefully: `open-api` with a hyphen. An earlier probe
  // used `openapi-api.alibaba.com`, which is a DIFFERENT host and answers
  // InvalidAppKey for everything — that false negative is what made the key
  // look unprovisioned.
  //
  // Docs: https://open.alibaba.com/doc/doc.htm?docId=72
  authorizeBaseUrl: 'https://open-api.alibaba.com/oauth/authorize',
  apiBaseUrl: 'https://open-api.alibaba.com/rest',
  tokenCreatePath: '/auth/token/create',
  tokenRefreshPath: '/auth/token/refresh',
};

export type EndpointResolution =
  | { ok: true; endpoints: AlibabaEndpoints }
  | { ok: false; error: string };

function validOverride(name: string, raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${name} is not a valid URL`;
  }
  if (url.protocol !== 'https:') return `${name} must use https`;
  const host = url.hostname;
  if (host !== 'alibaba.com' && !host.endsWith('.alibaba.com')) {
    return `${name} must point at an *.alibaba.com host`;
  }
  return undefined;
}

/**
 * Resolve endpoints from env, applying guarded overrides.
 * Reads ALI_AUTHORIZE_BASE_URL and ALI_API_BASE_URL when present.
 */
export function resolveAlibabaEndpoints(
  env: Record<string, string | undefined>,
): EndpointResolution {
  const endpoints = { ...DEFAULT_ALIBABA_ENDPOINTS };
  const authorize = env.ALI_AUTHORIZE_BASE_URL;
  if (authorize) {
    const problem = validOverride('ALI_AUTHORIZE_BASE_URL', authorize);
    if (problem) return { ok: false, error: problem };
    endpoints.authorizeBaseUrl = authorize;
  }
  const api = env.ALI_API_BASE_URL;
  if (api) {
    const problem = validOverride('ALI_API_BASE_URL', api);
    if (problem) return { ok: false, error: problem };
    endpoints.apiBaseUrl = api.replace(/\/$/, '');
  }
  return { ok: true, endpoints };
}

/** Build the browser-facing authorize URL for the OAuth start action. */
export function buildAuthorizeUrl(
  endpoints: AlibabaEndpoints,
  input: { appKey: string; redirectUri: string; state: string },
): string {
  const url = new URL(endpoints.authorizeBaseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.appKey);
  url.searchParams.set('redirect_uri', input.redirectUri);
  // Exactly the parameter set Alibaba support supplied on 2026-08-16:
  // response_type, client_id, redirect_uri, sp=icbu — plus our single-use
  // `state`, which the platform echoes back to the callback.
  //
  // `view=web` was dropped: it is not in support's link, and both forms
  // return 200 on the new host, so the smaller surface wins.
  //
  // The uppercase/lowercase `sp` question is settled and was never the real
  // problem — `param-appkey.not.exists` came from the OLD authorize host,
  // which cannot see this app key at all.
  url.searchParams.set('state', input.state);
  url.searchParams.set('sp', 'icbu');
  return url.toString();
}
