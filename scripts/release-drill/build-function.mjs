import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFunctionArchive } from '../release/function-archive.mjs';
const adminRequire = createRequire(
  new URL('../../apps/functions/admin/package.json', import.meta.url),
);
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
/** Standalone Node 20 bundle. The deployed function never installs packages or uses workspace files. */
export async function buildLiveDummyFunction({ directory, version, codeSha }) {
  if (!['A', 'B'].includes(version) || !/^[a-f0-9]{40}$/.test(codeSha))
    throw Error('Explicit drill program identity required');
  await mkdir(directory, { recursive: false });
  if ((await readdir(directory)).length) throw Error('Fresh drill output required');
  const configuration = { purpose: 'channel-recovery-dummy-v1', version, codeSha };
  const entry = join(directory, 'source.mjs');
  const handler = fileURLToPath(new URL('./handler.mjs', import.meta.url));
  const record = fileURLToPath(new URL('./record.mjs', import.meta.url));
  await writeFile(
    entry,
    `import cloudbase from '@cloudbase/node-sdk';
import {createDummyDatabaseHandler} from ${JSON.stringify(handler)};
import {dummyMain} from ${JSON.stringify(record)};
const configuration=${JSON.stringify(configuration)};
let handle;
export const applyRecord=(event)=>dummyMain(event,configuration);
export const main=(event)=>{
 handle??=createDummyDatabaseHandler({
  db:cloudbase.init({env:'diversity-123-d9grnqfux221323bb'}).database(),
  envId:process.env.TCB_ENV,
  runId:process.env.DUMMY_RUN_ID,
  tokenDigest:process.env.DUMMY_TOKEN_DIGEST,
  version:configuration.version,codeSha:configuration.codeSha
 });
 return handle(event);
};`,
    { flag: 'wx' },
  );
  const { build } = adminRequire('tsup');
  const output = join(directory, 'bundle');
  await build({
    entry: { index: entry },
    outDir: output,
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    bundle: true,
    minify: true,
    sourcemap: false,
    clean: true,
    config: false,
    silent: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.alias = { '@cloudbase/node-sdk': dbRequire.resolve('@cloudbase/node-sdk') };
    },
  });
  const source = await readFile(join(output, 'index.cjs'));
  const bytes = execFileSync(
    'python3',
    [
      '-c',
      `import io,json,sys,zipfile
files=json.load(sys.stdin);out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for name,body in files.items():
  item=zipfile.ZipInfo(name,(2026,1,1,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED;item.external_attr=0o100644<<16;z.writestr(item,body)
sys.stdout.buffer.write(out.getvalue())`,
    ],
    {
      input: JSON.stringify({
        'index.js': source.toString(),
        'package.json': JSON.stringify({
          name: 'seo-release-dummy',
          main: 'index.js',
          dependencies: {},
        }),
      }),
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  checkFunctionArchive(bytes, { smoke: true });
  const packagePath = resolve(directory, 'function.zip');
  await writeFile(packagePath, bytes, { flag: 'wx' });
  return { bytes, packagePath };
}
