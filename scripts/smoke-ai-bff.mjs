#!/usr/bin/env node
/**
 * Smoke test for the AI BFF. Runs unchanged against local compose, CI, and the
 * deployed CloudRun origin:
 *
 *   node scripts/smoke-ai-bff.mjs --base http://localhost:58080
 */

import { checkHealthAndReadiness, createChecks, getJson, parseArgs } from './smoke-ai-service.mjs';

const { base } = parseArgs(process.argv, 'http://localhost:58080');
const checks = createChecks();
console.log(`smoke: ai-bff @ ${base}\n`);

await checkHealthAndReadiness({
  base,
  healthPath: '/api/ai/healthz',
  readyPath: '/api/ai/readyz',
  checks,
});

// Only the negative CORS direction is asserted. A smoke test cannot know a
// deployed environment's allowlist, but "an origin nobody configured is never
// echoed back" must hold everywhere — and reflecting the caller's origin is the
// actual bug this guards against.
const foreign = 'https://smoke-not-an-allowed-origin.example';
const cors = await getJson(`${base}/api/ai/healthz`, { origin: foreign });
checks.check(
  'an unconfigured origin is not echoed back',
  cors.headers.get('access-control-allow-origin') !== foreign,
  'the server reflected an arbitrary origin, defeating CORS',
);

const missing = await getJson(`${base}/api/ai/nope`);
checks.check('unknown routes return 404', missing.status === 404, `got ${missing.status}`);
checks.check(
  'unknown routes use the shared error envelope',
  missing.json?.ok === false && missing.json?.error?.code === 'NOT_FOUND',
  missing.text.slice(0, 120),
);

checks.finish('ai-bff');
