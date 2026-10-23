import { cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { requireEnv } from '@vibelingan-channel/shared';
import { createBlogDummyHandler } from './blog-dummy-handler.ts';
import { createBlogDummyStorage } from './blog-dummy-storage.ts';
const envId = requireEnv('TCB_ENV');
if (envId !== 'diversity-123-d9grnqfux221323bb' || requireEnv('BLOG_DUMMY_ENABLED') !== '1')
  throw new Error('Isolated Blog test target is not enabled');
const expiresAt = Date.parse(requireEnv('BLOG_DUMMY_EXPIRES_AT'));
if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 24 * 3600_000)
  throw new Error('Dummy test window must expire within 24 hours');
initCloudBase(envId);
const codeSha = process.env.CHANNEL_BUILD_SHA ?? '';
if (codeSha !== requireEnv('BLOG_DUMMY_EXPECTED_CODE_SHA'))
  throw new Error('Compiled dummy code identity differs from the deployed configuration');
const sdk = cloudStorageSdk();
setMediaStorage(createBlogDummyStorage(sdk, envId));
export const main = createBlogDummyHandler({
  db: sdk.database(),
  envId,
  codeSha,
  jwtSecret: requireEnv('BLOG_DUMMY_JWT_SECRET'),
  expiresAt,
});
