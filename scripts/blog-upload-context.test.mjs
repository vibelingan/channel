import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { packageBlogServer } from './blog/package-server.mjs';
import { prepareBlogUploadContext } from './blog/prepare-upload-context.mjs';
import { checkBlogServerPackage } from './blog/server-package-check.mjs';

const siteOrigin = 'https://supplychainsai.com';
const codeSha = 'a'.repeat(40);
const video = Buffer.from('the original approved media for the factory video');
const videoSha = createHash('sha256').update(video).digest('hex');
const path = `client/media/factory/oem-factory.${videoSha.slice(0, 12)}.mp4`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'channel-blog-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'site');
  await mkdir(join(source, 'server'), { recursive: true });
  await mkdir(join(source, 'client/_astro'), { recursive: true });
  await mkdir(dirname(join(source, path)), { recursive: true });
  await writeFile(join(source, 'server/entry.mjs'), 'process.exit(0)');
  await writeFile(join(source, 'client/_astro/example.css'), 'body{margin:0}');
  await writeFile(join(source, path), video);
  const directory = join(root, 'approved');
  const manifest = await packageBlogServer({ source, destination: directory, codeSha, siteOrigin });
  return { directory, manifest, current: manifest, destination: join(root, 'upload') };
}

test('an unchanged known video is omitted only from upload and the build reconstructs the approved runtime bytes', async (t) => {
  const input = await setup(t);
  const result = await prepareBlogUploadContext(input);
  assert.equal(result.directory, input.destination);
  assert.equal(result.reusedAsset.bytes, video.length);
  assert.equal(result.reusedAsset.sha256, videoSha);
  await assert.rejects(access(join(result.directory, path)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(input.directory, path)), video);
  assert.equal(
    result.reusedAsset.url,
    new URL(`/blog/${path.slice('client/'.length)}`, siteOrigin).href,
  );

  const docker = await readFile(join(result.directory, 'Dockerfile'), 'utf8');
  const run = docker.split('\n').find((line) => line.startsWith('RUN '));
  const [node, flag, command, script] = JSON.parse(run.slice('RUN '.length));
  assert.equal(node, 'node');
  assert.equal(flag, '--input-type=module');
  assert.equal(command, '-e');
  assert(docker.indexOf(run) < docker.indexOf('USER node'));
  const simulate = (body, response = { status: 200 }) => {
    const text = [
      `const responseBody = Buffer.from(${JSON.stringify(body.toString('base64url'))}, "base64url");`,
      `const expectedURL = ${JSON.stringify(result.reusedAsset.url)};`,
      'globalThis.fetch = async (url, options) => {',
      '  if (url !== expectedURL || options.redirect !== "error" || !options.signal) throw Error("Unexpected source request");',
      `  return new Response(responseBody, { status: ${response.status}, headers: {"Content-Type":"video/mp4"} });`,
      '};',
      script,
    ].join('\n');
    return spawnSync(process.execPath, [flag, command, text], {
      cwd: result.directory,
      encoding: 'utf8',
      timeout: 5000,
    });
  };
  for (const content of [video.subarray(0, -1), Buffer.alloc(video.length, 0)]) {
    const broken = simulate(content);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /factory video length or checksum differs/);
    await assert.rejects(access(join(result.directory, path)), { code: 'ENOENT' });
  }
  const invalidResponse = simulate(video, { status: 503 });
  assert.notEqual(invalidResponse.status, 0);
  assert.match(invalidResponse.stderr, /factory video download failed/);
  const rebuilt = simulate(video);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.deepEqual(await readFile(join(result.directory, path)), video);
  const manifest = await checkBlogServerPackage(result.directory, { codeSha, siteOrigin });
  assert.deepEqual(manifest.files, input.manifest.files);
});

test('a new or unconfirmed video and other assets remain in the original approved upload', async (t) => {
  const input = await setup(t);
  const result = await prepareBlogUploadContext({
    ...input,
    current: { files: input.current.files.filter((file) => file.path !== path) },
  });
  assert.deepEqual(result, { directory: input.directory, reusedAsset: null });
  await assert.rejects(access(input.destination), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(input.directory, path)), video);
});
