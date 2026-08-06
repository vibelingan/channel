/**
 * CloudBase cloud function entrypoint for alibaba-catalog-sync.
 *
 * Shared env (TCB_ENV, JWT_SECRET) is required at wiring time like the
 * existing functions; every ALI_* /WECOM_* var is optional — cold start and
 * /health never depend on them (ARCHITECTURE §8, R1 L12: the artifact smoke
 * boots every function with stub env only).
 */
import { setAdapter } from '@vibelingan-channel/db';
import { cloudBaseAdapter, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { optionalEnv, requireEnv } from '@vibelingan-channel/shared';
import type { AlibabaSyncFunctionConfig } from './config.ts';
import { handleAlibabaSyncFunctionEvent, parseAllowedOrigins } from './http-adapter.ts';

initCloudBase(requireEnv('TCB_ENV'));
setAdapter(cloudBaseAdapter);

const config: AlibabaSyncFunctionConfig = {
  jwtSecret: requireEnv('JWT_SECRET'),
  ...(optionalEnv('CORS_ALLOWED_ORIGINS')
    ? { corsAllowedOrigins: parseAllowedOrigins(optionalEnv('CORS_ALLOWED_ORIGINS') as string) }
    : {}),
  ...(optionalEnv('SITE_URL') ? { siteUrl: optionalEnv('SITE_URL') as string } : {}),
  ...(optionalEnv('ALI_APP_KEY') ? { appKey: optionalEnv('ALI_APP_KEY') as string } : {}),
  ...(optionalEnv('ALI_APP_SECRET') ? { appSecret: optionalEnv('ALI_APP_SECRET') as string } : {}),
  ...(optionalEnv('ALI_OAUTH_CALLBACK_URL')
    ? { callbackUrl: optionalEnv('ALI_OAUTH_CALLBACK_URL') as string }
    : {}),
  ...(optionalEnv('ALI_TOKEN_ENCRYPTION_KEY_V1')
    ? { tokenKeyHex: optionalEnv('ALI_TOKEN_ENCRYPTION_KEY_V1') as string }
    : {}),
  ...(optionalEnv('WECOM_WEBHOOK_URL')
    ? { wecomWebhookUrl: optionalEnv('WECOM_WEBHOOK_URL') as string }
    : {}),
  endpointOverrides: {
    ...(optionalEnv('ALI_AUTHORIZE_BASE_URL')
      ? { ALI_AUTHORIZE_BASE_URL: optionalEnv('ALI_AUTHORIZE_BASE_URL') as string }
      : {}),
    ...(optionalEnv('ALI_API_BASE_URL')
      ? { ALI_API_BASE_URL: optionalEnv('ALI_API_BASE_URL') as string }
      : {}),
  },
};

export const main = async (event: unknown): Promise<unknown> => {
  return handleAlibabaSyncFunctionEvent(event, config);
};
