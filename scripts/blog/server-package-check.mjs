import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Verify the exact successful CI output before handing it to the cloud builder. */
export async function checkBlogServerPackage(directory, { codeSha, siteOrigin }) {
  const manifest = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.service !== 'blog-pages' ||
    manifest.codeSha !== codeSha ||
    manifest.siteOrigin !== siteOrigin ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 2 ||
    manifest.files.length > 500
  )
    throw Error('Blog package provenance differs from the requested release');
  const expected = new Set(['Dockerfile', 'package.json', 'release.json']);
  let bytes = 0;
  for (const item of manifest.files) {
    if (
      typeof item.path !== 'string' ||
      !/^(?:server|client)\/[A-Za-z0-9_./@-]+$/.test(item.path) ||
      item.path.split('/').includes('..') ||
      expected.has(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw Error('Invalid Blog package inventory');
    expected.add(item.path);
    const content = await readFile(join(directory, item.path));
    if (
      content.length !== item.bytes ||
      createHash('sha256').update(content).digest('hex') !== item.sha256
    )
      throw Error('Blog package bytes changed');
    bytes += content.length;
  }
  if (
    bytes !== manifest.totalBytes ||
    bytes > 32 * 1024 * 1024 ||
    !expected.has('server/entry.mjs')
  )
    throw Error('Blog package total or entry differs');
  const docker = await readFile(join(directory, 'Dockerfile'));
  if (createHash('sha256').update(docker).digest('hex') !== manifest.dockerfileSha256)
    throw Error('Blog runtime definition changed');
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (JSON.stringify(pkg) !== JSON.stringify({ private: true, type: 'module' }))
    throw Error('Blog package must not install unreviewed dependencies');
  async function inventory(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error('Blog package contains a symlink');
      if (item.isDirectory()) await inventory(join(dir, item.name), path);
      else if (!item.isFile() || !expected.delete(path))
        throw Error('Blog package contains an undeclared file');
    }
  }
  await inventory(directory);
  if (expected.size) throw Error('Blog package inventory is incomplete');
  return manifest;
}
