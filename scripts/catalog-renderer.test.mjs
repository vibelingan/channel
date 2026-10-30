import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packCatalogRenderer, verifyCatalogRenderer } from './release/catalog-renderer.mjs';
import { sha256 } from './release/input.mjs';

// A real Git object database proves that dirty files and untracked secrets stay outside the package.
test('renderer archive is deterministic, pinned and excludes local changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'renderer-source-'));
  const git = (args) =>
    execFileSync('git', args, {
      cwd: directory,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    });
  try {
    git(['init', '-q']);
    writeFileSync(
      join(directory, 'package.json'),
      '{"name":"fixture","packageManager":"pnpm@11.5.0"}',
    );
    writeFileSync(join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    for (const path of ['apps/site', 'packages', 'scripts']) {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, 'fixture.txt'), 'fixture');
    }
    for (const file of ['pnpm-workspace.yaml', 'tsconfig.base.json', 'biome.json'])
      writeFileSync(join(directory, file), '{}');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    const codeSha = git(['rev-parse', 'HEAD']).toString().trim();
    writeFileSync(join(directory, '.env'), 'PRIVATE_SENTINEL_DO_NOT_PACKAGE');
    writeFileSync(join(directory, 'package.json'), 'DIRTY_SENTINEL_DO_NOT_PACKAGE');
    const a = packCatalogRenderer({ codeSha, directory: join(directory, 'a'), git });
    const b = packCatalogRenderer({ codeSha, directory: join(directory, 'b'), git });
    const archive = readFileSync(join(directory, 'a/renderer.tar.gz'));
    assert.deepEqual(a, b);
    assert.deepEqual(archive, readFileSync(join(directory, 'b/renderer.tar.gz')));
    const approved = {
      codeSha,
      manifestSha256: sha256(JSON.stringify(a)),
      archiveSha256: a.archive.sha256,
      archiveObject: {
        fileID: `cloud://fixture.bucket/seo-recovery/objects/${a.archive.sha256}.bin`,
      },
    };
    assert.equal(verifyCatalogRenderer({ manifest: a, approved, archive }).codeSha, codeSha);
    assert.throws(
      () =>
        verifyCatalogRenderer({
          manifest: a,
          approved,
          archive: Buffer.concat([archive, Buffer.from('x')]),
        }),
      /damaged/,
    );
    assert.throws(
      () => verifyCatalogRenderer({ manifest: { ...a, inputSchema: 2 }, approved, archive }),
      /Unsupported/,
    );
    assert.throws(
      () =>
        verifyCatalogRenderer({
          manifest: a,
          approved: { ...approved, codeSha: '0'.repeat(40) },
          archive,
        }),
      /approved/,
    );
    assert.throws(
      () => packCatalogRenderer({ codeSha: 'HEAD', directory: join(directory, 'c'), git }),
      /Exact/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
