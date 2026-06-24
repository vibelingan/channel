import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const artifactRoot = join(root, '.cloudbase-artifacts', 'functions');
const functions = ['admin', 'public-api'];

rmSync(artifactRoot, { force: true, recursive: true });
mkdirSync(artifactRoot, { recursive: true });

for (const name of functions) {
  const source = join(root, 'apps', 'functions', name, 'dist');
  const target = join(artifactRoot, name);
  const indexFile = join(source, 'index.js');
  if (!existsSync(indexFile)) {
    throw new Error(`Missing built function entry: ${indexFile}. Run pnpm build:functions first.`);
  }

  mkdirSync(target, { recursive: true });
  cpSync(indexFile, join(target, 'index.js'));

  const sourceMap = join(source, 'index.js.map');
  if (existsSync(sourceMap)) cpSync(sourceMap, join(target, 'index.js.map'));

  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(
      {
        name: `channel-${name}`,
        version: '0.1.0',
        private: true,
        main: 'index.js',
        dependencies: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

console.log(`Packaged ${functions.length} functions into ${artifactRoot}`);
