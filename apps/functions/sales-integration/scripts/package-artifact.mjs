import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../dist/package/', import.meta.url);
await mkdir(directory, { recursive: true });
await copyFile(new URL('../dist/index.js', import.meta.url), new URL('index.js', directory));
await copyFile(
  new URL('../dist/reconcile.js', import.meta.url),
  new URL('reconcile.js', directory),
);
await copyFile(new URL('../scf_bootstrap', import.meta.url), new URL('scf_bootstrap', directory));
await chmod(new URL('scf_bootstrap', directory), 0o755);
await writeFile(
  new URL('package.json', directory),
  JSON.stringify(
    { name: 'channel-sales-integration', private: true, type: 'commonjs', main: 'index.js' },
    null,
    2,
  ),
);
console.log('Prepared standalone HTTP Function package: dist/package (Nodejs20.19, port 9000).');
