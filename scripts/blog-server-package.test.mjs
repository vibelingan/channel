import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packageBlogServer } from './blog/package-server.mjs';
import { checkBlogServerPackage } from './blog/server-package-check.mjs';

test('Blog deployment package contains only build output, a non-root runtime and checked inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blog-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(join(source, 'server'), { recursive: true });
  await mkdir(join(source, 'client/blog/_astro'), { recursive: true });
  await writeFile(join(source, 'server/entry.mjs'), 'console.log("built")');
  await writeFile(join(source, 'client/blog/_astro/a.css'), 'body{}');
  const destination = join(root, 'package');
  const manifest = await packageBlogServer({
    source,
    destination,
    siteOrigin: 'https://example.test',
    codeSha: 'a'.repeat(40),
  });
  assert.equal(manifest.files.length, 2);
  const expected = { codeSha: 'a'.repeat(40), siteOrigin: 'https://example.test' };
  assert.deepEqual(await checkBlogServerPackage(destination, expected), manifest);
  await assert.rejects(
    checkBlogServerPackage(destination, { ...expected, codeSha: 'b'.repeat(40) }),
    /provenance/,
  );
  await assert.rejects(
    checkBlogServerPackage(destination, { ...expected, siteOrigin: 'https://other.test' }),
    /provenance/,
  );
  assert.equal(manifest.files[0].sha256.length, 64);
  const docker = await readFile(join(destination, 'Dockerfile'), 'utf8');
  assert.match(docker, /USER node/);
  assert(!docker.includes('npm install'));
  assert(!docker.includes('apps/site/public'));
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'release.json'), 'utf8')), manifest);
  await assert.rejects(
    packageBlogServer({
      source,
      destination,
      siteOrigin: 'https://example.test',
      codeSha: 'a'.repeat(40),
    }),
    /exist/i,
  );
  await assert.rejects(
    packageBlogServer({
      source,
      destination: join(root, 'invalid'),
      siteOrigin: 'https://example.test',
      codeSha: 'main',
    }),
    /exact source/,
  );
  await writeFile(join(destination, 'extra.env'), 'not allowed');
  await assert.rejects(checkBlogServerPackage(destination, expected), /undeclared/);
  await rm(join(destination, 'extra.env'));
  await writeFile(join(destination, 'server/entry.mjs'), 'changed');
  await assert.rejects(checkBlogServerPackage(destination, expected), /bytes changed/);
  await symlink(join(root, 'secret.env'), join(source, 'secret.env'));
  await assert.rejects(
    packageBlogServer({
      source,
      destination: join(root, 'unsafe'),
      siteOrigin: 'https://example.test',
      codeSha: 'a'.repeat(40),
    }),
    /symlink/,
  );
});
