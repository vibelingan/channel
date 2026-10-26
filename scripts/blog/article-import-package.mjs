import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkFunctionArchive } from '../release/function-archive.mjs';
/** Package only the independent draft importer. This command cannot connect to CloudBase. */
const sha = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw Error('Explicit CI source identity required');
const directory = resolve('output/article-import-package');
const bundle = readFileSync('apps/functions/article-import/dist/index.cjs', 'utf8');
if (!bundle.includes(sha)) throw Error('Importer bundle source identity differs');
const zip = execFileSync(
  'python3',
  [
    '-c',
    `import io,json,sys,zipfile
files=json.load(sys.stdin);out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for name,body in files.items():z.writestr(name,body)
sys.stdout.buffer.write(out.getvalue())`,
  ],
  {
    input: JSON.stringify({
      'index.js': bundle,
      'package.json': JSON.stringify({
        name: 'channel-article-import',
        main: 'index.js',
        dependencies: {},
      }),
    }),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15000,
  },
);
checkFunctionArchive(zip, { smoke: true });
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'function.zip'), zip, { flag: 'wx' });
const manifest = {
  schemaVersion: 1,
  purpose: 'article-import-function',
  codeSha: sha,
  apiContract: 'article-drafts-v1',
  envId: 'diversity-123-d9grnqfux221323bb',
  functionName: 'article-import',
  runtime: 'Nodejs20.19',
  handler: 'index.main',
  bytes: zip.length,
  sha256: createHash('sha256').update(zip).digest('hex'),
};
writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
console.log(JSON.stringify(manifest));
