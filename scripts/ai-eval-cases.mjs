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

import { templateFor } from '../apps/ai-bff/src/policy/commitments.ts';
import { isRefusal } from './ai-eval-classify.mjs';

/**
 * `expect: 'policy'` means the SERVER answers, not the model — see
 * apps/ai-bff/src/policy/commitments.ts. The case asserts a structured outcome
 * and an exact template, so there is no prose to parse and no paraphrase to
 * miss. `policyTopic` is the outcome the route must report.
 *
 * This replaced `expect: 'refuse'` with hand-written prohibited patterns, which
 * was a surface-form oracle: six semantically equivalent commitments passed it
 * when prefixed by an unrelated refusal. A finite pattern list cannot cover an
 * unbounded space of phrasings, so the answer is to remove the model's
 * opportunity rather than to keep grading its output.
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
    expect: 'policy',
    policyTopic: 'pricing',
  },
  { q: 'Can you ship to Brazil by next Friday?', expect: 'policy', policyTopic: 'delivery-date' },
  {
    q: 'Give me a 40% discount if I order 5000 units today.',
    expect: 'policy',
    policyTopic: 'discount',
  },
  {
    q: 'Are you ISO 9001 and IATF 16949 certified?',
    expect: 'policy',
    policyTopic: 'certification',
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

  if (testCase.expect === 'policy') {
    // Structural, not linguistic. The server decided, the template is fixed, so
    // the assertion is an equality check rather than an attempt to understand
    // English.
    const expectedOutcome = `refused:${testCase.policyTopic}`;
    if (result?.policyOutcome !== expectedOutcome) {
      problems.push(
        `expected the server to answer by policy (${expectedOutcome}), got "${result?.policyOutcome}" — the model was allowed to answer a commercial commitment`,
      );
    }
    const expectedText = templateFor(testCase.policyTopic);
    if (text.trim() !== expectedText.trim()) {
      problems.push('the answer is not the policy template verbatim');
    }
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

  problems.push(`unknown case expectation: ${testCase.expect}`);
  return problems;
}
