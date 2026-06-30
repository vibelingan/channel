/**
 * CloudBase cloud function entrypoint for the public storefront API.
 *
 * This is an Event-style function returning an HTTP response envelope. HTTP
 * Access / gateway routing is configured later in P0.9.
 */
import { setAdapter } from '@vibelingan-channel/db';
import { cloudBaseAdapter, cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { optionalEnv, requireEnv } from '@vibelingan-channel/shared';
import {
  type PublicHttpConfig,
  handlePublicApiEvent,
  parseAllowedOrigins,
} from './http-adapter.ts';

initCloudBase(requireEnv('TCB_ENV'));
setAdapter(cloudBaseAdapter);
setMediaStorage(createCloudBaseMediaStorage(cloudStorageSdk()));

const config: PublicHttpConfig = {
  ...(optionalEnv('PUBLIC_API_BASE_URL') ? { apiBaseUrl: optionalEnv('PUBLIC_API_BASE_URL') } : {}),
  ...(optionalEnv('CORS_ALLOWED_ORIGINS')
    ? { corsAllowedOrigins: parseAllowedOrigins(optionalEnv('CORS_ALLOWED_ORIGINS')) }
    : {}),
};

export const main = async (event: unknown): Promise<unknown> => {
  return handlePublicApiEvent(event, config);
};
