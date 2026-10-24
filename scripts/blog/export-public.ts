import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeBlogArticleAssets } from '../../packages/db/src/article-build-assets.ts';
import { readAcceptedArticles } from '../../packages/db/src/article-release-source.ts';
import { blogWorkerSdk } from './worker-source.ts';

const directory = resolve(process.argv[2] ?? '');
const envId = process.env.TCB_ENV_ID;
const siteOrigin = process.env.SITE_URL;
if (
  !process.argv[2] ||
  envId !== 'diversity-123-d9grnqfux221323bb' ||
  siteOrigin !== 'https://supplychainsai.com'
)
  throw new Error('Explicit formal Blog export target and output required');
if (!process.env.TENCENTCLOUD_SECRETID || !process.env.TENCENTCLOUD_SECRETKEY)
  throw new Error('Read-capable server credentials required');
const sdk = blogWorkerSdk({
  env: envId,
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY,
  region: 'ap-shanghai',
});
const db = sdk.database();
const articles = await readAcceptedArticles(db);
await mkdir(directory, { recursive: true });
await writeBlogArticleAssets({
  db,
  sdk,
  articles,
  directory,
  assertFileId(id) {
    if (!id.startsWith(`cloud://${envId}.`) || !/\/articles\/[A-Za-z0-9/_-]+\.[a-z]+$/.test(id))
      throw new Error('Article image escaped the formal storage prefix');
  },
});
await writeFile(
  resolve(directory, 'snapshot.json'),
  JSON.stringify({
    schemaVersion: 1,
    purpose: 'public',
    siteOrigin,
    total: articles.length,
    articles,
  }),
  { flag: 'wx', mode: 0o600 },
);
console.log(`Exported ${articles.length} accepted articles with verified public image bytes.`);
