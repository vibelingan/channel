import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertHostingPath, limits, readHostingObject, sha256 } from './input.mjs';
const protectedPath =
  /^(?:_(?!astro\/)|cloud-admin\/|\.cloudbase-backup\/|google[a-z0-9]+\.html$|BingSiteAuth\.xml$)/;
const staticFile =
  /\.(?:html|xml|txt|json|css|js|mjs|map|webp|png|jpe?g|gif|svg|ico|avif|woff2?|ttf|otf|mp4|pdf)$/i;
export function isManagedSiteFile(path) {
  assertHostingPath(path);
  return !protectedPath.test(path) && path !== '404.html' && staticFile.test(path);
}
/** Only known static site files are adopted. Ownership/auth/audit/extensionless legacy objects remain untouched. */
export function filesFromHostingBackup(manifest, directory) {
  const files = new Map();
  for (const entry of manifest.entries) {
    if (!isManagedSiteFile(entry.path)) continue;
    const bytes = readHostingObject(directory, entry);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw Error('Corrupt baseline file');
    files.set(entry.path, bytes);
  }
  if (!files.has('index.html')) throw Error('Baseline home missing');
  return files;
}
export function filesFromSiteBuild(directory) {
  const files = new Map();
  let total = 0;
  function walk(prefix = '') {
    for (const name of readdirSync(join(directory, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name;
      assertHostingPath(path);
      const stat = lstatSync(join(directory, path));
      if (stat.isSymbolicLink()) throw Error('Link in static build');
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (
        !stat.isFile() ||
        stat.size > limits.fileBytes ||
        files.size >= limits.files ||
        total + stat.size > limits.totalBytes
      )
        throw Error('Static build budget exceeded');
      if (path === '404.html' || /^(?:google[a-z0-9]+\.html|BingSiteAuth\.xml)$/.test(path))
        continue;
      if (!isManagedSiteFile(path)) throw Error('Unmanaged static build file');
      const bytes = readFileSync(join(directory, path));
      total += bytes.length;
      files.set(path, bytes);
    }
  }
  walk();
  if (!files.has('index.html') || !files.has('errors/not-found.html'))
    throw Error('Complete site and dedicated error page required');
  return files;
}
/** Keep old assets for browsers already displaying the previous HTML; remove only obsolete owned HTML/discovery files. */
export function retainSiteAssets(files, baseline) {
  for (const entry of baseline?.staticManifest.entries ?? []) {
    if (
      entry.path.endsWith('.html') ||
      /\.xml$|^(?:robots\.txt|seo-manifest\.json|products\/manifest\.json)$/.test(entry.path)
    )
      continue;
    const bytes = readHostingObject(baseline.directory, entry);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      throw Error('Corrupt retained asset');
    if (files.has(entry.path)) {
      if (entry.path.startsWith('_astro/') && sha256(files.get(entry.path)) !== entry.sha256)
        throw Error('Immutable asset changed');
    } else files.set(entry.path, bytes);
  }
  return files;
}
export function ownedSitePaths(input, baseline) {
  return [
    ...new Set(
      [...(baseline?.staticManifest.entries ?? []), ...input.staticManifest.entries].map(
        (e) => e.path,
      ),
    ),
  ].filter(isManagedSiteFile);
}

export function assertSameAcceptedBlog(a, b) {
  const articles = (source) => {
    const entry = source.staticManifest.entries.find((e) => e.path === 'seo-manifest.json');
    if (!entry) return [];
    return JSON.parse(readHostingObject(source.directory, entry).toString())
      .entries.filter((e) => e.kind === 'article')
      .map((e) => ({ path: e.path, revision: e.content.revision }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };
  if (JSON.stringify(articles(a)) !== JSON.stringify(articles(b)))
    throw Error(
      'Static recovery would disagree with accepted article data; use an article update or withdrawal publication',
    );
}
export function assertPublicSiteDeliveryFiles(files, aiOrigin) {
  if (typeof aiOrigin !== 'string' || !aiOrigin.startsWith('https://'))
    throw Error('Existing AI assistant address is required');
  const names =
    /JWT_SECRET|ADMIN_PASSWORD_HASH|BOOTSTRAP_ADMIN_TOKEN|EMAIL_PASSWORD|EMAIL_USER|TENCENTCLOUD_SECRET(?:ID|KEY)|TENCENTCLOUD_SESSIONTOKEN|ALI_APP_KEY|ALI_APP_SECRET|ALI_OAUTH_CALLBACK_URL|ALI_TOKEN_ENCRYPTION_KEY_V1|WECOM_WEBHOOK_URL|DATABASE_URL|KB_API_KEY|AI_IP_HASH_SECRET/;
  let assistant = false;
  for (const [path, bytes] of files) {
    if (!/\.(?:html|js|json|xml|txt|css|mjs|map)$/.test(path)) continue;
    const text = bytes.toString();
    if (names.test(text)) throw Error('Server-only setting name in public site');
    if (text.includes(aiOrigin)) assistant = true;
  }
  if (!assistant) throw Error('Public site is missing its existing AI assistant integration');
}
