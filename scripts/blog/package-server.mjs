import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package only the already built public Blog service. No repository, credentials,
 * videos, product snapshots or user uploads enter the deployment context. */
export async function packageBlogServer({ source, destination, codeSha }) {
  if (!/^[a-f0-9]{40}$/.test(codeSha)) throw Error('An exact source commit is required');
  await mkdir(destination); // Refuse reuse of a stale or partial package.
  const files = [];
  async function copy(directory, prefix = '') {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (item.name.startsWith('.') || item.isSymbolicLink())
        throw Error('Unexpected hidden file or symlink in Blog output');
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await copy(join(directory, item.name), path);
        continue;
      }
      if (!item.isFile() || !/^[A-Za-z0-9_./@-]+$/.test(path))
        throw Error('Unexpected Blog output member');
      const bytes = await readFile(join(directory, item.name));
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
      files.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await copy(source);
  if (
    !files.some((f) => f.path === 'server/entry.mjs') ||
    !files.some((f) => f.path.endsWith('.css'))
  )
    throw Error('The built Blog service or browser assets are missing');
  const docker = `FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /opt/blog
COPY --chown=node:node . .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/blog/health.json').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/entry.mjs"]
`;
  await writeFile(join(destination, 'Dockerfile'), docker, { flag: 'wx' });
  await writeFile(
    join(destination, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' })}\n`,
    { flag: 'wx' },
  );
  const manifest = {
    schemaVersion: 1,
    service: 'blog-pages',
    codeSha,
    files,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    dockerfileSha256: createHash('sha256').update(docker).digest('hex'),
  };
  await writeFile(join(destination, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw Error('Usage: node scripts/blog/package-server.mjs NEW_OUTPUT_DIRECTORY');
  const result = await packageBlogServer({
    source: fileURLToPath(new URL('../../apps/site/dist-blog/', import.meta.url)),
    destination: resolve(destination),
    codeSha: process.env.CHANNEL_BUILD_SHA ?? process.env.GITHUB_SHA ?? '',
  });
  console.log(
    JSON.stringify({
      service: result.service,
      codeSha: result.codeSha,
      files: result.files.length,
      bytes: result.totalBytes,
    }),
  );
}
