import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
test('cloud tool callers declare the MCP client directly and use their own frozen npm installation before cloud access', () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('tools/cloud-handoff/package.json', root)));
  const lock = JSON.parse(readFileSync(new URL('tools/cloud-handoff/package-lock.json', root)));
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.32.1');
  assert.equal(lock.packages[''].dependencies['@modelcontextprotocol/sdk'], '1.32.1');
  assert.equal(lock.packages['node_modules/@modelcontextprotocol/sdk'].version, '1.32.1');
  for (const name of ['seo-blog-server', 'seo-blog-server-stage', 'seo-blog-server-route']) {
    const workflow = parse(readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8'));
    const job = Object.values(workflow.jobs)[0];
    const install = job.steps.findIndex(
      (s) => s.run === 'npm ci --prefix tools/cloud-handoff --ignore-scripts --no-audit --no-fund',
    );
    const check = job.steps.findIndex(
      (s) => s.run === 'node tools/cloud-handoff/check-runtime.mjs',
    );
    assert(install >= 0 && check > install);
    assert(!job.steps.some((s) => s.run?.includes('pnpm --dir tools/cloud-handoff install')));
    const cloud = job.steps.findIndex((s) =>
      ['node scripts/blog/stage-server.mjs', 'node scripts/blog/route-server.mjs'].includes(s.run),
    );
    if (cloud >= 0) assert(cloud > check);
  }
});
