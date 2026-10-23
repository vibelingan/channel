import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { verifyReleaseArtifact } from '../release/artifact.mjs';
import { configurationHash } from '../release/hosting-configuration.mjs';
import { assertHostingPath, identity, readJson, readObject, sha256 } from '../release/input.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';

export function createBlogDummyPayload({
  buildDirectory,
  directory,
  configuration,
  codeSha,
  taskId,
  baseline,
  now = Date.now(),
}) {
  if (!/^[a-f0-9]{40}$/.test(codeSha) || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId))
    throw new Error('Invalid Blog payload identity');
  const files = new Map();
  let total = 0;
  function walk(path = '') {
    for (const name of readdirSync(join(buildDirectory, path))) {
      const relative = path ? `${path}/${name}` : name;
      assertHostingPath(relative);
      const stat = lstatSync(join(buildDirectory, relative));
      if (stat.isSymbolicLink()) throw new Error('Link in Blog build');
      if (stat.isDirectory()) {
        walk(relative);
        continue;
      }
      if (
        !stat.isFile() ||
        !/\.(?:html|css|js|jpg|png|webp|woff2?)$/.test(relative) ||
        stat.size > 4 * 1024 * 1024 ||
        files.size >= 512 ||
        total + stat.size > 64 * 1024 * 1024
      )
        throw new Error('Blog payload escaped its file budget');
      total += stat.size;
      const body = readFileSync(join(buildDirectory, relative));
      if (
        relative.endsWith('.html') &&
        (!body.toString().includes('content="noindex,nofollow"') ||
          /cloud:\/\/|pending-upload/.test(body.toString()))
      )
        throw new Error('Dummy HTML is not safe for isolated delivery');
      files.set(policy.canaryPrefix + relative, body);
    }
  }
  walk();
  if (baseline)
    for (const entry of baseline.staticManifest.entries) {
      if (entry.path.endsWith('.html')) continue;
      if (!entry.path.startsWith(policy.canaryPrefix)) throw new Error('Foreign baseline asset');
      const body = readObject(baseline.directory, entry.path, 4 * 1024 * 1024);
      if (sha256(body) !== entry.sha256 || body.length !== entry.bytes)
        throw new Error('Corrupt baseline asset');
      if (files.has(entry.path) && sha256(files.get(entry.path)) !== entry.sha256)
        throw new Error('Immutable Blog asset changed');
      if (!files.has(entry.path)) {
        total += body.length;
        files.set(entry.path, body);
      }
      if (files.size > 512 || total > 64 * 1024 * 1024)
        throw new Error('Retained Blog asset budget exceeded');
    }
  if (!files.has(`${policy.canaryPrefix}index.html`)) throw new Error('Blog payload has no index');
  const entry = (path, body) => ({ path, bytes: body.length, sha256: sha256(body) });
  const staticManifest = {
    schemaVersion: 2,
    purpose: 'static-release',
    configuration,
    configurationSha256: configurationHash(configuration),
    entries: [...files].map(([path, body]) => entry(path, body)),
  };
  files.set('static-manifest.json', Buffer.from(JSON.stringify(staticManifest)));
  const compatibility = Buffer.from(
    JSON.stringify({ schemaVersion: 1, purpose: 'blog-dummy', taskId }),
  );
  files.set('compatibility.json', compatibility);
  const payload = {
    schemaVersion: 2,
    purpose: 'release-payload',
    releaseId: `blog-${taskId}-${codeSha}`,
    codeSha,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'canary', prefix: policy.canaryPrefix },
    createdAt: new Date(now).toISOString(),
    staticManifestPath: 'static-manifest.json',
    snapshotPath: null,
    functions: [],
    compatibilityRef: { path: 'compatibility.json', sha256: sha256(compatibility) },
    entries: [...files].map(([path, body]) => entry(path, body)),
  };
  files.set('payload-manifest.json', Buffer.from(JSON.stringify(payload)));
  for (const [path, body] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), body, { flag: 'wx' });
  }
  return payload;
}
/** @param {{ directory: string, run: object, acceptedSeal?: unknown, now?: number }} options */
export function blogDummyArtifact({ directory, run, acceptedSeal = null, now = Date.now() }) {
  const payload = readJson(directory, 'payload-manifest.json');
  const manifest = readJson(directory, 'static-manifest.json');
  const envelope = {
    ...payload,
    artifact: {
      repository: run.repository,
      workflowPath: run.workflowPath,
      runId: run.runId,
      artifactId: run.artifact.id,
      expiresAt: run.artifact.expiresAt,
      manifestSha256: sha256(readFileSync(join(directory, 'payload-manifest.json'))),
    },
  };
  const artifactPolicy = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    target: { envId: policy.envId, siteOrigin: policy.siteOrigin },
    scope: { kind: 'canary', prefix: policy.canaryPrefix },
    configurationSha256: manifest.configurationSha256,
  };
  const verified = verifyReleaseArtifact({
    envelope,
    directory,
    policy: artifactPolicy,
    run,
    acceptedSeal,
    mode: acceptedSeal ? 'recovery' : 'candidate',
    now,
  });
  if (identity(verified.envelope.scope) !== identity(artifactPolicy.scope))
    throw new Error('Blog artifact scope mismatch');
  return { ...verified, directory, policy: artifactPolicy, run, acceptedSeal, now };
}
