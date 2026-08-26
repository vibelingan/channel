/**
 * Source description handling: placeholder detection, HTML sanitization and a
 * plain-text projection.
 *
 * Dianxiaomi exports descriptions as merchant-authored HTML, and a large share
 * of the rows carry filler (`1`, `<p>1</p>`, `<br>`) that must read as "no
 * description" rather than as a one-character product blurb.
 *
 * The sanitizer works by RE-EMITTING tags from its own allowlist table, never
 * by editing the input string. That distinction is the whole security
 * argument: a replace-based sanitizer can be defeated by inputs that
 * reassemble into markup after the replacement (`<scr<script>ipt>`), while a
 * re-emitting one can only ever produce tags that appear in the table below.
 * Attributes are not filtered — they are dropped wholesale, so there is no
 * href/src/style parser to get wrong.
 *
 * Even so, the sanitized HTML is stored, not rendered: the admin preview shows
 * `descriptionText`. Sanitized markup is defense in depth for a later
 * operator-approved rendering path, not a licence to call
 * `dangerouslySetInnerHTML` on supplier input.
 */

/** Tags re-emitted verbatim (without any attributes). */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);

/** Allowed tags that never have children or a close tag. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr']);

/**
 * Elements whose CONTENT is dropped along with the tag. Anything that can
 * execute, load, or re-parse markup belongs here; everything else merely gets
 * unwrapped so its text survives.
 */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'noscript',
  'noembed',
  'template',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'title',
  'link',
  'meta',
  'base',
  'head',
]);

/** Tags that imply a line break in the text projection. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'hr',
  'div',
  'li',
  'tr',
  'ul',
  'ol',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
]);

/**
 * Text that means "the merchant left this blank". `1` is the documented
 * Dianxiaomi filler; the rest are the usual hand-typed equivalents, including
 * the Chinese ones this workbook actually contains.
 */
const PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set([
  '1',
  '-',
  '--',
  '.',
  '。',
  'n/a',
  'na',
  'null',
  'undefined',
  'none',
  'nil',
  '无',
  '暂无',
  '没有',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** A complete, well-formed entity reference that may pass through untouched. */
const ENTITY_REFERENCE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

const TAG_NAME_START = /[a-zA-Z]/;
const TAG_NAME_CHAR = /[a-zA-Z0-9-]/;

interface ParsedTag {
  kind: 'open' | 'close';
  name: string;
  selfClosing: boolean;
  /** Index just past the tag's closing `>` (or past the end for a truncated tag). */
  end: number;
}

/**
 * Read one tag starting at `<`. Returns `null` when the `<` does not begin a
 * tag (a bare `<` in prose), in which case the caller emits it as text.
 * Comments, doctypes and CDATA are consumed and reported as an unnamed tag so
 * they disappear without taking following content with them.
 */
function readTag(input: string, start: number): ParsedTag | null {
  let index = start + 1;
  if (index >= input.length) return null;

  // <!-- comment -->, <!DOCTYPE ...>, <![CDATA[...]]>, <?pi?>
  if (input[index] === '!' || input[index] === '?') {
    if (input.startsWith('!--', index)) {
      const close = input.indexOf('-->', index + 3);
      return {
        kind: 'open',
        name: '',
        selfClosing: true,
        end: close === -1 ? input.length : close + 3,
      };
    }
    if (input.startsWith('![CDATA[', index)) {
      const close = input.indexOf(']]>', index + 8);
      return {
        kind: 'open',
        name: '',
        selfClosing: true,
        end: close === -1 ? input.length : close + 3,
      };
    }
    const close = input.indexOf('>', index);
    return {
      kind: 'open',
      name: '',
      selfClosing: true,
      end: close === -1 ? input.length : close + 1,
    };
  }

  const kind: ParsedTag['kind'] = input[index] === '/' ? 'close' : 'open';
  if (kind === 'close') index += 1;

  const nameStart = index;
  if (index >= input.length || !TAG_NAME_START.test(input[index] as string)) return null;
  while (index < input.length && TAG_NAME_CHAR.test(input[index] as string)) index += 1;
  const name = input.slice(nameStart, index).toLowerCase();

  // Skip the attribute region without interpreting it. Quoted spans are
  // honoured so a `>` inside an attribute value cannot end the tag early — the
  // classic way a naive scanner is walked past a close bracket.
  let quote: '"' | "'" | null = null;
  while (index < input.length) {
    const char = input[index] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      const selfClosing = input[index - 1] === '/' || VOID_TAGS.has(name);
      return { kind, name, selfClosing, end: index + 1 };
    }
    index += 1;
  }
  // Truncated tag: consume to the end rather than emitting a dangling `<`.
  return { kind, name, selfClosing: VOID_TAGS.has(name), end: input.length };
}

/** Skip a dropped element's content, to its close tag or to end of input. */
function skipElement(input: string, from: number, name: string): number {
  let index = from;
  while (index < input.length) {
    const next = input.indexOf('<', index);
    if (next === -1) return input.length;
    const tag = readTag(input, next);
    if (tag === null) {
      index = next + 1;
      continue;
    }
    if (tag.kind === 'close' && tag.name === name) return tag.end;
    index = tag.end;
  }
  return input.length;
}

function escapeText(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '<') {
      out += '&lt;';
    } else if (char === '>') {
      out += '&gt;';
    } else if (char === '&') {
      // A well-formed entity is already encoded; re-escaping it would show the
      // merchant `&amp;amp;` on the website.
      const rest = text.slice(index);
      const match = ENTITY_REFERENCE.exec(rest);
      if (match) {
        out += match[0];
        index += match[0].length - 1;
      } else {
        out += '&amp;';
      }
    } else {
      out += char;
    }
  }
  return out;
}

export interface SanitizeReport {
  html: string;
  /** True when an element or attribute was removed, i.e. the source was unsafe. */
  removed: boolean;
}

export function sanitizeSourceHtmlWithReport(raw: string): SanitizeReport {
  if (typeof raw !== 'string') return { html: '', removed: false };
  let out = '';
  let removed = false;
  const openStack: string[] = [];
  let index = 0;

  while (index < raw.length) {
    const next = raw.indexOf('<', index);
    if (next === -1) {
      out += escapeText(raw.slice(index));
      break;
    }
    if (next > index) out += escapeText(raw.slice(index, next));

    const tag = readTag(raw, next);
    if (tag === null) {
      out += '&lt;';
      index = next + 1;
      continue;
    }
    index = tag.end;

    if (tag.name === '') {
      removed = true;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag.name)) {
      removed = true;
      if (tag.kind === 'open' && !tag.selfClosing) index = skipElement(raw, index, tag.name);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag.name)) {
      // Unwrap: the element goes, its text stays.
      removed = true;
      continue;
    }
    if (tag.kind === 'close') {
      // Drop a close tag with no matching open so the output stays balanced.
      const at = openStack.lastIndexOf(tag.name);
      if (at === -1) {
        removed = true;
        continue;
      }
      // Implicitly close anything left open inside it (`<p><li></p>`).
      for (let depth = openStack.length - 1; depth >= at; depth -= 1) {
        out += `</${openStack[depth]}>`;
      }
      openStack.length = at;
      continue;
    }
    if (VOID_TAGS.has(tag.name)) {
      out += `<${tag.name} />`;
      continue;
    }
    out += `<${tag.name}>`;
    openStack.push(tag.name);
  }

  for (let depth = openStack.length - 1; depth >= 0; depth -= 1) {
    out += `</${openStack[depth]}>`;
  }
  return { html: out, removed };
}

/** Sanitized HTML restricted to the allowlist above, with all attributes dropped. */
export function sanitizeSourceHtml(raw: string): string {
  return sanitizeSourceHtmlWithReport(raw).html;
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Plain-text projection used for search, previews and placeholder detection.
 * Block-level tags become newlines so a list does not collapse into one run-on
 * line, and whitespace is normalized so a workbook full of `&nbsp;` padding
 * does not read as content.
 */
export function sourceHtmlToText(raw: string): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  let index = 0;

  while (index < raw.length) {
    const next = raw.indexOf('<', index);
    if (next === -1) {
      out += raw.slice(index);
      break;
    }
    if (next > index) out += raw.slice(index, next);
    const tag = readTag(raw, next);
    if (tag === null) {
      out += '<';
      index = next + 1;
      continue;
    }
    index = tag.end;
    if (tag.name === '') continue;
    if (DROP_WITH_CONTENT.has(tag.name)) {
      if (tag.kind === 'open' && !tag.selfClosing) index = skipElement(raw, index, tag.name);
      continue;
    }
    if (BLOCK_TAGS.has(tag.name)) out += '\n';
  }

  return decodeEntities(out)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

export interface DescriptionResult {
  /** Sanitized HTML — stored, not rendered. Absent when the source is filler. */
  html?: string;
  /** Plain-text projection. Absent when the source is filler. */
  text?: string;
  /** True when the source carried no real description. */
  placeholder: boolean;
  /** True when sanitization removed an element or attribute. */
  sanitized: boolean;
}

/**
 * Decide whether a description cell carries content, and if so return both
 * projections. A placeholder yields neither, so downstream code cannot
 * accidentally publish `1` as a product description.
 */
export function normalizeDescription(raw: string | null | undefined): DescriptionResult {
  if (typeof raw !== 'string') return { placeholder: true, sanitized: false };
  const text = sourceHtmlToText(raw);
  if (text === '' || PLACEHOLDER_TEXTS.has(text.toLowerCase())) {
    const { removed } = sanitizeSourceHtmlWithReport(raw);
    return { placeholder: true, sanitized: removed };
  }
  const { html, removed } = sanitizeSourceHtmlWithReport(raw);
  return { html, text, placeholder: false, sanitized: removed };
}
