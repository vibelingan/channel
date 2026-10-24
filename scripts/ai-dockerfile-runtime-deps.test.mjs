/**
 * The AI service images install their runtime dependencies with `pnpm deploy`.
 * pnpm refuses packages downloaded from a URL or git, but its legacy deploy
 * applies that rule to every workspace project, so the website's SheetJS
 * download (packages/catalog-import) failed both AI image builds once the two
 * branches met. The Dockerfiles switch the rule off for that one command and
 * check the runtime that ships instead.
 *
 * These tests keep the switch and the check together, and prove the check
 * matches a package name exactly as pnpm writes a URL download to disk.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** The Dockerfile's pnpm deploy instruction, with its continuation lines joined. */
function deployInstruction(service) {
  const dockerfile = readFileSync(
    new URL(`../apps/${service}/Dockerfile`, import.meta.url),
    'utf8',
  );
  const instructions = dockerfile.replace(/\\\n/g, ' ').split('\n');
  const deploy = instructions.filter(
    (line) => line.startsWith('RUN ') && line.includes(' deploy '),
  );
  assert.equal(deploy.length, 1, `${service}: expected exactly one pnpm deploy instruction`);
  return deploy[0];
}

for (const service of ['ai-bff', 'ai-worker']) {
  test(`${service}: switching off the URL-package rule comes with a check on what ships`, () => {
    const deploy = deployInstruction(service);
    assert.match(deploy, new RegExp(`pnpm --filter @vibelingan-channel/${service} deploy --prod`));
    if (!deploy.includes('--config.block-exotic-subdeps=false')) return;

    assert.match(deploy, /ls \/runtime\/node_modules\/\.pnpm \| grep -E '/);
    assert.match(deploy, /exit 1/);
    const pattern = deploy.match(/grep -E '([^']+)'/)?.[1];
    assert.ok(pattern, `${service}: the rule is off but nothing checks the runtime`);

    const shipsFromUrlOrGit = new RegExp(pattern);
    // The exact directory pnpm created for the website's SheetJS download.
    assert.ok(shipsFromUrlOrGit.test('xlsx@https+++cdn.sheetjs.com+xlsx-0.20.3+xlsx-0.20.3.tgz'));
    assert.ok(shipsFromUrlOrGit.test('left-pad@git+https+++github.com+left-pad+left-pad'));
    // What a service runtime legitimately holds: its workspace code and registry packages.
    assert.ok(!shipsFromUrlOrGit.test('@vibelingan-channel+ai-store@file+packages+ai-store'));
    assert.ok(!shipsFromUrlOrGit.test('pg-connection-string@2.14.0'));
  });
}
