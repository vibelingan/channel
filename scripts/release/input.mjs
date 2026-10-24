import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

export const limits = Object.freeze({
  files: 20_000,
  fileBytes: 128 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  jsonBytes: 4 * 1024 * 1024,
  snapshotBytes: 64 * 1024 * 1024,
  xmlBytes: 5 * 1024 * 1024,
  urls: 50_000,
  sitemaps: 100,
  depth: 32,
});
export const sha256 = (body) => createHash('sha256').update(body).digest('hex');
export const backupObjectPath = (path) =>
  `.recovery-objects/${sha256(assertHostingPath(path))}.bin`;
export function readHostingObject(directory, entry, maxBytes = limits.fileBytes) {
  if (entry.sourcePath !== undefined && entry.sourcePath !== backupObjectPath(entry.path))
    throw new Error('Invalid backup object mapping.');
  return readObject(directory, entry.sourcePath ?? entry.path, maxBytes);
}
export const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const productPath = /^\/products\/p-[A-Za-z0-9_-]{1,200}\/$/;
export const productFile = /^products\/p-[A-Za-z0-9_-]{1,200}\/index\.html$/;
export const isSitemap = (path) => /(?:^|\/)sitemap(?:-[A-Za-z0-9_-]+)?\.xml$/.test(path);

export function assertHostingPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 1024 ||
    path.startsWith('/') ||
    /[\\%?#\s]/u.test(path) ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid hosting object path.');
  return path;
}

export function assertOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Invalid site origin.');
  return value;
}

export function readObject(directory, path, maxBytes = limits.fileBytes) {
  assertHostingPath(path);
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Symlink at recovery root.');
  const root = realpathSync(directory);
  let cursor = root;
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink in recovery input: ${path}`);
  }
  const stat = lstatSync(cursor);
  if (!realpathSync(cursor).startsWith(`${root}${sep}`) || !stat.isFile())
    throw new Error(`Not a regular recovery file: ${path}`);
  if (stat.size > maxBytes) throw new Error(`Input byte limit exceeded: ${path}`);
  const fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error(`Recovery file changed during open: ${path}`);
    if (opened.size > maxBytes) throw new Error(`Input byte limit exceeded: ${path}`);
    const body = readFileSync(fd);
    if (body.length > maxBytes) throw new Error(`Input byte limit exceeded: ${path}`);
    return body;
  } finally {
    closeSync(fd);
  }
}

export function readJson(directory, path, maxBytes = limits.jsonBytes) {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readObject(directory, path, maxBytes)),
    );
  } catch (cause) {
    throw new Error(`Invalid JSON manifest: ${path}: ${cause.message}`, { cause });
  }
}

export function checkEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > limits.files)
    throw new Error('Invalid inventory file count limit.');
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    assertHostingPath(entry.path);
    if (
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !isHash(entry.sha256)
    )
      throw new Error('Invalid or duplicate recovery entry.');
    seen.add(entry.path);
    total += entry.bytes;
    if (entry.bytes > limits.fileBytes || total > limits.totalBytes)
      throw new Error('Recovery byte limit exceeded.');
  }
}

// Canonical JSON gives identities stable across object key insertion order.
export function identity(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return sha256(JSON.stringify(sort(value)));
}

export function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
