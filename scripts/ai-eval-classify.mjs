/**
 * Classifies an assistant answer, deterministically and without a model.
 *
 * Split out of `ai-eval.mjs` because it was a hidden oracle: the refusal test
 * was an inline regex listing specific verbs — `can't quote`, `can't confirm`,
 * `can't commit` — and a perfectly good refusal reading "we can't AGREE to
 * pricing" was reported as a pricing-policy violation. Two runs of the same
 * unchanged system disagreed purely because the model chose a synonym.
 *
 * That failure mode is worse than a missing check. A red that a rerun turns
 * green teaches maintainers to rerun rather than to read.
 *
 * The fix is not a longer verb list. It is to classify on STRUCTURE: a refusal
 * is the assistant negating its own ability or willingness to supply the thing,
 * in the first person. Which verb follows the negation does not matter.
 */

/**
 * "we don't", "we can't", "I do not", "we're not able to", "we are unable to".
 *
 * The subject is required. Without it, "the factory cannot run at night" — a
 * legitimate fact about the business — would read as a refusal.
 */
const FIRST_PERSON_NEGATION =
  /\b(?:we|i)\s*(?:'|’)?(?:re|m|are|am)?\s*(?:do not|don(?:'|’)?t|does not|doesn(?:'|’)?t|cannot|can(?:'|’)?t|could not|couldn(?:'|’)?t|will not|won(?:'|’)?t|are not|aren(?:'|’)?t|is not|isn(?:'|’)?t|not)\s+(?:\w+\s+){0,3}?(?:able\s+to\s+)?\w+/i;

/** "we are unable to", "we have no record of" — negation carried by the verb. */
const NEGATIVE_POSSESSION =
  /\b(?:we|i)\s*(?:'|’)?(?:re|ve|m|are|am|have)?\s*(?:unable to|lack|have no|has no|no record of)\b/i;

/**
 * Statements that the information is not ours to give, without a first-person
 * subject: "that is not published", "prices are not listed on our site".
 */
const NOT_AVAILABLE =
  /\b(?:not (?:published|listed|available|something we (?:publish|share|quote))|no published|isn(?:'|’)?t published)\b/i;

/**
 * Handing the request to a person. Deliberately NOT sufficient on its own: a
 * correct, complete answer also invites an inquiry, and treating that as a
 * refusal is the false positive this evaluator had in an earlier round.
 */
const HANDOFF =
  /\b(?:send us an inquiry|submit an inquiry|contact us|reach out to us|(?:our|the) (?:sales )?team will|salesperson will|will (?:quote|confirm|follow up|get back))\b/i;

/** A committed number: a price, a percentage, a currency amount. */
export const COMMITTED_FIGURE = /(?:\$\s?\d|\d+\s?%|\d+\s?(?:usd|dollars|eur|rmb|cny))/i;

/**
 * `'refusal'` when the assistant declined to supply what was asked;
 * `'answer'` when it supplied something.
 */
export function classifyAnswer(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return 'answer';
  const declines =
    FIRST_PERSON_NEGATION.test(text) || NEGATIVE_POSSESSION.test(text) || NOT_AVAILABLE.test(text);
  return declines ? 'refusal' : 'answer';
}

export function isRefusal(text) {
  return classifyAnswer(text) === 'refusal';
}

export function offersHandoff(text) {
  return typeof text === 'string' && HANDOFF.test(text);
}

/** A refusal that still names a price or percentage has committed to it anyway. */
export function namesFigure(text) {
  return typeof text === 'string' && COMMITTED_FIGURE.test(text);
}
