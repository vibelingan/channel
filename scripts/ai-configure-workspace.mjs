#!/usr/bin/env node
/**
 * Apply the assistant's answer policy and retrieval settings to its workspace.
 *
 * The policy text lives in `apps/ai-bff/policy/` rather than in a vendor
 * console: it is the rule that stops the assistant inventing a price, so it
 * belongs in review and in git history like any other load-bearing code.
 *
 * ADR-002 §4 is explicit that generation policy should ultimately live in OUR
 * service — retrieve chunks from the engine, apply the policy ourselves, call
 * the model ourselves. That is not built yet, so for now the policy is pushed
 * into the engine's workspace. The file is already in the right place for the
 * move; only the delivery changes.
 *
 *   node scripts/ai-configure-workspace.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = join(repoRoot, 'apps/ai-bff/policy/public-sales-v1.txt');

const base = process.env.ANYTHINGLLM_BASE_URL ?? 'http://localhost:53001';
const workspace = process.env.ANYTHINGLLM_WORKSPACE ?? 'channel-public-assistant';
const key = process.env.ANYTHINGLLM_API_KEY;
if (!key) {
  console.error('ANYTHINGLLM_API_KEY is not set');
  process.exit(1);
}

const settings = {
  openAiPrompt: readFileSync(POLICY_PATH, 'utf8').trim(),
  // Near-deterministic. A sales answer about MOQ should not vary between two
  // customers asking the same question on the same day.
  openAiTemp: 0.1,
  // Retrieval breadth. Four chunks over a corpus this small is generous.
  topN: 4,
  // Below this, a "match" is noise. Kept at the vendor default rather than
  // tuned blind — worth revisiting once there are real questions to measure.
  similarityThreshold: 0.25,
  // Refuse rather than answer from the model's own memory when nothing is
  // retrieved. Answering ungrounded is the failure mode SECURITY.md forbids.
  queryRefusalResponse:
    'I don’t have that in our published information. Send us an inquiry and a member of our team will confirm it for you.',
  chatMode: 'query',
};

const res = await fetch(`${base}/api/v1/workspace/${workspace}/update`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(settings),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.error) {
  console.error(`failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}

const applied = body.workspace ?? {};
console.log(`configured "${workspace}"`);
console.log(`  chatMode            ${applied.chatMode}`);
console.log(`  temperature         ${applied.openAiTemp}`);
console.log(`  topN                ${applied.topN}`);
console.log(`  similarityThreshold ${applied.similarityThreshold}`);
console.log(`  policy              ${String(applied.openAiPrompt ?? '').length} chars`);
