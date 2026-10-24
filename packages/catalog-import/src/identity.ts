/**
 * Identifier normalization and deterministic source keys.
 *
 * Two jobs, deliberately kept in one file because they must agree:
 *
 *   1. Reduce a human-entered identifier to a canonical comparison form, so
 *      the same physical SKU typed with a trailing space in one store and a
 *      full-width dash in another resolves to ONE website variant.
 *   2. Build replay-stable keys from those forms, so re-importing the same
 *      workbook addresses the same records instead of creating new ones.
 *
 * The canonical form is a KEY, never a display value. The original cell text
 * is preserved separately on every candidate — normalization must never be
 * the only surviving copy of what the merchant actually typed.
 */
import type { CatalogProvider } from './contracts.ts';

/**
 * Zero-width characters carry no meaning here but do break equality. They are
 * deleted outright rather than folded to a space: `AB<ZWSP>12` is the SKU
 * `AB12`, not `AB 12`.
 */
const ZERO_WIDTH_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x2060, // word joiner
  0xfeff, // byte-order mark / zero-width no-break space
]);

/**
 * Characters deleted before comparison: the zero-width set above plus the
 * C0/DEL controls, minus the whitespace controls (tab, LF, VT, FF, CR) which
 * fall through to the whitespace collapse. A stray control byte inside a cell
 * is corruption, not data.
 *
 * Expressed as a code-point predicate rather than a character class: a regex
 * literal holding raw control characters and a zero-width joiner is both
 * unreadable in review and rejected by the linter, for good reason.
 */
function isDeletableCodePoint(code: number): boolean {
  if (ZERO_WIDTH_CODE_POINTS.has(code)) return true;
  return code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
}

function deleteInvisible(value: string): string {
  let out = '';
  for (const char of value) {
    if (!isDeletableCodePoint(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/** JS `\s` already covers NBSP, the ideographic space and the Unicode spaces. */
const WHITESPACE_RUN = /\s+/gu;

/**
 * Canonical comparison form for any source identifier (SKU, parent SKU, store
 * name). Returns `null` for anything that is not a non-empty string, so a
 * blank cell can never produce the key `""` and silently group unrelated rows.
 *
 * NFKC runs first and matters more than it looks: a Chinese ERP export
 * routinely emits full-width Latin (`ＡＢ－１２`), and without folding those
 * rows become a second, phantom product.
 *
 * The value is NEVER passed through `Number()`. `1e5`, `0.30` and `0012300`
 * are distinct SKUs whose numeric readings are not.
 */
export function normalizeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const folded = deleteInvisible(value.normalize('NFKC'))
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .toLowerCase();
  return folded === '' ? null : folded;
}

/** Store names normalize exactly like identifiers; named for call-site clarity. */
export function normalizeStoreKey(value: string | null | undefined): string | null {
  return normalizeIdentifier(value);
}

/**
 * Percent-escape the segment separator so key segments cannot be forged.
 * Without this, store `a:b` + SKU `c` and store `a` + SKU `b:c` produce the
 * same key, which merges two unrelated stores' listings into one variant.
 * `%` is escaped first, or the escape itself would be ambiguous.
 */
function escapeSegment(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(':', '%3A').toLowerCase();
}

export interface SourceKeyInput {
  provider: CatalogProvider;
  /** Provider-side channel/taxonomy the record belongs to, e.g. `lazada`. */
  taxonomy: string;
  /** Source store; an unknown store yields an empty segment, never a dropped one. */
  store: string | null | undefined;
  value: string | null | undefined;
}

function buildSourceKey(input: SourceKeyInput): string | null {
  const value = normalizeIdentifier(input.value);
  if (value === null) return null;
  const store = normalizeStoreKey(input.store) ?? '';
  return [
    escapeSegment(input.provider),
    escapeSegment(input.taxonomy),
    escapeSegment(store),
    escapeSegment(value),
  ].join(':');
}

/** `<provider>:<taxonomy>:<store>:<parent SKU>` — one store's listing of a family. */
export function sourceProductKey(input: SourceKeyInput): string | null {
  return buildSourceKey(input);
}

/** `<provider>:<taxonomy>:<store>:<SKU>` — one store's listing of a variant. */
export function sourceVariantKey(input: SourceKeyInput): string | null {
  return buildSourceKey(input);
}

/**
 * `<provider>:<parent SKU>` — the store-independent product family. This is
 * what collapses the same family sold in four stores into one candidate.
 */
export function candidateGroupKey(
  provider: CatalogProvider,
  parentSku: string | null | undefined,
): string | null {
  const value = normalizeIdentifier(parentSku);
  if (value === null) return null;
  return `${escapeSegment(provider)}:${escapeSegment(value)}`;
}

/** `<provider>:<SKU>` — the store-independent sellable variant. */
export function candidateSkuKey(
  provider: CatalogProvider,
  sku: string | null | undefined,
): string | null {
  const value = normalizeIdentifier(sku);
  if (value === null) return null;
  return `${escapeSegment(provider)}:${escapeSegment(value)}`;
}
