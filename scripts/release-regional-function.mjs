import cloudbase from '@cloudbase/node-sdk';
import { createReleaseRegionalHandler } from './release/regional-coordinator.mjs';
import { SITE_DELIVERY_POLICY } from './release/site-policy.mjs';

/** Private Event function: its only effects are the existing release ledger and RPC receipts. */
export async function main(event) {
  const env = process.env;
  if (
    env.RELEASE_REGIONAL_SITE_ORIGIN !== SITE_DELIVERY_POLICY.siteOrigin ||
    env.RELEASE_REGIONAL_REPOSITORY !== SITE_DELIVERY_POLICY.repository
  )
    return { ok: false, error: { code: 'RELEASE_REGIONAL_IDENTITY' } };
  const handler = createReleaseRegionalHandler(
    {
      envId: env.TCB_ENV,
      targetId: env.RELEASE_REGIONAL_TARGET_ID,
      ownerRunId: env.RELEASE_REGIONAL_OWNER_RUN_ID,
      runnerRef: env.RELEASE_REGIONAL_RUNNER_REF,
      tokenDigest: env.RELEASE_REGIONAL_TOKEN_DIGEST,
      codeSha: __RELEASE_REGIONAL_SHA__,
    },
    {
      createDatabase: () => cloudbase.init({ env: env.TCB_ENV }).database(),
    },
  );
  return handler(event);
}
