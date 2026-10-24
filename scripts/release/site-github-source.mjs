import { createBlogGithubSource } from '../blog/github-source.mjs';
import { fetchFully } from '../smoke-http.mjs';
import { createGithubReadClient } from './github-read.mjs';
import { requireSiteChecks } from './site-checks.mjs';
import { SITE_DELIVERY_POLICY as policy } from './site-policy.mjs';
import { siteProducerPolicy } from './site-producers.mjs';
export function createSiteGithubSource({ token, request = fetchFully }) {
  const api = createGithubReadClient({ policy, token, ...(request ? { request } : {}) });
  return {
    requireCI: (codeSha, context) => requireSiteChecks({ github: api, policy, codeSha, context }),
    async download(id, directory, options = {}) {
      if (!/^[1-9][0-9]*$/.test(String(id))) throw Error('Exact static artifact id required');
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
}
