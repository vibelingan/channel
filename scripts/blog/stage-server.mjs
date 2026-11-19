import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import { createGithubReadClient } from '../release/github-read.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { connectBlogMcp } from './mcp-client.mjs';
import { selectBlogTransitionProgram } from './prepare-asset-transition.mjs';
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
const operation = process.env.BLOG_SERVER_STAGE_OPERATION ?? 'create';
if (!['create', 'update'].includes(operation)) throw Error('Explicit Blog operation required');
const directory = resolve('output/blog-server-package');
const manifest = await checkBlogServerPackage(directory, { codeSha, siteOrigin });
const currentSha = process.env.BLOG_SERVER_CURRENT_SHA;
if (operation === 'update' && !/^[a-f0-9]{40}$/.test(currentSha ?? ''))
  throw Error('The running Blog release must be identified before an update');
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
  scope: 'Blog program only; no website route, function, database or storage writes',
  operation,
  startedAt: new Date().toISOString(),
  status: 'not-written',
};
const save = () =>
  writeFile('output/blog-server-stage/result.json', `${JSON.stringify(record, null, 2)}\n`);
await save();
const tracePath = resolve('output/blog-server-stage/provider-http.jsonl');
await writeFile(tracePath, '', { flag: 'wx', mode: 0o600 });
const client = await connectBlogMcp({ tracePath });
try {
  await submitBlogServer({
    client,
    directory,
    record,
    save,
    operation,
    prepareUpdate:
      operation === 'update'
        ? async () => {
            const selected = await selectBlogTransitionProgram({
              current: { directory: resolve('output/blog-server-current'), codeSha: currentSha },
              candidate: { directory, codeSha },
              destination: resolve('output/blog-server-transition'),
              siteOrigin,
            });
            const response = await fetchFully('GET', `${siteOrigin}/blog/health.json`, {
              maxBytes: 16384,
              redirect: 'error',
            });
            const health = JSON.parse(response.body.toString());
            if (
              response.status !== 200 ||
              health.service !== serverName ||
              health.releaseId !== currentSha ||
              health.siteOrigin !== siteOrigin
            )
              throw Error('The running Blog program changed during the asset check');
            const selectedSha = selected.phase === 'preload' ? currentSha : codeSha;
            const verified = await checkBlogServerPackage(selected.directory, {
              codeSha: selectedSha,
              siteOrigin,
            });
            record.packageBytes = verified.totalBytes;
            record.submittedCodeSha = selectedSha;
            return selected;
          }
        : undefined,
    archiveBefore: async () => {
      const result = await new DefaultArtifactClient().uploadArtifact(
        `blog-server-before-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
        [resolve('output/blog-server-stage/result.json')],
        resolve('output/blog-server-stage'),
        { retentionDays: 90 },
      );
      if (!result.id || !result.digest) throw Error('Old Blog image archive not confirmed');
      return { artifactId: String(result.id), sha256: result.digest };
    },
  });
} finally {
  await client.close();
}
