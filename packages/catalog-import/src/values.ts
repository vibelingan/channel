/**
 * Typed parsing for individual source cells.
 *
 * Every function here answers the same question — "is this cell a usable
 * value?" — and answers it by REJECTING rather than guessing. A workbook cell
 * reading `N/A` must not become stock `0`, and a price cell reading `abc` must
 * not become `0.00`: both would publish a wrong number to the storefront while
 * looking perfectly healthy in the job summary.
 *
 * Money never touches binary floating point. `Number('1.15') * 100` is
 * `114.99999999999999`, and the resulting off-by-one-fen price is the kind of
 * defect nobody notices until a customer does.
 */

/** Dianxiaomi writes this instead of leaving an end date empty. */
export const OPEN_ENDED_DATE_SENTINEL = '2101-12-31 23:59:59';

/** Source timestamps carry no zone; the merchant's ERP runs on China time. */
export const SOURCE_TIMEZONE_OFFSET_MINUTES = 8 * 60;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Plain decimal, optionally with 3-digit grouping. No sign, no exponent. */
const GROUPED_DECIMAL = /^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?$/;
/** Non-negative integer, tolerating the `.0` a spreadsheet appends. */
const INTEGER_LEXEME = /^([0-9]+)(?:\.0+)?$/;
const DATE_LEXEME = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export type MoneyParseResult =
  | { ok: true; amountMinor: number; rounded: boolean }
  | { ok: false; reason: 'absent' | 'malformed' | 'out-of-range' };

/**
 * Parse a source money lexeme into integer minor units.
 *
 * `rounded` is true when the source carried more precision than minor units
 * can hold. That covers both the harmless case (a spreadsheet writing
 * `1299.0000000000001` for a cell the merchant typed as `1299`) and the real
 * one (a genuine sub-fen price), so the caller can surface a warning without
 * having to distinguish them itself.
 */
export function parseSourceMoney(raw: string | null | undefined): MoneyParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'absent' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'absent' };
  const match = GROUPED_DECIMAL.exec(trimmed);
  if (!match) return { ok: false, reason: 'malformed' };

  const [whole = '0'] = trimmed.replaceAll(',', '').split('.');
  const fraction = match[1] ?? '';
  const kept = fraction.slice(0, 2).padEnd(2, '0');
  const dropped = fraction.slice(2);
  // Half-up on the first dropped digit. Comparing only that digit is exact:
  // any tail after a `5` can only push further up, and a tail after a `4`
  // can never reach the halfway point.
  const roundsUp = (dropped[0] ?? '0') >= '5';
  const rounded = dropped !== '' && /[^0]/.test(dropped);

  const minor = BigInt(whole) * 100n + BigInt(kept) + (roundsUp ? 1n : 0n);
  if (minor > MAX_SAFE) return { ok: false, reason: 'out-of-range' };
  return { ok: true, amountMinor: Number(minor), rounded };
}

export type QuantityParseResult =
  | { ok: true; quantity: number }
  | { ok: false; reason: 'absent' | 'malformed' | 'out-of-range' };

/**
 * Parse a stock cell. Fractional, negative and non-numeric values are
 * rejected outright — the merchant asked for an EXACT displayed count, and a
 * fabricated `0` is worse than showing nothing.
 */
export function parseSourceQuantity(raw: string | null | undefined): QuantityParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'absent' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'absent' };
  const match = INTEGER_LEXEME.exec(trimmed);
  if (!match) return { ok: false, reason: 'malformed' };
  const digits = BigInt(match[1] as string);
  if (digits > MAX_SAFE) return { ok: false, reason: 'out-of-range' };
  return { ok: true, quantity: Number(digits) };
}

export type DateParseResult =
  | { ok: true; iso: string; source: string; openEnded: boolean }
  | { ok: false; reason: 'absent' | 'malformed' };

/**
 * Parse a naive workbook timestamp as UTC+8 and return both the instant and
 * the untouched cell text. Keeping `source` matters for audit: the operator
 * needs to see what the workbook said, not only what we concluded.
 */
export function parseSourceDate(raw: string | null | undefined): DateParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'absent' };
  const source = raw.trim();
  if (source === '') return { ok: false, reason: 'absent' };

  const match = DATE_LEXEME.exec(source);
  if (!match) return { ok: false, reason: 'malformed' };
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? '0');
  const minute = Number(minuteText ?? '0');
  const second = Number(secondText ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: 'malformed' };
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, reason: 'malformed' };

  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const asDate = new Date(localMs);
  // Round-trip check: Date.UTC silently rolls 2026-02-30 forward to March.
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const openEnded = source.replaceAll('/', '-') === OPEN_ENDED_DATE_SENTINEL;
  const iso = new Date(localMs - SOURCE_TIMEZONE_OFFSET_MINUTES * 60_000).toISOString();
  return { ok: true, iso, source, openEnded };
}

/**
 * Excel's 1900 date system, phantom leap day and all.
 *
 * Excel believes 1900 was a leap year, so serial 60 is a date that never
 * existed and every serial from 61 onward is offset by one relative to the
 * naive arithmetic. Serial 60 is corruption, not a date, and is rejected.
 */
export function excelSerialToNaiveDateTime(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial === 60) return null;
  const epochDay = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const wholeDays = Math.floor(serial);
  const fractionOfDay = serial - wholeDays;
  // Round to the nearest second: a serial is a binary float, so 12:00:00
  // arrives as 0.499999999999.
  const secondsInDay = Math.round(fractionOfDay * 86400);
  const instant = new Date(epochDay + wholeDays * 86_400_000 + secondsInDay * 1000);
  if (Number.isNaN(instant.getTime())) return null;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${pad(instant.getUTCFullYear(), 4)}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}` +
    ` ${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}:${pad(instant.getUTCSeconds())}`
  );
}

/**
 * Validate a source image URL. Only http(s) is accepted: `data:` URLs are not
 * transport, and `javascript:`/`file:` in a supplier feed are an attack, not a
 * typo. The DOWNLOADER applies a stricter policy still (HTTPS plus SSRF
 * checks) — this is only the "is it a fetchable address" gate.
 */
export function parseSourceUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;
  return trimmed;
}

/**
 * Deduplicate image URLs, preserving first-seen order.
 *
 * Equality is decided on the parsed URL, so a host typed in mixed case is one
 * image, while paths differing in case stay separate — object stores are
 * case-sensitive on the path and merging them would drop a real photo.
 */
export function dedupeImageUrls(raw: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const valid = parseSourceUrl(candidate);
    if (valid === null) continue;
    const key = new URL(valid).href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(valid);
  }
  return out;
}
