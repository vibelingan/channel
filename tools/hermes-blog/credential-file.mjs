import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function readPrivateJson(path, maxBytes = 16384) {
  if (typeof path !== 'string' || resolve(path) !== path)
    throw Error('Absolute private path required');
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error('Private file cannot be a symlink');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.size > maxBytes ||
      current.mode & 0o077 ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid())
    )
      throw Error('Owned private file required');
    const bytes = await file.readFile();
    if (bytes.length > maxBytes) throw Error('Private file is too large');
    return {
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await file.close();
  }
}

export async function writePrivateJson(path, value, expectedDigest) {
  if (resolve(path) !== path) throw Error('Absolute private path required');
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    (typeof process.getuid === 'function' && parent.uid !== process.getuid())
  )
    throw Error('Owned private directory required');
  if (expectedDigest !== undefined && (await readPrivateJson(path)).digest !== expectedDigest)
    throw Error('Private configuration changed concurrently');
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (expectedDigest !== undefined && (await readPrivateJson(path)).digest !== expectedDigest)
      throw Error('Private configuration changed concurrently');
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
