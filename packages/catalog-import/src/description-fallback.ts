/**
 * The deterministic description fallback chain (APPROVED_DESIGN_SPEC §11).
 *
 * A large share of the merchant's rows carry filler — `1`, `<p>1</p>`, `<br>` —
 * where a description should be. Treating those as absent is only half the
 * rule: the design then requires a deterministic fallback, in this order:
 *
 *   1. the merchant's own description
 *   2. the merchant's short description
 *   3. structured copy assembled from title, brand and key attributes
 *   4. the title plus a specification table
 *
 * Steps 3 and 4 RESTATE SUPPLIED FIELDS AND NOTHING ELSE. No language model is
 * involved and no adjective is added, because a description is a claim about a
 * product: "durable", "premium" or "long battery life" would be an assertion
 * the merchant never made, attached to their listing, on their storefront.
 * Everything emitted here is either a value from the row or a field label.
 *
 * The chosen level travels with the result, so the admin preview can say the
 * copy was derived rather than written, and so publication can be reviewed on
 * that basis.
 */
import {
  type DescriptionResult,
  normalizeDescription,
  sanitizeSourceHtmlWithReport,
} from './descriptions.ts';

export type DescriptionSource =
  | 'description'
  | 'shortDescription'
  | 'structured'
  | 'titleAndSpecs'
  | 'none';

export interface DescriptionFallbackInput {
  /** Raw source description cell. */
  description?: string | undefined;
  /** Raw source short-description cell. */
  shortDescription?: string | undefined;
  title: string;
  brand?: string | undefined;
  /** Key attributes parsed from the source attribute column. */
  attributes: Record<string, string | number | boolean>;
  /** Variant option values, when the row carries them. */
  optionValues?: Record<string, string> | undefined;
  /** Physical specifications (weight, dimensions) as label → value. */
  specs: Record<string, string>;
}

export interface ResolvedDescription {
  text: string;
  html?: string;
  source: DescriptionSource;
  /** True when unsafe markup was removed from a merchant-authored value. */
  sanitized: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A field is usable when it is a non-empty string after trimming. */
function usableValue(value: string | number | boolean | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Render generated lines as a minimal, escaped HTML fragment. */
function linesToHtml(lines: readonly string[]): string {
  return lines
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

function fromMerchantValue(
  raw: string | undefined,
  source: 'description' | 'shortDescription',
): ResolvedDescription | null {
  const normalized: DescriptionResult = normalizeDescription(raw);
  if (normalized.placeholder || normalized.text === undefined) return null;
  const report = sanitizeSourceHtmlWithReport(raw ?? '');
  return {
    text: normalized.text,
    ...(normalized.html === undefined ? {} : { html: normalized.html }),
    source,
    sanitized: report.removed,
  };
}

/**
 * Resolve a product description, walking the chain until something usable
 * appears. Returns `source: 'none'` only when even the title is unusable —
 * at which point there is genuinely nothing to say about the product.
 */
export function resolveDescription(input: DescriptionFallbackInput): ResolvedDescription {
  // 1 and 2: whatever the merchant actually wrote.
  const authored =
    fromMerchantValue(input.description, 'description') ??
    fromMerchantValue(input.shortDescription, 'shortDescription');
  if (authored !== null) return authored;

  const title = input.title.trim();
  if (title === '') return { text: '', source: 'none', sanitized: false };

  // 3: structured copy from brand, attributes and options.
  const detail: string[] = [];
  const brand = usableValue(input.brand);
  if (brand !== null) detail.push(`Brand: ${brand}`);
  for (const [label, value] of Object.entries(input.attributes)) {
    const usable = usableValue(value);
    const name = label.trim();
    if (usable !== null && name !== '') detail.push(`${name}: ${usable}`);
  }
  for (const [label, value] of Object.entries(input.optionValues ?? {})) {
    const usable = usableValue(value);
    const name = label.trim();
    if (usable !== null && name !== '') detail.push(`${name}: ${usable}`);
  }

  if (detail.length > 0) {
    const lines = [title, '', ...detail];
    return {
      text: lines.join('\n'),
      html: linesToHtml(lines),
      source: 'structured',
      sanitized: false,
    };
  }

  // 4: the title, plus a specification table when the row has one.
  const specs: string[] = [];
  for (const [label, value] of Object.entries(input.specs)) {
    const usable = usableValue(value);
    const name = label.trim();
    if (usable !== null && name !== '') specs.push(`${name}: ${usable}`);
  }
  const lines = specs.length > 0 ? [title, '', ...specs] : [title];
  return {
    text: lines.join('\n'),
    html: linesToHtml(lines),
    source: 'titleAndSpecs',
    sanitized: false,
  };
}
