/** Explicit development entry: real CloudBase articles; no dummy function or cloud seed. */
import { createCloudBaseArticleRepository } from '@vibelingan-channel/db/article-repository';
import { cloudStorageSdk, initCloudBase } from '@vibelingan-channel/db/cloudbase';
import { setMediaStorage } from '@vibelingan-channel/media-storage';
import { createCloudBaseMediaStorage } from '@vibelingan-channel/media-storage/cloudbase';
import { requireEnv } from '@vibelingan-channel/shared';
import { createBlogDevelopmentApp } from './blog-development-app.ts';

if (requireEnv('BLOG_LOCAL_CLOUDBASE_CONFIRM') !== 'REAL_ARTICLE_DATA')
  throw new Error('Explicit real article data acknowledgement required.');
const envId = requireEnv('TCB_ENV');
requireEnv('TENCENTCLOUD_SECRETID');
requireEnv('TENCENTCLOUD_SECRETKEY');
requireEnv('TENCENTCLOUD_REGION');
const authUrl = new URL(requireEnv('BLOG_AUTH_API_URL'));
if (
  authUrl.protocol !== 'https:' ||
  authUrl.username ||
  authUrl.password ||
  authUrl.search ||
  authUrl.hash
)
  throw new Error('A fixed existing HTTPS admin API is required for real account authentication.');
initCloudBase(envId);
const sdk = cloudStorageSdk();
setMediaStorage(createCloudBaseMediaStorage(sdk));
const db = sdk.database();
const app = createBlogDevelopmentApp({
  repository: createCloudBaseArticleRepository(db),
  envId,
  frontendOrigin: requireEnv('BLOG_FRONTEND_ORIGIN'),
  auth: async (input) => {
    const result = await fetch(authUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const text = await result.text();
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new Error('Authentication response is too large.');
    return JSON.parse(text) as unknown;
  },
});
const port = Number(process.env.PORT ?? 3002);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid Blog development port.');
app.listen(port, '127.0.0.1', () =>
  console.log(
    `[blog-development] http://127.0.0.1:${port}; real CloudBase articles; website deployment disabled`,
  ),
);
