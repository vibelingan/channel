import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageCatalogImageDecoder } from './catalog-image-decoder-artifact.mjs';
export function nativeFunctionFixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'catalog-native-fixture-'));
  const directory = join(temporary, 'package');
  mkdirSync(directory);
  let sequence = 0;
  writeFileSync(join(directory, 'index.js'), 'exports.main=async()=>({ok:true});');
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'channel-alibaba-catalog-sync', main: 'index.js', dependencies: {} }),
  );
  packageCatalogImageDecoder(directory, { target: 'linux-x64' });
  const pack = (edits = {}) => {
    const input = join(temporary, `edits-${sequence}.json`);
    const output = join(temporary, `fixture-${sequence++}.zip`);
    writeFileSync(input, JSON.stringify(edits), { flag: 'wx', mode: 0o600 });
    const result = spawnSync(
      'python3',
      [
        '-c',
        "import pathlib,sys,json,zipfile,io\nr=pathlib.Path(sys.argv[1]);edits=json.loads(pathlib.Path(sys.argv[2]).read_text());b=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file():\n   name=p.relative_to(r).as_posix()\n   if name not in edits:z.writestr(name,p.read_bytes())\n for name,data in edits.items():\n  if data is not None:z.writestr(name,data.encode())\npathlib.Path(sys.argv[3]).write_bytes(b.getvalue())",
        directory,
        input,
        output,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 65536 },
    );
    if (result.status !== 0) throw Error('Native fixture packing failed');
    return readFileSync(output);
  };
  return {
    directory,
    pack,
    read: (path) => readFileSync(join(directory, path), 'utf8'),
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}
