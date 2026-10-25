import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { planReleaseRecovery, planSiteReleaseCandidate } from './hosting-recovery.mjs';
import { fixture, publicFiles, target } from './release-fixtures.mjs';
import { configuration } from './release-hosting-fixtures.mjs';
import { sha256 } from './release/input.mjs';
import { readPublicOutput } from './release/public-output.mjs';
import { assertServerBlogRecoverySource } from './release/site-files.mjs';
import { createSitePayload, siteArtifact } from './release/site-payload.mjs';
const map = '/blog/sitemap.xml';
function files() {
  const result = publicFiles();
  result['sitemap-index.xml'] = result['sitemap-index.xml'].replace(
    '</sitemapindex>',
    `<sitemap><loc>${target.site}${map}</loc></sitemap></sitemapindex>`,
  );
  return result;
}
test('the real parser accepts only explicitly declared dynamic Blog discovery, keeping product consistency checks', (t) => {
  const f = fixture(t, files());
  const read = () =>
    readPublicOutput(f.directory, f.manifest.entries, target.site, ['/products/p-abc/'], [map]);
  assert.equal(read().products.length, 1);
  assert.throws(
    () => readPublicOutput(f.directory, f.manifest.entries, target.site, ['/products/p-abc/']),
    /Missing local sitemap/,
  );
  assert.throws(() =>
    readPublicOutput(
      f.directory,
      f.manifest.entries,
      target.site,
      ['/products/p-abc/'],
      ['/unknown.xml'],
    ),
  );
  assert.throws(
    () => readPublicOutput(f.directory, f.manifest.entries, target.site, [], [map]),
    /withdrawn product/,
  );
  const noReference = fixture(t, publicFiles());
  assert.throws(
    () =>
      readPublicOutput(
        noReference.directory,
        noReference.manifest.entries,
        target.site,
        ['/products/p-abc/'],
        [map],
      ),
    /declared.*not referenced/,
  );
  const stale = fixture(t, { ...files(), 'blog/old/index.html': 'stale article' });
  assert.throws(
    () =>
      readPublicOutput(
        stale.directory,
        stale.manifest.entries,
        target.site,
        ['/products/p-abc/'],
        [map],
      ),
    /Static Blog/,
  );
});
test('a complete server Blog site package carries discovery ownership through candidate and recovery planning', (t) => {
  const f = fixture(t, files());
  const directory = join(f.directory, 'payload');
  const policy = {
    repository: 'fixture/channel',
    envId: target.envId,
    siteOrigin: target.site,
    trustedRef: 'refs/heads/test',
    workflowPath: '.github/workflows/release.yml',
  };
  const body = createSitePayload({
    directory,
    policy,
    configuration: configuration(),
    codeSha: 'a'.repeat(40),
    releaseId: 'server',
    files: new Map(Object.entries(files()).map(([p, b]) => [p, Buffer.from(b)])),
    snapshot: { siteOrigin: target.site },
    blogDelivery: 'server',
  });
  const run = {
    repository: policy.repository,
    workflowPath: policy.workflowPath,
    event: 'workflow_dispatch',
    ref: policy.trustedRef,
    headSha: 'a'.repeat(40),
    runId: '1',
    artifact: {
      id: '2',
      runId: '1',
      expired: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  };
  const source = siteArtifact({ directory, policy, run });
  assert.equal(source.staticManifest.blog.delivery, 'server');
  const candidate = planSiteReleaseCandidate({
    artifactInput: source,
    currentOwnedPaths: [],
    publicProductPaths: ['/products/p-abc/'],
  });
  assert(candidate.uploads.every((e) => e.path !== 'blog/sitemap.xml'));
  const seal = {
    schemaVersion: 1,
    activationId: 'A',
    releaseId: body.releaseId,
    codeSha: body.codeSha,
    target: body.target,
    scope: body.scope,
    artifact: source.envelope.artifact,
  };
  const recovery = planReleaseRecovery({
    artifactInput: { ...source, acceptedSeal: seal },
    currentOwnedPaths: [],
    publicProductPaths: ['/products/p-abc/'],
  });
  assert.equal(recovery.publicOutput.products.length, 1);
  assert.equal(
    sha256(readFileSync(join(directory, 'payload-manifest.json'))),
    source.envelope.artifact.manifestSha256,
  );
});

test('server recovery refuses legacy static article images and pages that could reappear after withdrawal', () => {
  assert.doesNotThrow(() =>
    assertServerBlogRecoverySource({
      staticManifest: { entries: [{ path: 'index.html' }, { path: 'media/company.webp' }] },
    }),
  );
  for (const path of ['blog/old/index.html', `media/articles/article-one/${'a'.repeat(64)}.png`])
    assert.throws(
      () => assertServerBlogRecoverySource({ staticManifest: { entries: [{ path }] } }),
      /Static Blog/,
    );
});
