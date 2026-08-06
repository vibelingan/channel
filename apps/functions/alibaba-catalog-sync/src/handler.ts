import { createAlibabaClient } from '@vibelingan-channel/alibaba-catalog-sync';
/**
 * Action handler for the alibaba-catalog-sync function (MIU 5 surface).
 *
 * POST actions (admin-authenticated, Bearer/JSON — never cookies): oauthStart,
 * connectionStatus, disconnect. The OAuth callback arrives as a GET routed by
 * the HTTP adapter (unauthenticated, state-bound, rate-limited). Later MIUs
 * add run controls, linking, and quarantine actions here.
 *
 * Authorization: every connection-lifecycle action requires the LIVE users
 * row to carry role 'admin' (NOT canAccessAdmin — contributors must not
 * manage the merchant credential; R1 L6).
 */
import { verifySession } from '@vibelingan-channel/auth/jwt';
import { type ApiResult, err, ok, toRole } from '@vibelingan-channel/shared';
import { z } from 'zod';
import { type AlertSender, createAlertSender } from './alerts.ts';
import { type AlibabaSyncFunctionConfig, resolveOAuthConfig } from './config.ts';

export type { AlibabaSyncFunctionConfig } from './config.ts';
import {
  type OAuthDeps,
  connectionStatusView,
  disconnectConnection,
  handleOAuthCallback,
  startOAuth,
} from './oauth.ts';
import { enforceOAuthRateLimit, hashSourceIp } from './rate-limit.ts';
import { getDoc } from './repo.ts';

export interface AlibabaSyncRequest {
  action?: unknown;
  token?: unknown;
  data?: unknown;
}

export interface RequestContext {
  sourceIp?: string;
}

const requestSchema = z.object({
  action: z.string().min(1),
  token: z.string().optional(),
  data: z.unknown().optional(),
});

interface AdminIdentity {
  userId: string;
}

async function requireLiveAdmin(
  config: AlibabaSyncFunctionConfig,
  token: unknown,
): Promise<ApiResult<AdminIdentity>> {
  if (typeof token !== 'string' || token.length === 0) {
    return err('UNAUTHORIZED', 'Sign in required.');
  }
  const claims = await verifySession(config.jwtSecret, token);
  if (!claims) return err('UNAUTHORIZED', 'Session is invalid or expired.');
  const user = await getDoc('users', claims.sub);
  if (!user || user.status === 'suspended') {
    return err('UNAUTHORIZED', 'Session is invalid or expired.');
  }
  if (toRole(user.role) !== 'admin') {
    return err('FORBIDDEN', 'Managing the Alibaba connection requires the admin role.');
  }
  return ok({ userId: claims.sub });
}

export interface OAuthRuntime {
  deps: OAuthDeps;
}

export type RuntimeResolution =
  | { ok: true; runtime: OAuthRuntime }
  | { ok: false; missing: string[] };

/** Build the OAuth runtime lazily; unconfigured environments report what is missing. */
export function resolveRuntime(
  config: AlibabaSyncFunctionConfig,
  overrides?: { fetchImpl?: typeof fetch; now?: () => string; alert?: AlertSender },
): RuntimeResolution {
  const resolved = resolveOAuthConfig(config);
  if (!resolved.ok) return { ok: false, missing: resolved.missing };
  const nowIso = overrides?.now ?? (() => new Date().toISOString());
  const client = createAlibabaClient({
    appKey: resolved.config.appKey,
    appSecret: resolved.config.appSecret,
    endpoints: resolved.config.endpoints,
    ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    now: () => Date.parse(nowIso()),
  });
  const alert =
    overrides?.alert ?? createAlertSender(config.wecomWebhookUrl, overrides?.fetchImpl ?? fetch);
  return {
    ok: true,
    runtime: {
      deps: {
        client,
        endpoints: resolved.config.endpoints,
        appKey: resolved.config.appKey,
        callbackUrl: resolved.config.callbackUrl,
        tokenKey: resolved.config.tokenKey,
        now: nowIso,
        alert,
      },
    },
  };
}

const NOT_CONFIGURED_MESSAGE =
  'The Alibaba connection is not configured in this environment. Missing: ';

export async function handleAlibabaSyncRequest(
  request: AlibabaSyncRequest,
  config: AlibabaSyncFunctionConfig,
  _context: RequestContext = {},
  runtimeOverrides?: Parameters<typeof resolveRuntime>[1],
): Promise<ApiResult<unknown>> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return err('BAD_REQUEST', 'Malformed request envelope.');
  const { action, token } = parsed.data;

  switch (action) {
    case 'oauthStart': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const runtime = resolveRuntime(config, runtimeOverrides);
      if (!runtime.ok) {
        return err('CONFLICT', NOT_CONFIGURED_MESSAGE + runtime.missing.join(', '));
      }
      const started = await startOAuth(runtime.runtime.deps, admin.data.userId);
      if (!started.ok) return err('INTERNAL_ERROR', 'Could not start the authorization flow.');
      return ok({ authorizeUrl: started.authorizeUrl });
    }
    case 'connectionStatus': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const runtime = resolveRuntime(config, runtimeOverrides);
      const view = await connectionStatusView();
      return ok({
        ...view,
        notConfigured: runtime.ok ? false : true,
        ...(runtime.ok ? {} : { missing: runtime.missing }),
      });
    }
    case 'disconnect': {
      const admin = await requireLiveAdmin(config, token);
      if (!admin.ok) return admin;
      const existed = await disconnectConnection({ now: () => new Date().toISOString() });
      return ok({ disconnected: existed });
    }
    default:
      return err('BAD_REQUEST', `Unknown action: ${action}`);
  }
}

export type CallbackRedirect = { location: string };

/**
 * GET /oauth/callback — unauthenticated, state-bound, rate-limited. Always
 * finishes with a redirect to the site-origin admin page carrying a coarse
 * status code (never error details, never token material).
 */
export async function handleOAuthCallbackRequest(
  query: { code?: string; state?: string },
  config: AlibabaSyncFunctionConfig,
  context: RequestContext = {},
  runtimeOverrides?: Parameters<typeof resolveRuntime>[1],
): Promise<CallbackRedirect> {
  const site = (config.siteUrl ?? '').replace(/\/$/, '');
  const target = (status: string) => ({ location: `${site}/admin?alibaba=${status}` });

  const nowMs = runtimeOverrides?.now ? Date.parse(runtimeOverrides.now()) : Date.now();
  const denied = await enforceOAuthRateLimit({
    scope: 'alibabaOauthCallback',
    sourceHash: hashSourceIp(context.sourceIp),
    nowMs,
  }).catch((e) => {
    // Ledger failure fails CLOSED for an unauthenticated endpoint.
    console.error('[alibaba-catalog-sync] callback rate-limit check failed:', e);
    return { denied: true as const, retryAfterSeconds: 60 };
  });
  if (denied) return target('rate-limited');

  const runtime = resolveRuntime(config, runtimeOverrides);
  if (!runtime.ok) return target('not-configured');
  const outcome = await handleOAuthCallback(runtime.runtime.deps, query.code, query.state);
  if (outcome.ok) return target('connected');
  return target(`error-${outcome.reason}`);
}
