/**
 * Lossless money-lexeme parsing for Alibaba source payloads.
 *
 * Source money values are preserved as strings through the JSON boundary and
 * converted to integer minor units by string manipulation only. Binary
 * floating-point arithmetic on money is forbidden repo-wide for this feature
 * (DESIGN_CHARTER §6.2): `Number('1.15') * 100 === 114.99999...`.
 */

export type MoneyParseFailure = 'not-a-string' | 'malformed' | 'unsafe-integer';

export type MoneyParseResult =
  | { ok: true; minorUnits: number }
  | { ok: false; reason: MoneyParseFailure };

/**
 * Strict decimal grammar for Phase 2: unsigned, no separators, no exponent,
 * no leading zeros, at most two fraction digits.
 */
const DECIMAL_LEXEME = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function parseDecimalToMinorUnits(lexeme: string): MoneyParseResult {
  if (typeof lexeme !== 'string') return { ok: false, reason: 'not-a-string' };
  const match = DECIMAL_LEXEME.exec(lexeme);
  if (!match) return { ok: false, reason: 'malformed' };
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  // BigInt construction keeps the value exact regardless of magnitude; the
  // safe-integer check happens before narrowing to number.
  const minor = BigInt(whole) * 100n + BigInt(fraction);
  if (minor > MAX_SAFE) return { ok: false, reason: 'unsafe-integer' };
  return { ok: true, minorUnits: Number(minor) };
}

/** Non-negative safe integer — the only representation money may take at rest. */
export function isValidMinorUnits(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Only wholesale_trade.price has the documented USD/two-decimal contract.
 * Accept a value within 1e-9 USD of an exact cent (binary serialization tail),
 * not arbitrary extra decimal precision. Arithmetic and the bound are exact.
 */
export function parseWholesalePrice(lexeme: string): MoneyParseResult {
  if (typeof lexeme !== 'string') return { ok: false, reason: 'not-a-string' };
  const match = /^(0|[1-9][0-9]{0,7})(?:\.([0-9]{1,64}))?$/.exec(lexeme);
  if (!match || match[1] === undefined) return { ok: false, reason: 'malformed' };
  const fraction = match[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const exact = BigInt(match[1]) * scale + BigInt(fraction || '0');
  const cents = (exact * 100n + scale / 2n) / scale;
  const delta = exact * 100n - cents * scale;
  const absolute = delta < 0n ? -delta : delta;
  if (absolute * 1000000000n > scale * 100n || cents < 1n || cents > 999999900n)
    return { ok: false, reason: 'malformed' };
  return { ok: true, minorUnits: Number(cents) };
}
