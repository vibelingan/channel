import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGithubReadClient } from '../release/github-read.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
const endpoint = 'https://blog-pages-298020-11-1443560658.sh.run.tcloudbase.com/blog/health.json';
/** The preparation installs the same application version as the staged Blog, independently of the tool's commit. */
export async function readBlogRuntimeSource(request = fetchFully) {
  const response = await request('GET', endpoint, {
    redirect: 'error',
    timeoutMs: 30000,
    maxBytes: 32768,
  });
  const health = JSON.parse(response.body.toString());
  if (
    response.status !== 200 ||
    health.service !== 'blog-pages' ||
    health.status !== 'ok' ||
    health.siteOrigin !== 'https://supplychainsai.com' ||
    !/^[a-f0-9]{40}$/.test(health.releaseId ?? '') ||
    response.headers.get('x-channel-blog-version') !== health.releaseId
  )
    throw Error('The actual staged Blog source must be confirmed before API preparation');
  return health.releaseId;
}
export async function selectBlogApiSource(
  env,
  { verify, readSource = readBlogRuntimeSource } = {},
) {
  const policy = assertBlogBootstrapInvocation(env);
  if (!env.GITHUB_OUTPUT || !env.GITHUB_TOKEN) throw Error('Authenticated Actions output required');
  const requireCI = verify ?? createGithubReadClient({ policy, token: env.GITHUB_TOKEN }).requireCI;
  await requireCI(env.GITHUB_SHA);
  const codeSha = await readSource();
  if (!/^[a-f0-9]{40}$/.test(codeSha ?? '')) throw Error('Exact staged source SHA required');
  await requireCI(codeSha);
  return codeSha;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const codeSha = await selectBlogApiSource(process.env);
  appendFileSync(process.env.GITHUB_OUTPUT, `code_sha=${codeSha}\n`);
  console.log(
    'The operation tool and the staged application source both passed the original SEO CI.',
  );
}
