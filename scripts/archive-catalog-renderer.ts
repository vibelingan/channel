import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { blogWorkerSdk } from './blog/worker-source.ts';
import { createRendererSource } from './release/catalog-renderer-source.mjs';
import { packCatalogRenderer } from './release/catalog-renderer.mjs';
import { createGithubReadClient } from './release/github-read.mjs';
import { sha256 } from './release/input.mjs';
import { requireSiteChecks } from './release/site-checks.mjs';
import { SITE_DELIVERY_POLICY as policy } from './release/site-policy.mjs';
const env = process.env;
if (
  env.GITHUB_ACTIONS !== 'true' ||
  env.GITHUB_REPOSITORY !== policy.repository ||
  ![policy.trustedRef, 'refs/heads/test'].includes(env.GITHUB_REF ?? '') ||
  env.TCB_ENV_ID !== policy.envId ||
  !env.TENCENTCLOUD_SECRETID ||
  !env.TENCENTCLOUD_SECRETKEY ||
  !env.GITHUB_TOKEN ||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
)
  throw Error('Approved renderer archive invocation required');
const codeSha = env.SITE_RENDERER_SHA || (env.GITHUB_SHA as string);
if (!/^[a-f0-9]{40}$/.test(codeSha)) throw Error('Exact renderer source commit required');
await requireSiteChecks({
  github: createGithubReadClient({ policy, token: env.GITHUB_TOKEN }),
  policy,
  codeSha: env.GITHUB_SHA,
  context: {
    ref: env.GITHUB_REF,
    event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    workflowRef: env.GITHUB_WORKFLOW_REF,
  },
});
if (codeSha !== env.GITHUB_SHA)
  await createGithubReadClient({ policy, token: env.GITHUB_TOKEN }).requireCI(codeSha);
const directory = resolve('output/catalog-renderer');
const manifest = packCatalogRenderer({ codeSha, directory });
const source = createRendererSource({ token: env.GITHUB_TOKEN });
const tag = `seo-renderer-${codeSha}`;
const releases = await source.api('GET', '/releases?per_page=100');
if (!Array.isArray(releases)) throw Error('Release inventory could not be read');
const matches = releases.filter((r: { tag_name: string }) => r.tag_name === tag);
if (matches.length > 1) throw Error('Duplicate renderer releases');
let release = matches[0];
if (!release)
  release = await source.api('POST', '/releases', {
    tag_name: tag,
    target_commitish: codeSha,
    name: `Catalog renderer ${codeSha.slice(0, 12)}`,
    draft: true,
    prerelease: true,
    make_latest: 'false',
    body: `Fixed source ${codeSha}. Node ${manifest.runtime.node}; pnpm ${manifest.runtime.pnpm}. Does not contain customer data or credentials.`,
  });
if (!release || release.tag_name !== tag || release.target_commitish !== codeSha)
  throw Error('Release readback differs');
for (const name of ['renderer.tar.gz', 'renderer.json']) {
  const existing = release.assets.filter((a: { name: string }) => a.name === name);
  if (existing.length > 1) throw Error('Duplicate renderer asset');
  if (!existing.length) {
    if (!release.draft)
      throw Error('Published renderer archive is incomplete; preserve it for investigation');
    await source.upload(release.id, name, await readFile(resolve(directory, name)));
  }
}
if (release.draft)
  release = await source.api('PATCH', `/releases/${release.id}`, {
    draft: false,
    make_latest: 'false',
  });
const approved = {
  schemaVersion: 1,
  codeSha,
  manifestSha256: sha256(JSON.stringify(manifest)),
  archiveSha256: manifest.archive.sha256,
  releaseId: release.id,
  sourceRunId: env.GITHUB_RUN_ID,
  runtime: manifest.runtime,
  inputSchema: 1,
};
await source.download(approved);
const db = blogWorkerSdk({
  env: policy.envId,
  region: policy.region,
  secretId: env.TENCENTCLOUD_SECRETID,
  secretKey: env.TENCENTCLOUD_SECRETKEY,
}).database();
const row = db.collection('catalogSeoBuilders').doc(codeSha);
const before = await row.get();
const existing = Array.isArray(before.data) ? before.data[0] : before.data;
if (
  existing &&
  (existing.manifestSha256 !== approved.manifestSha256 ||
    existing.archiveSha256 !== approved.archiveSha256 ||
    existing.releaseId !== approved.releaseId)
)
  throw Error('An existing renderer approval differs; no replacement allowed');
if (!existing) await row.set(approved);
const after = await row.get();
const verified = Array.isArray(after.data) ? after.data[0] : after.data;
if (
  !verified ||
  verified.manifestSha256 !== approved.manifestSha256 ||
  verified.archiveSha256 !== approved.archiveSha256 ||
  verified.releaseId !== approved.releaseId
)
  throw Error('Renderer approval write needs readback');
await writeFile(
  resolve(directory, 'receipt.json'),
  JSON.stringify({ ...approved, downloadedAndVerified: true, websiteWrites: 0 }, null, 2),
  { flag: 'wx' },
);
console.log(`Renderer ${codeSha} permanently archived and read back. Website unchanged.`);
