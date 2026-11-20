import { createBlogGithubSource } from '../blog/github-source.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { createGithubReadClient } from './github-read.mjs';
import { normalizePolicy } from './ledger.mjs';
import { requireSiteChecks } from './site-checks.mjs';
import { siteArtifact } from './site-payload.mjs';
import { SITE_DELIVERY_POLICY as policy } from './site-policy.mjs';
import { siteProducerPolicy } from './site-producers.mjs';
import { assertJournaledSiteCandidate } from './site-recovery.mjs';
export function createSiteGithubSource({
  token,
  request = fetchFully,
  retention = /** @type {null|{download:(id:string,directory:string)=>Promise<any>}} */ (null),
}) {
  const api = createGithubReadClient({ policy, token, ...(request ? { request } : {}) });
  const archives = createBlogGithubSource({
    token,
    ...(request ? { request } : {}),
    sourcePolicy: policy,
    artifactPrefixes: ['site-baseline', 'site-payload'],
    producerPolicy: (run) => siteProducerPolicy(policy, run),
    maxArchiveBytes: 512 * 1024 * 1024,
    extractor: new URL('./extract-site-payload.py', import.meta.url),
  });
  const source = {
    requireCI: (codeSha, context) => requireSiteChecks({ github: api, policy, codeSha, context }),
    async downloadFailed(run, directory, dirtyRunId) {
      if (
        run?.runId !== dirtyRunId ||
        run.state !== 'FAILED' ||
        run.accepted ||
        run.targetId !== normalizePolicy(policy).targetId ||
        run.scopeKey !== 'site'
      )
        throw Error('Exact failed site ledger record required');
      const artifact = run.composition.static.artifact;
      const metadata = await source.download(artifact.artifactId, directory, {
        acceptedRunId: artifact.runId,
      });
      const input = siteArtifact({
        directory,
        policy,
        run: metadata,
        retainedProof: metadata.retainedProof ?? null,
      });
      assertJournaledSiteCandidate({ run, input, policy, dirtyRunId });
      return input;
    },
    async download(id, directory, options = {}) {
      if (!/^[1-9][0-9]*$/.test(String(id))) throw Error('Exact static artifact id required');
      const saved = await retention?.download(String(id), directory);
      if (saved) return saved;
      return archives.download(id, directory, options);
    },
  };
  return source;
}
