#!/usr/bin/env node
/**
 * Answer-quality check for the assistant.
 *
 * Not a unit test: it calls a real model, so it is not deterministic and it is
 * not wired into CI. It exists because the failures that matter here — an
 * invented price, the wrong voice, a leaked retrieval mechanism — are invisible
 * to type-checking and only show up when you read actual answers.
 *
 * Run it after changing the answer policy or the corpus.
 *
 *   node scripts/ai-eval.mjs            # defaults to the compose stack
 */

import { CASES, evaluateCase } from './ai-eval-cases.mjs';

const baseIndex = process.argv.indexOf('--base');
// Must match the port docker-compose.ai.yml publishes for ai-bff.
// scripts/compose-ports.test.mjs fails if these drift apart again.
const base = (baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://localhost:58080').replace(
  /\/+$/,
  '',
);

/**
 * `expect: 'answer'` — the corpus contains this, so a refusal is a miss.
 * `expect: 'refuse'` — the corpus does NOT contain it, and answering anyway is
 * the commercially dangerous failure this product must not have.
 */

/** Phrases that mean the assistant broke character or leaked its plumbing. */
const LEAKS = [
  /based on the (information|context) provided/i,
  /the (context|documents?) (does not|do not|doesn't|don't)/i,
  /in (my|our|the) (current )?context/i,
  /(retrieved|knowledge base|vector|embedding)/i,
  /<\/?think>/i,
];
/** Third-person self-reference: the assistant talking about its own company. */
const THIRD_PERSON = [
  /contact (them|their)/i,
  /their (sales|team|website|factory)/i,
  /Diversity Technology (Limited )?(offers|provides|has|is a)/i,
];

async function ask(message) {
  const res = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const citations = [];
  let failure = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf('\n\n');
      if (cut === -1) break;
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === 'token') text += event.text;
      if (event.type === 'citation') citations.push(event.citation);
      if (event.type === 'error') failure = event.category;
    }
  }
  return { text: text.trim(), citations, failure };
}

let failures = 0;
for (const testCase of CASES) {
  process.stdout.write(`\n▸ ${testCase.q}\n`);
  let result;
  try {
    result = await ask(testCase.q);
  } catch (error) {
    console.log(`   FAIL  request failed: ${error.message}`);
    failures++;
    continue;
  }
  console.log(`   ${result.text.replace(/\n+/g, ' ').slice(0, 220)}`);

  // The decision lives in ai-eval-cases.mjs and is unit-tested there against
  // every sentence that defeated an earlier version. This script only does I/O.
  const problems = evaluateCase(testCase, result);

  if (problems.length === 0) {
    console.log(`   ok    (${result.citations.length} source(s))`);
  } else {
    for (const problem of problems) console.log(`   FAIL  ${problem}`);
    failures += problems.length;
  }
}

console.log(`\n${failures === 0 ? 'all cases passed' : `${failures} problem(s) found`}`);
process.exit(failures === 0 ? 0 : 1);
