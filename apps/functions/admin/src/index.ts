/**
 * CloudBase cloud function entrypoint for the admin API.
 *
 * Wires the wx-server-sdk adapter, then delegates every request to the shared,
 * adapter-agnostic `handleAdminRequest`.
 */
import { setAdapter } from '@vibelingan-channel/db';
import { cloudBaseAdapter, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { optionalEnv, requireEnv } from '@vibelingan-channel/shared';
import { type AdminConfig, type AdminRequest, handleAdminRequest } from './handler.ts';

initCloudBase(requireEnv('TCB_ENV'));
setAdapter(cloudBaseAdapter);

const config: AdminConfig = {
  jwtSecret: requireEnv('JWT_SECRET'),
  ...(optionalEnv('LOGIN_URL') ? { loginUrl: optionalEnv('LOGIN_URL') } : {}),
};

export const main = async (event: AdminRequest): Promise<unknown> => {
  return handleAdminRequest(event ?? { action: '' }, config);
};
