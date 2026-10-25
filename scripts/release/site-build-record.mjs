import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { identity, sha256 } from './input.mjs';
import { serverBlogBuild } from './public-build-env.mjs';
import { filesFromSiteBuild } from './site-files.mjs';
function state({ codeSha, dist, productFile, blogFile, blogDelivery = 'static' }) {
  if (!['static', 'server'].includes(blogDelivery)) throw Error('Unknown Blog delivery ownership');
  if (!/^[a-f0-9]{40}$/.test(codeSha ?? '')) throw Error('Exact build SHA required');
  const files = filesFromSiteBuild(dist);
  return {
    files,
    record: {
      schemaVersion: blogDelivery === 'server' ? 2 : 1,
      purpose: 'same-run-site-build',
      codeSha,
      productsSha256: sha256(readFileSync(productFile)),
      ...(blogDelivery === 'server'
        ? { blog: { delivery: 'server', apiContract: 'articles-v1' } }
        : { blogSha256: sha256(readFileSync(blogFile)) }),
      filesSha256: identity(
        [...files]
          .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      ),
    },
  };
}
export function sealBuiltSite(options) {
  const { record } = state(options);
  writeFileSync(options.recordFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  return record;
}
export function readBuiltSite(options) {
  const current = state(options);
  if (identity(current.record) !== identity(JSON.parse(readFileSync(options.recordFile, 'utf8'))))
    throw Error('Built site or frozen input changed after build verification');
  return current.files;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/test')
    throw Error('Normal test build only');
  sealBuiltSite({
    codeSha: process.env.GITHUB_SHA,
    dist: 'apps/site/dist',
    productFile: 'output/seo-release/product-snapshot.json',
    blogFile: 'output/seo-release/blog/snapshot.json',
    blogDelivery: serverBlogBuild(process.env) ? 'server' : 'static',
    recordFile: 'output/seo-release/build-record.json',
  });
  console.log(
    'Complete static files and their declared content inputs recorded for same-run delivery.',
  );
}
