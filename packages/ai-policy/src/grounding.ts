/**
 * Whether the evidence actually supports a commercial value the answer states.
 *
 * TWO DEFECTS THIS REPLACES, both mine, both found by review rather than by me.
 *
 * 1. TIMING. The first version validated the `final` event while forwarding
 *    every token as it arrived, so "The unit price is $12 each." was rendered
 *    in the browser and *then* replaced. You cannot unsend bytes. Validation
 *    now happens before any answer byte leaves — see `chat.ts`.
 *
 * 2. EVIDENCE. It asked `context.includes(token)` over concatenated citation
 *    text, which is not evidence of anything. All four of these were treated as
 *    support:
 *
 *      "$12 each"                 ← "Founded in 2012."
 *      "40% discount approved"    ← "Capacity is 40,000 units."
 *      "guaranteed Friday"        ← "Office hours Friday: 9 to 5."
 *      "We hold ISO 9001."        ← "We do NOT hold ISO 9001."
 *
 *    A substring is not a claim. Support now requires the source to state a
 *    value of the SAME KIND, in a fragment that is not a denial, and — for
 *    dates — in a fragment that is actually about delivery.
 *
 * WHAT THIS GUARANTEES, exactly, because the previous wording overclaimed:
 * an answer that states a money amount, a percentage, a weekday or a
 * certification identifier which the retrieved sources do not support is
 * replaced before the visitor sees it. It does NOT catch a commitment carrying
 * no such value — "yes, we can do that". That residual is real and R11 stays
 * open for it.
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

/** A source fragment only supports a delivery date if it is about delivery. */
const DELIVERY_CONTEXT =
  /\b(?:ship|ships|shipped|shipping|deliver\w*|dispatch\w*|lead time|arrival|arrives)\b/i;

export type CommitmentKind = 'money' | 'percentage' | 'date' | 'certification';

export interface CommitmentValue {
  kind: CommitmentKind;
  /** Normalised — lower-cased, digits rather than words, no thousands commas. */
  token: string;
}

function normalise(text: string): string {
  let out = String(text ?? '').toLowerCase();
  for (const [word, digits] of Object.entries(WORD_NUMBERS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), digits);
  }
  // "ISO 9001" and "ISO9001" are the same identifier.
  return out.replace(/\b(iso|iatf|ce|rohs|reach|fcc|ul)\s+(\d{3,5})\b/g, '$1$2');
}

/** `40,000` and `40000` are one number; `12.50` keeps its decimal. */
function canonicalNumber(raw: string): string {
  return raw.replace(/,/g, '').replace(/\.$/, '');
}

/**
 * Values in `text` that would constitute a commercial commitment.
 *
 * Narrow on purpose. A bare quantity — "we run 8 production lines" — is an
 * ordinary fact; treating every number as a commitment would block most real
 * answers and train everyone to ignore the gate.
 */
export function commitmentValues(text: string): CommitmentValue[] {
  const normalised = normalise(text);
  const values: CommitmentValue[] = [];

  for (const match of normalised.matchAll(
    /\$\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s?(?:usd|dollars?|eur|rmb|cny)\b/g,
  )) {
    values.push({ kind: 'money', token: canonicalNumber(match[1] ?? match[2] ?? '') });
  }
  // `%` is not a word character, so a trailing \b after it never matches.
  for (const match of normalised.matchAll(
    /\b(\d[\d,]*(?:\.\d+)?)\s?%|\b(\d[\d,]*(?:\.\d+)?)\s?(?:percent|points off)\b/g,
  )) {
    values.push({ kind: 'percentage', token: canonicalNumber(match[1] ?? match[2] ?? '') });
  }
  for (const day of WEEKDAYS) {
    if (new RegExp(`\\b${day}\\b`).test(normalised)) values.push({ kind: 'date', token: day });
  }
  for (const match of normalised.matchAll(/\b(iso|iatf|ce|rohs|reach|fcc|ul)(\d{3,5})\b/g)) {
    values.push({ kind: 'certification', token: `${match[1]}${match[2]}` });
  }

  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}:${value.token}`;
    if (!value.token || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Clause-level split, so a denial governs only what it actually denies. */
function fragments(text: string): string[] {
  return normalise(text)
    .split(/[.!?;:\n]+|,(?=\s)|\s+[-–—]+\s+|\s+(?:but|although|though|however|whereas|yet)\s+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

function isDenial(fragment: string): boolean {
  return /\b(?:not|no|never|none|don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t|isn'?t|aren'?t|unable|without|excluding)\b/i.test(
    fragment,
  );
}

/**
 * Does any source fragment ASSERT this value?
 *
 * The source must state the same kind of value, not merely contain the digits.
 * "Founded in 2012" contains `12` and asserts no price.
 */
function isSupported(value: CommitmentValue, sourceFragments: readonly string[]): boolean {
  return sourceFragments.some((fragment) => {
    // A source that denies something cannot authorise asserting it.
    if (isDenial(fragment)) return false;
    const stated = commitmentValues(fragment);
    const matches = stated.some(
      (candidate) => candidate.kind === value.kind && candidate.token === value.token,
    );
    if (!matches) return false;
    // A weekday in "office hours Friday: 9 to 5" is not a delivery promise.
    if (value.kind === 'date') return DELIVERY_CONTEXT.test(fragment);
    return true;
  });
}

/** Values the answer asserts that the retrieved sources do not support. */
export function ungroundedCommitments(
  answer: string,
  citations: readonly EngineCitation[],
): CommitmentValue[] {
  const sourceFragments = citations.flatMap((citation) =>
    fragments(`${citation.title ?? ''} ${citation.snippet ?? ''}`),
  );
  return commitmentValues(answer).filter((value) => !isSupported(value, sourceFragments));
}

/** Which template answers a refusal caused by these values. */
export function topicForCommitments(
  values: readonly CommitmentValue[],
): 'pricing' | 'discount' | 'delivery-date' | 'certification' {
  if (values.some((value) => value.kind === 'percentage')) return 'discount';
  if (values.some((value) => value.kind === 'money')) return 'pricing';
  if (values.some((value) => value.kind === 'date')) return 'delivery-date';
  return 'certification';
}
