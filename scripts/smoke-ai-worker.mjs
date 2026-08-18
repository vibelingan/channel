#!/usr/bin/env node
/**
 * Smoke test for the AI worker. Runs unchanged against local compose, CI, and
 * the deployed CloudRun origin:
 *
 *   node scripts/smoke-ai-worker.mjs --base http://localhost:58081
 *
 * The worker has no public routes by design — it exists to hold long-lived
 * engine streams — so its health surface is the whole contract at MIU 2a.
 */

import { checkHealthAndReadiness, createChecks, parseArgs } from './smoke-ai-service.mjs';

const { base } = parseArgs(process.argv, 'http://localhost:58081');
const checks = createChecks();
console.log(`smoke: ai-worker @ ${base}\n`);

await checkHealthAndReadiness({ base, healthPath: '/healthz', readyPath: '/readyz', checks });

checks.finish('ai-worker');
