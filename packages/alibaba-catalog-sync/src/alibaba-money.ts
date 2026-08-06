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
