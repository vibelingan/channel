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
  // CONFIRMED from the official seller-authorization docs (2026-08-06): the
  // Alibaba.com (ICBU) authorize page is oauth.alibaba.com/authorize with
  // sp=icbu — LOWERCASE, corrected 2026-08-07 after the live gateway answered
  // `param-appkey.not.exists` to the uppercase variant (see ARCHITECTURE §8
  // amendment). The /rest gateway host below matches the GOP family convention
  // but remains ASSUMED-UNVERIFIED until the MIU 15 live smoke — hence the
  // env override.
  authorizeBaseUrl: 'https://oauth.alibaba.com/authorize',
  apiBaseUrl: 'https://openapi-api.alibaba.com/rest',
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
  // Minimal official ICBU parameter set (corrected 2026-08-07): lowercase
  // `sp=icbu`, lowercase `state` only, and NO `force_auth`. The uppercase
  // `sp=ICBU` + `force_auth` + dual-casing `state`/`State` variant was
  // answered by the live gateway with `param-appkey.not.exists` — the
  // platform selector routes to the authorization registry, and the
  // non-documented shape landed in one that does not know this app key.
  url.searchParams.set('state', input.state);
  url.searchParams.set('sp', 'icbu');
  url.searchParams.set('view', 'web');
  return url.toString();
}
