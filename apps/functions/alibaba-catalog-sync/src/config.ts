/**
 * Function configuration (ARCHITECTURE §8). Shared vars (TCB_ENV, JWT_SECRET,
 * CORS_ALLOWED_ORIGINS) are required at wiring time exactly like the existing
 * functions; every ALI_* /WECOM_* feature var is OPTIONAL — cold start and
 * /health never depend on them, and the OAuth surface fails closed to a
 * `not_configured` state instead (R1 L7/L12; artifact cold-start smoke runs
 * with stub env only).
 */
import {
  type AlibabaEndpoints,
  resolveAlibabaEndpoints,
} from '@vibelingan-channel/alibaba-catalog-sync';
import { parseTokenEncryptionKey } from './crypto.ts';

export interface AlibabaSyncFunctionConfig {
  jwtSecret: string;
  corsAllowedOrigins?: readonly string[];
  /** Site origin for the post-callback redirect (e.g. https://site-host). */
  siteUrl?: string;
  appKey?: string;
  appSecret?: string;
  callbackUrl?: string;
  tokenKeyHex?: string;
  wecomWebhookUrl?: string;
  endpointOverrides?: Record<string, string | undefined>;
}

export interface ResolvedOAuthConfig {
  appKey: string;
  appSecret: string;
  callbackUrl: string;
  tokenKey: Buffer;
  endpoints: AlibabaEndpoints;
}

export type OAuthConfigResolution =
  | { ok: true; config: ResolvedOAuthConfig }
  | { ok: false; missing: string[] };

/** Lazily resolve the OAuth-capable configuration; lists what is missing. */
export function resolveOAuthConfig(config: AlibabaSyncFunctionConfig): OAuthConfigResolution {
  const missing: string[] = [];
  if (!config.appKey) missing.push('ALI_APP_KEY');
  if (!config.appSecret) missing.push('ALI_APP_SECRET');
  if (!config.callbackUrl) missing.push('ALI_OAUTH_CALLBACK_URL');
  const tokenKey = parseTokenEncryptionKey(config.tokenKeyHex);
  if (!tokenKey) missing.push('ALI_TOKEN_ENCRYPTION_KEY_V1');
  const endpoints = resolveAlibabaEndpoints(config.endpointOverrides ?? {});
  if (!endpoints.ok) missing.push(`endpoint override invalid: ${endpoints.error}`);
  if (missing.length > 0 || !endpoints.ok || !tokenKey) return { ok: false, missing };
  return {
    ok: true,
    config: {
      appKey: config.appKey as string,
      appSecret: config.appSecret as string,
      callbackUrl: config.callbackUrl as string,
      tokenKey,
      endpoints: endpoints.endpoints,
    },
  };
}
