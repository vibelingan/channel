/**
 * CloudBase cloud function entrypoint for the admin API.
 *
 * Wires the wx-server-sdk adapter, then delegates every request to the shared,
 * adapter-agnostic `handleAdminRequest`.
 */
import { setAdapter } from '@vibelingan-channel/db';
import { readArticleQueueStatus } from '@vibelingan-channel/db/article-release-source';
import { createCloudBaseArticleRepository } from '@vibelingan-channel/db/article-repository';
import { createCatalogPreparationAuthority } from '@vibelingan-channel/db/catalog-preparation-authority';
import { cloudBaseAdapter, cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { optionalEnv, requireEnv } from '@vibelingan-channel/shared';
import { createCatalogPreparationInvoker } from './catalog-preparation-invoker.ts';
import { handleAdminRequest } from './handler.ts';
import {
  type AdminHttpConfig,
  handleAdminFunctionEvent,
  parseAllowedOrigins,
} from './http-adapter.ts';

initCloudBase(requireEnv('TCB_ENV'));
setAdapter(cloudBaseAdapter);
setMediaStorage(createCloudBaseMediaStorage(cloudStorageSdk()));

const config: AdminHttpConfig = {
  jwtSecret: requireEnv('JWT_SECRET'),
  enableArticleReleases: optionalEnv('ARTICLE_PUBLISHING_ENABLED') === '1',
  articleQueueStatusKeyHash: optionalEnv('BLOG_QUEUE_STATUS_KEY_HASH'),
  articleQueueStatus: () => readArticleQueueStatus(cloudStorageSdk().database()),
  articleRepository: createCloudBaseArticleRepository(cloudStorageSdk().database()),
  preparationAuthority: createCatalogPreparationAuthority({
    secret: requireEnv('JWT_SECRET'),
    environmentId: requireEnv('TCB_ENV'),
  }),
  preparationInvoke: createCatalogPreparationInvoker(cloudStorageSdk()),
  enableInquiries: optionalEnv('CATALOG_RFQ_ENABLED') === '1',
  enableDetailApproval: optionalEnv('CATALOG_DETAIL_APPROVAL_ENABLED') === '1',
  ...(optionalEnv('LOGIN_URL') ? { loginUrl: optionalEnv('LOGIN_URL') } : {}),
  ...(optionalEnv('RESET_PASSWORD_URL')
    ? { resetPasswordUrl: optionalEnv('RESET_PASSWORD_URL') }
    : {}),
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
