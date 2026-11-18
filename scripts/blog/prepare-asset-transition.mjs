import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFully } from '../smoke-http.mjs';
import { checkBlogServerPackage } from './server-package-check.mjs';

const assetDirectory = 'client/_astro/';

/** Only switch the HTML after the running program can serve every candidate asset. */
export async function selectBlogTransitionProgram({
  current,
  candidate,
  destination,
  siteOrigin,
  request = fetchFully,
}) {
  const transition = await prepareBlogAssetTransition({
    current,
    candidate,
    destination,
    siteOrigin,
  });
  const preload = join(destination, 'preload');
  const manifest = await checkBlogServerPackage(preload, { codeSha: current.codeSha, siteOrigin });
  const newPaths = new Set(transition.preload.addedAssets);
  const missingAssets = [];
  for (const file of manifest.files.filter(({ path }) => path.startsWith(assetDirectory))) {
    const url = new URL(`/blog/${file.path.slice('client/'.length)}`, siteOrigin);
    const response = await request('GET', url.href, {
      maxBytes: Math.max(file.bytes, 512 * 1024),
      timeoutMs: 15000,
      redirect: 'error',
    });
    if (response.status === 404 && newPaths.has(file.path)) {
      missingAssets.push(file.path);
    } else if (
      response.status !== 200 ||
      response.body.length !== file.bytes ||
      createHash('sha256').update(response.body).digest('hex') !== file.sha256
    ) {
      throw Error(`The running Blog did not serve the expected asset: ${file.path}`);
    }
  }
  const phase = missingAssets.length ? 'preload' : 'candidate';
  return { phase, directory: join(destination, phase), missingAssets };
}

/**
 * Keep both versions' browser assets on both sides of a Blog switch.
 * Deploy the preload package first, confirm its new assets are served, then
 * deploy the candidate. The preload package is also the rollback target.
 */
export async function prepareBlogAssetTransition({ current, candidate, destination, siteOrigin }) {
  const readPackage = async (directory, codeSha) => ({
    directory,
    manifest: await checkBlogServerPackage(directory, { codeSha, siteOrigin }),
  });
  const [before, after] = await Promise.all([
    readPackage(current.directory, current.codeSha),
    readPackage(candidate.directory, candidate.codeSha),
  ]);
  const assets = new Map();
  for (const pkg of [before, after]) {
    for (const file of pkg.manifest.files.filter(({ path }) => path.startsWith(assetDirectory))) {
      const previous = assets.get(file.path);
      if (previous && previous.file.sha256 !== file.sha256)
        throw Error(`Blog asset changed without a new URL: ${file.path}`);
      assets.set(file.path, { file, directory: pkg.directory });
    }
  }
  if (!assets.size) throw Error('The Blog builds do not contain browser assets');

  // Publish the pair only after verifying both complete packages.
  const temporary = await mkdtemp(join(dirname(destination), `.${basename(destination)}-`));
  const output = {};
  try {
    for (const [name, pkg] of [
      ['preload', before],
      ['candidate', after],
    ]) {
      const directory = join(temporary, name);
      await cp(pkg.directory, directory, { recursive: true, errorOnExist: true, force: false });
      const files = [...pkg.manifest.files];
      const paths = new Set(files.map(({ path }) => path));
      const addedAssets = [];
      for (const { file, directory: source } of assets.values()) {
        if (paths.has(file.path)) continue;
        const target = join(directory, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(join(source, file.path)), { flag: 'wx' });
        files.push(file);
        addedAssets.push(file.path);
      }
      const manifest = {
        ...pkg.manifest,
        files,
        totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      };
      await writeFile(join(directory, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await checkBlogServerPackage(directory, { codeSha: manifest.codeSha, siteOrigin });
      output[name] = { codeSha: manifest.codeSha, addedAssets };
    }
    await writeFile(join(temporary, 'transition.json'), `${JSON.stringify(output, null, 2)}\n`);
    await mkdir(destination);
    try {
      for (const name of ['preload', 'candidate', 'transition.json'])
        await rename(join(temporary, name), join(destination, name));
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return output;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [currentDir, currentSha, candidateDir, candidateSha, outputDir, siteOrigin] =
    process.argv.slice(2);
  if (!currentDir || !currentSha || !candidateDir || !candidateSha || !outputDir || !siteOrigin)
    throw Error('Usage: prepare-asset-transition.mjs CURRENT SHA CANDIDATE SHA NEW_OUTPUT ORIGIN');
  console.log(
    JSON.stringify(
      await prepareBlogAssetTransition({
        current: { directory: resolve(currentDir), codeSha: currentSha },
        candidate: { directory: resolve(candidateDir), codeSha: candidateSha },
        destination: resolve(outputDir),
        siteOrigin,
      }),
    ),
  );
}
