import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import CloudBase from '@cloudbase/manager-node';
import { captureFunctionBackups } from '../capture-function-backups.mjs';
import { checkFunctionArchive } from '../release/function-archive.mjs';
import { createCloudbaseFunctionProvider } from '../release/function-provider.mjs';
import { createGithubReadClient } from '../release/github-read.mjs';
import { identity, sha256 } from '../release/input.mjs';
import { replaceAdminCode } from './bootstrap-delivery.mjs';
import { assertBlogBootstrapInvocation } from './bootstrap-policy.mjs';
import { ensureFormalArticleResources } from './resources.mjs';
import { readAdminRuntimeVersion } from './runtime-health.mjs';
import { checkBlogSiteBaseline, readBlogSiteBaseline } from './site-baseline.mjs';
const env = process.env;
const policy = assertBlogBootstrapInvocation(env);
if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY || !env.GITHUB_TOKEN)
  throw new Error('Existing test environment credentials required');
const codeSha = env.GITHUB_SHA ?? '';
await createGithubReadClient({ policy, token: env.GITHUB_TOKEN }).requireCI(codeSha);
const manager = new CloudBase({
  envId: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
});
const target = { envId: policy.envId, siteOrigin: policy.siteOrigin };
const configurationKey = createHmac('sha256', env.TENCENTCLOUD_SECRETKEY)
  .update(`channel-function-observation:v1:${identity(target)}`)
  .digest();
const provider = createCloudbaseFunctionProvider({
  manager,
  target,
  region: policy.region,
  names: ['admin'],
  configurationKey,
});
const readHealth = () => readAdminRuntimeVersion(policy.envId);
const originalVersion = await readHealth();
const output = resolve('output/blog-bootstrap');
await mkdir(output, { recursive: true });
const baseline = await readBlogSiteBaseline();
const captured = await captureFunctionBackups({
  provider,
  names: ['admin'],
  output: join(output, 'before'),
});
const before = captured.entries[0]?.snapshot;
if (
  !before ||
  before.runtime !== 'Nodejs20.19' ||
  before.handler !== 'index.main' ||
  before.triggerCount !== 0
)
  throw new Error('Current admin function is outside this controlled update scope');
const candidate = join(output, 'candidate');
await mkdir(candidate);
await writeFile(join(candidate, 'index.js'), await readFile('apps/functions/admin/dist/index.js'), {
  flag: 'wx',
});
await writeFile(
  join(candidate, 'package.json'),
  JSON.stringify({ private: true, main: 'index.js', type: 'commonjs', dependencies: {} }),
  { flag: 'wx' },
);
const zip = join(output, 'candidate.zip');
execFileSync(
  'python3',
  [
    '-c',
    `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'x',compression=zipfile.ZIP_DEFLATED) as z:
 for name in ('index.js','package.json'): z.write(root/name,name)
`,
    candidate,
    zip,
  ],
  { stdio: 'pipe', timeout: 30000 },
);
const bytes = await readFile(zip);
checkFunctionArchive(bytes, { smoke: true });
const artifactFiles = [
  join(output, 'before/function-backups.json'),
  join(output, 'before/admin.zip'),
  zip,
];
await writeFile(
  join(output, 'before/runtime.json'),
  JSON.stringify({ version: originalVersion, baseline }, null, 2),
  { flag: 'wx' },
);
artifactFiles.push(join(output, 'before/runtime.json'));
const archive = await new DefaultArtifactClient().uploadArtifact(
  `blog-bootstrap-backup-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
  artifactFiles,
  output,
  { retentionDays: 90 },
);
if (!archive.id || !archive.digest)
  throw new Error('The original program backup was not archived; no cloud writes started');
await checkBlogSiteBaseline(baseline);
const resources = await ensureFormalArticleResources({ manager, envId: policy.envId });
await writeFile(join(output, 'resources.json'), JSON.stringify(resources, null, 2), { flag: 'wx' });
const result = await replaceAdminCode({
  provider,
  before,
  original: await readFile(join(output, 'before/admin.zip')),
  candidate: bytes,
  beforeVersion: originalVersion,
  expectedVersion: codeSha,
  readHealth,
});
const observed = 'snapshot' in result ? result.snapshot : undefined;
await writeFile(join(output, 'update-result.json'), JSON.stringify(result, null, 2), {
  flag: 'wx',
});
if (result.status !== 'accepted' || !observed)
  throw new Error(
    `Admin update ${result.status}; no additional code or configuration writes will run`,
  );
await checkBlogSiteBaseline(baseline);
await writeFile(
  join(output, 'result.json'),
  JSON.stringify(
    {
      codeSha,
      artifactId: String(archive.id),
      adminPackageSha256: observed.packageSha256,
      configurationUnchanged: true,
      websiteUnchanged: true,
      resources,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  'Article collections and admin API installed; website, pricing, sync, routes and function configuration unchanged.',
);
