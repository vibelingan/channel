/**
 * Commercial commitments the model is never given the chance to make.
 *
 * WHY THIS EXISTS, after four rounds of the wrong approach. The evaluator kept
 * trying to detect a bad ANSWER — did the model promise a price, a discount, a
 * delivery date, a certification? Every version was defeated by paraphrase,
 * because natural language has unbounded ways to assert the same proposition:
 *
 *   "Our facilities maintain ISO 9001 and IATF 16949 certification."
 *   "Shipping to Brazil by next Friday is confirmed."
 *   "For 1000 units, that's twelve dollars apiece."
 *   "A forty percent reduction is approved for 5000 units."
 *
 * A finite pattern list cannot cover an infinite space, and each round of
 * additions made the check look more capable while remaining a surface-form
 * oracle. ADR-002 §4 already said where this belongs: the rule that stops the
 * assistant inventing a price must live in code we review, not in a model's
 * disposition.
 *
 * So the model does not answer these at all. When a question asks for a
 * commercial commitment, the BFF returns a fixed template and never calls the
 * engine. There is no generated text to paraphrase, and the evaluator checks a
 * structured outcome rather than parsing prose.
 *
 * WHAT THIS IS NOT: complete. Detection is on the ASK side and is itself
 * pattern-based, so an unusual phrasing can still reach the model. That is
 * bounded rather than unbounded: an undetected ask falls back to the grounded
 * assistant, which has no prices in its corpus and refuses on its own. The
 * template converts "usually refuses" into "cannot do otherwise" for the asks
 * we recognise, and every recognised ask is covered by a fixture.
 */

/** The four outcomes a stranger must never receive from a model. */
export type CommitmentTopic = 'pricing' | 'discount' | 'delivery-date' | 'certification';

export interface CommitmentPolicy {
  topic: CommitmentTopic;
  /** The exact text returned. Fixed, so it can be asserted rather than parsed. */
  template: string;
}

/**
 * Templates are deliberately plain, first-person, and end with the same route
 * back to a human. They are the assistant's whole answer for these topics.
 */
const TEMPLATES: Record<CommitmentTopic, string> = {
  pricing:
    'We don’t publish prices here — every quote depends on specification, ' +
    'finish, packaging and volume. Send us an inquiry with your requirements ' +
    'and a member of our sales team will price it for you directly.',
  discount:
    'Discounts aren’t something I can agree to — pricing and terms are handled ' +
    'by our sales team. Send us an inquiry with your quantity and ' +
    'specification and they’ll come back to you with a quote.',
  'delivery-date':
    'I can’t commit to a delivery date here — it depends on the product, the ' +
    'order quantity and current production scheduling. Send us an inquiry with ' +
    'what you need and by when, and our team will confirm what’s achievable.',
  certification:
    'I don’t have our certification details to hand to confirm here. Send us ' +
    'an inquiry and our team will send you the current certificates and their ' +
    'validity directly.',
};

/**
 * Question shapes that ask for a commitment.
 *
 * Ordered by consequence: a question about a discounted price is refused as
 * pricing either way, so overlap is harmless. Deliberately NOT matching bare
 * "how long" or "how much" without a commercial object, because "how long have
 * you been in business" and "how much experience" are ordinary questions the
 * website answers.
 */
const ASKS: readonly (readonly [CommitmentTopic, RegExp])[] = [
  [
    'discount',
    /\b(?:discount|% ?off|percent off|cheaper|reduce the price|lower the price|best price|beat (?:that|this) price|negotiat\w*|deal on|do better(?: on)?|come down on)\b/i,
  ],
  [
    'pricing',
    /\b(?:price|pricing|prices|cost|costs|quote|quotation|how much (?:do|does|is|are|would|will|for)|per[- ]unit|unit price|usd|\$\s?\d|price list|rate card)\b/i,
  ],
  [
    'delivery-date',
    /\b(?:lead time|delivery date|deliver(?:y|ed)? by|ship by|shipped by|arrive by|when (?:can|will|would) (?:you|it|we)|how soon|by (?:next |this )?\w+day|turnaround)\b/i,
  ],
  [
    'certification',
    /\b(?:iso ?\d{4,5}|iatf ?\d{4,5}|ce mark|rohs|reach|fcc|ul listed|certificat\w*|certified|compliance certificate)\b/i,
  ],
];

/**
 * Does this question ask for a commercial commitment?
 *
 * Returns the policy to apply, or `null` to let the grounded assistant answer.
 */
export function classifyCommitmentRequest(message: string): CommitmentPolicy | null {
  if (typeof message !== 'string' || message.trim().length === 0) return null;
  for (const [topic, pattern] of ASKS) {
    if (pattern.test(message)) return { topic, template: TEMPLATES[topic] };
  }
  return null;
}

/** Exposed so tests and the evaluator can assert the exact text. */
export function templateFor(topic: CommitmentTopic): string {
  return TEMPLATES[topic];
}

export const COMMITMENT_TOPICS: readonly CommitmentTopic[] = [
  'pricing',
  'discount',
  'delivery-date',
  'certification',
];
