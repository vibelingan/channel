import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../release/input.mjs';
import { validateBlogArtifactSource } from './github-source.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';
export function blogGh(args, json = true) {
  const value = execFileSync('gh', args, {
    timeout: 60000,
    maxBuffer: 73 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return json ? JSON.parse(value.toString('utf8')) : value;
}
export function downloadAcceptedBlogArtifact(artifactId, directory, acceptedRunId) {
  if (!/^[1-9][0-9]*$/.test(String(artifactId)) || !/^[1-9][0-9]*$/.test(String(acceptedRunId)))
    throw new Error('Exact accepted source required');
  const metadata = () => {
    const artifact = blogGh(['api', `repos/${policy.repository}/actions/artifacts/${artifactId}`]);
    const match = /^blog-dummy-payload-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(artifact.name);
    if (!match || String(artifact.id) !== String(artifactId) || match[1] !== acceptedRunId)
      throw new Error('Accepted artifact identity mismatch');
    const run = blogGh([
      'api',
      `repos/${policy.repository}/actions/runs/${match[1]}/attempts/${match[2]}`,
    ]);
    return {
      run: validateBlogArtifactSource(artifact, run, { acceptedRunId }),
      digest: artifact.digest,
    };
  };
  const source = metadata();
  const bytes = blogGh(
    ['api', `repos/${policy.repository}/actions/artifacts/${artifactId}/zip`],
    false,
  );
  if (`sha256:${sha256(bytes)}` !== source.digest)
    throw new Error('Accepted archive digest mismatch');
  const temporary = mkdtempSync(join(tmpdir(), 'blog-confirm-archive-'));
  try {
    const file = join(temporary, 'payload.zip');
    writeFileSync(file, bytes, { mode: 0o600 });
    execFileSync(
      'python3',
      [fileURLToPath(new URL('./extract-payload.py', import.meta.url)), file, directory],
      { timeout: 15000, stdio: 'pipe' },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  metadata();
  return source.run;
}
