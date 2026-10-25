import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGithubReadClient } from '../release/github-read.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { checkBlogServerPackage } from './server-package-check.mjs';
import { submitBlogServer } from './server-stage.mjs';

const envId = 'diversity-123-d9grnqfux221323bb';
const siteOrigin = 'https://supplychainsai.com';
const serverName = 'blog-pages';
if (
  process.env.BLOG_SERVER_STAGE_CONFIRM !== 'ISOLATED_BLOG_PAGES_ONLY' ||
  process.env.GITHUB_REPOSITORY !== 'vibelingan/channel' ||
  process.env.GITHUB_REF !== 'refs/heads/feat/seo-foundation' ||
  process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
  !process.env.GITHUB_TOKEN
)
  throw Error('The reviewed manual SEO entry and existing credentials are required');
const codeSha = process.env.GITHUB_SHA;
const directory = resolve('output/blog-server-package');
const manifest = await checkBlogServerPackage(directory, { codeSha, siteOrigin });
await createGithubReadClient({
  token: process.env.GITHUB_TOKEN,
  policy: {
    repository: 'vibelingan/channel',
    trustedRef: 'refs/heads/feat/seo-foundation',
  },
}).requireCI(codeSha);
await mkdir('output/blog-server-stage', { recursive: true });
const record = {
  envId,
  serverName,
  codeSha,
  siteOrigin,
  packageBytes: manifest.totalBytes,
  scope: 'new Blog service only; no website route, function, database or storage writes',
  startedAt: new Date().toISOString(),
  status: 'not-written',
};
const save = () =>
  writeFile('output/blog-server-stage/result.json', `${JSON.stringify(record, null, 2)}\n`);
await save();
const client = await connectBlogMcp();
try {
  await submitBlogServer({ client, directory, record, save });
} finally {
  await client.close();
}
