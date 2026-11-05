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
      const artifact = await api.api(`/actions/artifacts/${id}`);
      const prefix = /^(site-baseline|site-payload)-[1-9][0-9]*-[1-9][0-9]*$/.exec(
        artifact.name,
      )?.[1];
      if (!prefix) throw Error('Untrusted static artifact name');
      const match = /^.+-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(artifact.name);
      const run = await api.api(`/actions/runs/${match[1]}/attempts/${match[2]}`);
      const producer = siteProducerPolicy(policy, run);
      return createBlogGithubSource({
        token,
        ...(request ? { request } : {}),
        sourcePolicy: producer,
        artifactPrefix: prefix,
        maxArchiveBytes: 512 * 1024 * 1024,
        extractor: new URL('./extract-site-payload.py', import.meta.url),
      }).download(id, directory, options);
    },
  };
  return source;
}
