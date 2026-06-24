/**
 * CloudBase cloud function entrypoint for the admin API.
 *
 * Wires the wx-server-sdk adapter, then delegates every request to the shared,
 * adapter-agnostic `handleAdminRequest`.
 */
import { setAdapter } from '@vibelingan-channel/db';
import { cloudBaseAdapter, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { optionalEnv, requireEnv } from '@vibelingan-channel/shared';
import { handleAdminRequest } from './handler.ts';
import {
  type AdminHttpConfig,
  handleAdminFunctionEvent,
  parseAllowedOrigins,
} from './http-adapter.ts';

initCloudBase(requireEnv('TCB_ENV'));
setAdapter(cloudBaseAdapter);

const config: AdminHttpConfig = {
  jwtSecret: requireEnv('JWT_SECRET'),
  ...(optionalEnv('LOGIN_URL') ? { loginUrl: optionalEnv('LOGIN_URL') } : {}),
  bootstrap: {
    enabled: optionalEnv('BOOTSTRAP_ENABLED') === '1',
    adminToken: optionalEnv('BOOTSTRAP_ADMIN_TOKEN'),
    adminEmail: optionalEnv('ADMIN_EMAIL'),
    adminPasswordHash: optionalEnv('ADMIN_PASSWORD_HASH'),
  },
  ...(optionalEnv('CORS_ALLOWED_ORIGINS')
    ? { corsAllowedOrigins: parseAllowedOrigins(optionalEnv('CORS_ALLOWED_ORIGINS')) }
    : {}),
};

export const main = async (event: unknown): Promise<unknown> => {
  return handleAdminFunctionEvent(event, config, handleAdminRequest);
};
