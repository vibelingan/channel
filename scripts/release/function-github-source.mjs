import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFully } from '../smoke-http.mjs';
import { createGithubReadClient } from './github-read.mjs';
import { validateArtifactSource } from './github-source.mjs';
import { readJson, readObject, sha256 } from './input.mjs';

/** Authenticate fixed payload/test artifacts; archive contents never choose an executable. */
export function createFunctionGithubSource({ policy, token, request }) {
  const client = createGithubReadClient({ policy, token, request });
  const profiles = {
    payload: { artifactPrefix: 'function-release-payload', maxBytes: 134_217_728 },
    tests: { artifactPrefix: 'function-compatibility-tests', maxBytes: 4_194_304 },
  };
  const metadata = async (id, kind, options = {}) => {
    if (!Object.hasOwn(profiles, kind) || !/^[1-9][0-9]{0,19}$/.test(String(id)))
      throw new Error('Explicit function artifact ID and kind required');
    const artifact = await client.api(`/actions/artifacts/${id}`);
    if (
      String(artifact.id) !== String(id) ||
      !/^[1-9][0-9]*$/.test(String(artifact.workflow_run?.id))
    )
      throw new Error('Function artifact identity mismatch');
    const match = new RegExp(
      `^${profiles[kind].artifactPrefix}-${artifact.workflow_run.id}-([1-9][0-9]*)$`,
    ).exec(artifact.name);
    if (!match) throw new Error('Untrusted function artifact name');
    const run = await client.api(`/actions/runs/${artifact.workflow_run.id}/attempts/${match[1]}`);
    const source = validateArtifactSource({ artifact, run, policy, ...options, ...profiles[kind] });
    return { source, digest: artifact.digest };
  };
  return Object.freeze({
    requireCI: client.requireCI,
    metadata,
    async download(id, directory, kind = 'payload', options = {}) {
      const before = await metadata(id, kind, options);
      const redirect = await client.get(`/actions/artifacts/${id}/zip`, { redirect: 'manual' });
      const location = new URL(redirect.headers.get('location'));
      if (
        redirect.status !== 302 ||
        location.protocol !== 'https:' ||
        location.username ||
        location.password ||
        location.port
      )
        throw new Error('Invalid artifact storage redirect');
      // The signed storage request receives no GitHub credential.
      const zip = await (request ?? fetchFully)('GET', location.href, {
        timeoutMs: 30_000,
        maxBytes: profiles[kind].maxBytes,
        redirect: 'error',
      });
      if (zip.status !== 200 || `sha256:${sha256(zip.body)}` !== before.digest)
        throw new Error('Function artifact ZIP digest mismatch');
      const temp = mkdtempSync(join(tmpdir(), 'function-release-zip-'));
      try {
        const archive = join(temp, 'archive.zip');
        writeFileSync(archive, zip.body, { flag: 'wx', mode: 0o600 });
        execFileSync(
          'python3',
          [
            fileURLToPath(new URL('./extract-function-release.py', import.meta.url)),
            archive,
            directory,
            kind,
          ],
          { timeout: 30_000, stdio: 'pipe' },
        );
      } catch {
        throw new Error('Function artifact extraction failed');
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      const after = await metadata(id, kind, options);
      if (after.digest !== before.digest)
        throw new Error('Function artifact changed during download');
      const path = kind === 'payload' ? 'payload-manifest.json' : 'test-results.json';
      const body = readJson(directory, path);
      const manifestSha256 = sha256(readObject(directory, path));
      if (options.acceptedSeal && options.acceptedSeal.artifact?.manifestSha256 !== manifestSha256)
        throw Error('Accepted recovery manifest differs from its journal seal');
      return {
        directory,
        run: after.source,
        body,
        manifestSha256,
        evidenceSource: {
          verified: true,
          event: after.source.event,
          headSha: after.source.headSha,
          artifactId: after.source.artifact.id,
          manifestSha256,
        },
      };
    },
  });
}
