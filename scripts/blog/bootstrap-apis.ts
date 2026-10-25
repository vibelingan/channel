/** Controlled code expansion only. Publishing/read switches and website routes stay unchanged. */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { readArticleQueueStatus } from '../../packages/db/src/article-release-source.ts';
import { captureFunctionBackups } from '../capture-function-backups.mjs';
import { checkFunctionArchive } from '../release/function-archive.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { createGithubReadClient } from '../release/github-read.mjs';
import { identity } from '../release/input.mjs';
import { replaceBlogFunctionCode } from './bootstrap-delivery.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { readBlogRuntimeSource } from './check-api-source.mjs';
import { ensureFormalArticleResources } from './resources.mjs';
import { readFunctionRuntimeVersion } from './runtime-health.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
import { blogWorkerSdk } from './worker-source.ts';

const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
if (
  env.BLOG_SERVER_API_CONFIRM !== 'CODE_ONLY_NO_FLAGS' ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN
)
  throw Error('Reviewed code-only API preparation required');
const executorSha = env.GITHUB_SHA ?? '';
const codeSha = env.BLOG_SERVER_API_SOURCE_SHA ?? '';
if ((await readBlogRuntimeSource()) !== codeSha)
  throw Error('Staged Blog changed before API preparation');
const github = createGithubReadClient({ policy, token: env.GITHUB_TOKEN });
await github.requireCI(executorSha);
await github.requireCI(codeSha);
const config = {
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
};
const manager = new CloudBase(config);
const sdk = blogWorkerSdk({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const queue = await readArticleQueueStatus(sdk.database());
if (queue.hasQueued || queue.hasUnknown)
  throw Error('Resolve existing article work before changing the delivery implementation');
const names = ['admin', 'public-api'] as const;
const target = { envId: policy.envId, siteOrigin: policy.siteOrigin };
const provider = createCloudbaseFunctionProvider({
  manager,
  target,
  region: policy.region,
  names: [...names],
  configurationKey: createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
    .update(`channel-function-observation:v1:${identity(target)}`)
    .digest(),
});
const output = resolve('output/blog-server-apis');
await mkdir(output, { recursive: true });
const baseline = await readBlogSiteBaseline();
const versions = Object.fromEntries(
  await Promise.all(
    names.map(async (name) => [name, await readFunctionRuntimeVersion(policy.envId, name)]),
  ),
);
const captured = await captureFunctionBackups({
  provider,
  names: [...names],
  output: join(output, 'before'),
});
const artifactFiles = [join(output, 'before/function-backups.json')];
const candidates = new Map<string, Buffer>();
for (const name of names) {
  const before = captured.entries.find((entry) => entry.snapshot.name === name)?.snapshot;
  if (
    !before ||
    before.runtime !== 'Nodejs20.19' ||
    before.handler !== 'index.main' ||
    before.triggerCount !== 0
  )
    throw Error('An API differs from its reviewed runtime and handler');
  const zip = join(output, `${name}-candidate.zip`);
  execFileSync(
    'python3',
    [
      '-c',
      `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'x',compression=zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_symlink(): raise RuntimeError('Unexpected function symlink')
  if p.is_file(): z.write(p,p.relative_to(root))
`,
      resolve('blog-runtime-source/.cloudbase-artifacts/functions', name),
      zip,
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
  const bytes = await readFile(zip);
  checkFunctionArchive(bytes, { smoke: true });
  candidates.set(name, bytes);
  artifactFiles.push(zip, join(output, `before/${name}.zip`));
}
await writeFile(
  join(output, 'before/runtime.json'),
  JSON.stringify({ versions, baseline }, null, 2),
  { flag: 'wx' },
);
artifactFiles.push(join(output, 'before/runtime.json'));
const archive = await new DefaultArtifactClient().uploadArtifact(
  `blog-server-api-backup-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  artifactFiles,
  output,
  { retentionDays: 90 },
);
if (!archive.id || !archive.digest)
  throw Error('API recovery packages were not archived; no cloud write started');
await checkBlogSiteBaseline(baseline);
if ((await readBlogRuntimeSource()) !== codeSha)
  throw Error('Staged Blog changed after archiving; no cloud write started');
const resources = await ensureFormalArticleResources({ manager, envId: policy.envId });
await writeFile(join(output, 'resources.json'), JSON.stringify(resources, null, 2), { flag: 'wx' });
const results = [];
for (const name of names) {
  const before = captured.entries.find((entry) => entry.snapshot.name === name)?.snapshot;
  const candidate = candidates.get(name);
  if (!before || !candidate) throw Error('Verified API recovery inputs disappeared');
  const result = await replaceBlogFunctionCode({
    name,
    provider,
    before,
    original: await readFile(join(output, `before/${name}.zip`)),
    candidate,
    beforeVersion: versions[name],
    expectedVersion: codeSha,
    readHealth: () => readFunctionRuntimeVersion(policy.envId, name),
  });
  results.push({ name, result });
  await writeFile(join(output, 'updates.json'), JSON.stringify(results, null, 2));
  if (result.status !== 'accepted')
    throw Error(`API update not accepted: ${name}; no further write will run`);
  await checkBlogSiteBaseline(baseline);
}
await writeFile(
  join(output, 'result.json'),
  JSON.stringify(
    {
      codeSha,
      executorSha,
      backupArtifactId: String(archive.id),
      configurationUnchanged: true,
      websiteUnchanged: true,
      resources,
      results,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  'Both Blog API code extensions verified; existing function configuration, website routes and business data were preserved. Publishing remains disabled.',
);
