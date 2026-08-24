/**
 * The answer-side gate: a commitment the corpus does not support never reaches
 * the visitor, however the question was phrased.
 *
 * WHY ASK-SIDE INTERCEPTION WAS NOT ENOUGH. `commitments.ts` recognises a
 * commercial request and answers it from a template without calling the model.
 * That is useful, but its boundary is a request pattern, and eight ordinary
 * paraphrases walked straight past it —
 *
 *   "What amount would I pay for each piece?"
 *   "Could you guarantee arrival before Friday?"
 *   "Which quality standards has your factory passed?"
 *   "Can you knock forty points off?"
 *
 * — reaching the model with the authority the design claimed it no longer had.
 * Recognising intent is unbounded in exactly the way recognising phrasing was.
 *
 * THIS GATE IS DIFFERENT IN KIND. It does not try to understand the answer. It
 * extracts the CONCRETE VALUES a commitment must contain — a money amount, a
 * percentage, a quantity-bearing figure, a weekday, a certification identifier —
 * and requires each to appear in the retrieved sources. A commitment with no
 * such value is not a commitment; one with a value the corpus does not contain
 * is invented, whatever sentence surrounds it.
 *
 * "For 1000 units, that's twelve dollars apiece" and "the unit price is $12"
 * are unboundedly different sentences carrying the same ungrounded number, and
 * both fail the same way.
 */

import type { EngineCitation } from '@vibelingan-channel/ai-engine';

/** Spelled-out numbers, so "forty percent" is the same claim as "40%". */
const WORD_NUMBERS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * A value that, if asserted, is a commercial commitment.
 *
 * Kinds are recorded so the refusal can name the right topic rather than a
 * generic apology.
 */
export interface CommitmentValue {
  kind: 'money' | 'percentage' | 'date' | 'certification';
  /** Normalised for comparison — lower-cased, digits rather than words. */
  token: string;
}

function normalise(text: string): string {
  let out = String(text ?? '').toLowerCase();
  for (const [word, digits] of Object.entries(WORD_NUMBERS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), digits);
  }
  // Certification identifiers are written both ways — "ISO 9001" in the corpus,
  // "ISO9001" in an answer — so the space is closed on BOTH sides. Comparing a
  // closed-up token against a spaced context was reporting a grounded
  // certification as invented.
  out = out.replace(/\b(iso|iatf|ce|rohs|reach|fcc|ul)\s+(\d{3,5})\b/g, '$1$2');
  return out;
}

/**
 * Every value in `text` that would constitute a commitment.
 *
 * Deliberately narrow. A number that is not money, a percentage, a date or a
 * certification — "we have 8 production lines" — is an ordinary fact and is
 * left to the grounding the corpus already provides.
 */
export function commitmentValues(text: string): CommitmentValue[] {
  const normalised = normalise(String(text ?? ''));
  const values: CommitmentValue[] = [];

  for (const match of normalised.matchAll(
    /\$\s?(\d[\d,.]*)|\b(\d[\d,.]*)\s?(?:usd|dollars?|eur|rmb|cny)\b/g,
  )) {
    values.push({ kind: 'money', token: (match[1] ?? match[2] ?? '').replace(/[,.]$/, '') });
  }
  // `%` is not a word character, so a trailing \b after it never matches and
  // "40%" was silently not a percentage at all.
  for (const match of normalised.matchAll(
    /\b(\d[\d,.]*)\s?%|\b(\d[\d,.]*)\s?(?:percent|points off)\b/g,
  )) {
    values.push({ kind: 'percentage', token: (match[1] ?? match[2] ?? '').replace(/[,.]$/, '') });
  }
  for (const day of WEEKDAYS) {
    if (new RegExp(`\\b${day}\\b`).test(normalised)) values.push({ kind: 'date', token: day });
  }
  for (const match of normalised.matchAll(/\b(iso|iatf|ce|rohs|reach|fcc|ul)\s?(\d{3,5})?\b/g)) {
    values.push({ kind: 'certification', token: `${match[1]}${match[2] ?? ''}` });
  }

  // De-duplicate, keeping the first kind seen for each token.
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}:${value.token}`;
    if (!value.token || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Values the answer asserts that the retrieved sources do not support.
 *
 * The comparison is on the normalised token, so "twelve dollars" is checked
 * against a corpus containing "$12" and vice versa.
 */
export function ungroundedCommitments(
  answer: string,
  citations: readonly EngineCitation[],
): CommitmentValue[] {
  const context = normalise(
    citations.map((citation) => `${citation.title} ${citation.snippet ?? ''}`).join(' \n '),
  );
  return commitmentValues(answer).filter((value) => !context.includes(value.token));
}

/** Which template best answers a refusal caused by these values. */
export function topicForCommitments(
  values: readonly CommitmentValue[],
): 'pricing' | 'discount' | 'delivery-date' | 'certification' {
  if (values.some((value) => value.kind === 'percentage')) return 'discount';
  if (values.some((value) => value.kind === 'money')) return 'pricing';
  if (values.some((value) => value.kind === 'date')) return 'delivery-date';
  return 'certification';
}
