import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runIndexNow } from './release/indexnow.mjs';

const [mode, stateFile, ...extra] = process.argv.slice(2);
if (!['--preview', '--observe', '--apply'].includes(mode) || !stateFile || extra.length)
  throw Error(
    'Usage: node --experimental-strip-types scripts/indexnow.mjs --preview|--observe|--apply <state-file>',
  );
const path = resolve(stateFile);
const submit = mode === '--apply';
const saveObservations = mode !== '--preview';

async function readState() {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.baseline || !state.pending || !Number.isFinite(state.retryAt))
      throw Error('Invalid IndexNow state file');
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function save(state) {
  const temporary = `${path}.${process.pid}.new`;
  await writeFile(temporary, `${JSON.stringify({ ...state, version: 1 })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

let lock;
try {
  if (saveObservations) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    lock = await open(`${path}.lock`, 'wx', 0o600).catch((error) => {
      if (error.code === 'EEXIST') throw Error('Another IndexNow runner holds the state lock');
      throw error;
    });
    await lock.writeFile(`${process.pid}\n`);
  }
  const result = await runIndexNow({
    state: await readState(),
    save,
    key: process.env.INDEXNOW_KEY,
    submit,
    saveObservations,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.indexNowStatus && ![200, 202].includes(result.indexNowStatus)) process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(`${path}.lock`);
  }
}
