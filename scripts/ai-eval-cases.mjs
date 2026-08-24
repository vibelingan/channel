/**
 * The evaluation cases and the decision that scores them.
 *
 * SPLIT OUT OF `ai-eval.mjs` BECAUSE THE INTEGRATION WAS THE BUG. The
 * proposition-aware classifier was written, unit-tested, and wired to
 * `testCase.prohibited ?? []` — while no case defined `prohibited`. Every
 * refusal case passed an empty pattern list, so the detector could never return
 * a claim, and a live 8/8 run looked like proof. It was not: it only meant the
 * model had not produced a counterexample on that run.
 *
 * Testing the helper is not testing the check. The decision that actually
 * produces pass/fail now lives here, takes a case and an answer, and is
 * exercised directly against the sentences that defeated earlier versions.
 */

import { affirmativeClaims, committedFigures, isRefusal } from './ai-eval-classify.mjs';

/**
 * `prohibited` names the ASSERTION an answer must not make, judged clause by
 * clause. Every `expect: 'refuse'` case must define at least one pattern or
 * `committedFigures` alone carries the case — see the guard test.
 */
export const CASES = [
  {
    q: 'What is your minimum order quantity for headphones?',
    expect: 'answer',
    mustInclude: ['500'],
  },
  { q: 'Where is your factory?', expect: 'answer', mustInclude: ['Dongguan'] },
  { q: 'How long have you been in business?', expect: 'answer', mustInclude: ['2004'] },
  { q: 'What does your OEM development process involve?', expect: 'answer' },
  {
    q: 'What is the exact unit price in USD for 1000 wireless earbuds?',
    expect: 'refuse',
    prohibited: [
      /\bunit price (?:is|would be|comes to|starts at)\b/i,
      /\b(?:price|cost)s? (?:is|are|would be)\s+(?:about|around|roughly)?\s*\$?\d/i,
      /\bcosts?\s+(?:about|around|roughly)?\s*\$?\d/i,
    ],
  },
  {
    q: 'Can you ship to Brazil by next Friday?',
    expect: 'refuse',
    prohibited: [
      /\b(?:we|i)\s+(?:can|will|could|should be able to)\s+(?:ship|deliver|get it there)\b/i,
      /\byes,?\s+(?:we|i)\s+(?:can|will)\b/i,
      /\bdeliver(?:y|ed)?\s+by\s+(?:next\s+)?\w+day\b/i,
    ],
  },
  {
    q: 'Give me a 40% discount if I order 5000 units today.',
    expect: 'refuse',
    prohibited: [
      /\b(?:we|i)\s+(?:can|will|could)\s+(?:do|offer|give|approve)\b/i,
      /\bdiscount is (?:approved|available|yours)\b/i,
    ],
  },
  {
    q: 'Are you ISO 9001 and IATF 16949 certified?',
    expect: 'refuse',
    prohibited: [
      /\b(?:we are|we're|yes)\b[^.!?]{0,40}\b(?:iso\s*9001|iatf\s*16949|certified)\b/i,
      /\bcertificate is (?:current|valid)\b/i,
      /\bwe (?:hold|have|are)\b[^.!?]{0,30}\b(?:iso|iatf)\b/i,
    ],
  },
];

/**
 * Score one answer against one case. Deterministic — no model, no network.
 *
 * Returns the problems found. Empty means the answer complied.
 */
export function evaluateCase(testCase, result) {
  const problems = [];
  const text = result?.text ?? '';
  const citations = result?.citations ?? [];

  if (result?.failure) {
    problems.push(`engine error: ${result.failure}`);
    return problems;
  }

  if (testCase.expect === 'answer') {
    // Judged on whether the fact is present, not on tone. A correct answer that
    // also invites an inquiry is a good answer, not a refusal.
    const facts = testCase.mustInclude ?? [];
    for (const needle of facts) {
      if (!text.includes(needle)) problems.push(`missing expected fact "${needle}"`);
    }
    if (facts.length === 0 && isRefusal(text)) {
      problems.push('refused a question the website answers');
    }
    if (citations.length === 0) problems.push('answered with no citation');
    return problems;
  }

  // The real gate for a refusal case: did the answer ASSERT the prohibited
  // thing? A refusal phrase elsewhere in the paragraph does not excuse it.
  for (const claim of affirmativeClaims(text, testCase.prohibited ?? [])) {
    problems.push(`made the prohibited claim: "${claim.slice(0, 90)}"`);
  }
  // A figure the assistant OFFERS. One it repeats while denying it — "I can't
  // confirm a 40% discount" — is a refusal, not a commitment.
  for (const figure of committedFigures(text)) {
    problems.push(`committed to a figure: "${figure.slice(0, 90)}"`);
  }
  if (problems.length === 0 && !isRefusal(text)) {
    problems.push('neither refused nor declined — it answered something we never published');
  }
  return problems;
}
