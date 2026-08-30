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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = join(repoRoot, 'apps/ai-bff/policy/public-sales-v1.txt');

const base = process.env.ANYTHINGLLM_LOCAL_ADMIN_URL ?? 'http://127.0.0.1:53001';
const workspace =
  process.env.ANYTHINGLLM_WORKSPACE_SLUG ??
  process.env.ANYTHINGLLM_WORKSPACE ??
  'channel-public-assistant';
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

/**
 * Apply, then READ BACK and compare.
 *
 * HTTP 200 is not proof a setting was applied. This engine accepts unknown
 * fields and returns success — the same behaviour that made `max_tokens` look
 * like it worked when it was ignored entirely. A policy that silently failed to
 * apply is the worst case here: the assistant keeps answering, with the old
 * rules, and nothing says so.
 */
function hash(value) {
  return createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 12);
}

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

await api(`/api/v1/workspace/${workspace}/update`, {
  method: 'POST',
  body: JSON.stringify(settings),
});

const readBack = await api(`/api/v1/workspace/${workspace}`);
const applied = readBack.workspace?.[0] ?? {};

/**
 * Compared field by field. The policy text is compared by hash rather than
 * printed: it is long, and a diff of the whole prompt in a terminal buries the
 * one line that changed.
 */
const CHECKS = [
  ['chatMode', settings.chatMode, applied.chatMode],
  ['openAiTemp', settings.openAiTemp, applied.openAiTemp],
  ['topN', settings.topN, applied.topN],
  ['similarityThreshold', settings.similarityThreshold, applied.similarityThreshold],
  ['queryRefusalResponse', settings.queryRefusalResponse, applied.queryRefusalResponse],
  ['openAiPrompt (sha256)', hash(settings.openAiPrompt), hash(applied.openAiPrompt)],
];

const mismatches = [];
for (const [name, requested, actual] of CHECKS) {
  const same = String(requested) === String(actual);
  console.log(`  ${same ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${String(actual)}`);
  if (!same) mismatches.push(`${name}: asked for ${requested}, engine reports ${actual}`);
}

// The tool surface is not something we set — it is something we require to be
// off, because the run contract permits zero tool calls.
if (applied.agentProvider || applied.agentModel) {
  mismatches.push(
    `an agent surface is enabled (agentProvider=${applied.agentProvider}, agentModel=${applied.agentModel}); the run contract permits zero tool calls`,
  );
}

if (mismatches.length > 0) {
  console.error(`\nthe engine did not apply ${mismatches.length} setting(s):`);
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
  console.error('\nThe assistant is still answering under its previous policy.');
  process.exit(1);
}

console.log(`\nconfigured "${workspace}" and verified every setting by read-back`);
