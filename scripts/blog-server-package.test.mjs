import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageBlogServer } from './blog/package-server.mjs';

test('Blog deployment package contains only build output, a non-root runtime and checked inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blog-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'server'), { recursive: true });
  await mkdir(join(source, 'client/blog/_astro'), { recursive: true });
  await writeFile(join(source, 'server/entry.mjs'), 'console.log("built")');
  await writeFile(join(source, 'client/blog/_astro/a.css'), 'body{}');
  const destination = join(root, 'package');
  const manifest = await packageBlogServer({ source, destination, codeSha: 'a'.repeat(40) });
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].sha256.length, 64);
  const docker = await readFile(join(destination, 'Dockerfile'), 'utf8');
  assert.match(docker, /USER node/);
  assert(!docker.includes('npm install'));
  assert(!docker.includes('apps/site/public'));
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'release.json'), 'utf8')), manifest);
  await assert.rejects(
    packageBlogServer({ source, destination, codeSha: 'a'.repeat(40) }),
    /exist/i,
  );
  await assert.rejects(
    packageBlogServer({ source, destination: join(root, 'invalid'), codeSha: 'main' }),
    /exact source/,
  );
  await symlink(join(root, 'secret.env'), join(source, 'secret.env'));
  await assert.rejects(
    packageBlogServer({ source, destination: join(root, 'unsafe'), codeSha: 'a'.repeat(40) }),
    /symlink/,
  );
});
