import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const factoryVideo = /^client\/media\/factory\/oem-factory\.([a-f0-9]{12})\.mp4$/;

/** Keep the approved package intact and omit just one byte-identical public video in transit. */
export async function prepareBlogUploadContext({ directory, manifest, current, destination }) {
  const video = manifest.files.find((file) => {
    const match = factoryVideo.exec(file.path);
    return (
      match?.[1] === file.sha256.slice(0, 12) &&
      current.files.some(
        (old) => old.path === file.path && old.sha256 === file.sha256 && old.bytes === file.bytes,
      )
    );
  });
  if (!video) return { directory, reusedAsset: null };

  const url = new URL(`/blog/${video.path.slice('client/'.length)}`, manifest.siteOrigin).href;
  const reusedAsset = { ...video, url };
  const docker = await readFile(join(directory, 'Dockerfile'), 'utf8');
  const runtimeUser = '\nUSER node\n';
  if (!docker.includes('\nWORKDIR /opt/blog\n') || docker.split(runtimeUser).length !== 2)
    throw Error('Unexpected Blog Dockerfile layout for video reuse');
  const instruction = JSON.stringify([
    'node',
    '--input-type=module',
    '-e',
    restoreVideo(reusedAsset),
  ]);
  const preparedDocker = docker.replace(runtimeUser, `\nRUN ${instruction}${runtimeUser}`);
  const preparedManifest = {
    ...manifest,
    dockerfileSha256: createHash('sha256').update(preparedDocker).digest('hex'),
  };

  await mkdir(destination);
  for (const { path } of manifest.files) {
    if (path === video.path) continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(directory, path), target);
  }
  await copyFile(join(directory, 'package.json'), join(destination, 'package.json'));
  await writeFile(join(destination, 'Dockerfile'), preparedDocker, { flag: 'wx' });
  await writeFile(
    join(destination, 'release.json'),
    `${JSON.stringify(preparedManifest, null, 2)}\n`,
    {
      flag: 'wx',
    },
  );
  return { directory: destination, reusedAsset };
}

function restoreVideo(asset) {
  return `
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const expected = ${JSON.stringify(asset)};
const response = await fetch(expected.url, {
  redirect: 'error',
  signal: AbortSignal.timeout(180_000),
});
if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';')[0] !== 'video/mp4') {
  throw Error('factory video download failed: HTTP ' + response.status);
}
const chunks = [];
const digest = createHash('sha256');
let length = 0;
for await (const chunk of response.body) {
  length += chunk.byteLength;
  if (length > expected.bytes) throw Error('factory video length or checksum differs');
  digest.update(chunk);
  chunks.push(Buffer.from(chunk));
}
if (length !== expected.bytes || digest.digest('hex') !== expected.sha256) {
  throw Error('factory video length or checksum differs');
}
await mkdir(dirname(expected.path), { recursive: true });
await writeFile(expected.path, Buffer.concat(chunks), { flag: 'wx', mode: 0o644 });
`;
}
