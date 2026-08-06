/**
 * Lossless JSON parsing for Alibaba API responses.
 *
 * `JSON.parse` converts every number to a binary float, destroying money
 * lexemes ("1.15" and "1.1500000000000001" become indistinguishable).
 * DESIGN_CHARTER §6.2 requires decimal source strings to survive the JSON
 * boundary, and the source may type prices as JSON numbers OR strings — so
 * every number is preserved as its exact source lexeme.
 *
 * Hand-rolled deliberately: the usual dependency for this (`lossless-json`)
 * could not be added offline (REVISION_R1 context — no registry access), the
 * JSON grammar is small and frozen (RFC 8259), and this parser is fully
 * covered by tests. Revisit if a dependency refresh happens for other
 * reasons.
 */

export class JsonNumberLexeme {
  constructor(readonly lexeme: string) {}
}

export type LosslessJsonValue =
  | null
  | boolean
  | string
  | JsonNumberLexeme
  | LosslessJsonValue[]
  | { [key: string]: LosslessJsonValue };

export type LosslessParseResult =
  | { ok: true; value: LosslessJsonValue }
  | { ok: false; error: string };

const MAX_DEPTH = 64;

export function parseJsonPreservingNumbers(text: string): LosslessParseResult {
  if (typeof text !== 'string') return { ok: false, error: 'input must be a string' };
  let pos = 0;

  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at position ${pos}`);
  };

  const skipWs = () => {
    while (pos < text.length) {
      const c = text[pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos += 1;
      else break;
    }
  };

  const parseString = (): string => {
    // opening quote already consumed by caller check
    pos += 1;
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const c = text[pos] as string;
      if (c === '"') {
        pos += 1;
        return out;
      }
      if (c === '\\') {
        pos += 1;
        const esc = text[pos];
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = text.slice(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            fail('invalid escape');
        }
        pos += 1;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail('unescaped control character');
      out += c;
      pos += 1;
    }
  };

  const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/;

  const parseValue = (depth: number): LosslessJsonValue => {
    if (depth > MAX_DEPTH) fail('maximum nesting depth exceeded');
    skipWs();
    if (pos >= text.length) fail('unexpected end of input');
    const c = text[pos] as string;
    if (c === '"') return parseString();
    if (c === '{') {
      pos += 1;
      const obj: { [key: string]: LosslessJsonValue } = {};
      skipWs();
      if (text[pos] === '}') {
        pos += 1;
        return obj;
      }
      for (;;) {
        skipWs();
        if (text[pos] !== '"') fail('expected object key');
        const key = parseString();
        skipWs();
        if (text[pos] !== ':') fail('expected ":"');
        pos += 1;
        obj[key] = parseValue(depth + 1);
        skipWs();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        if (text[pos] === '}') {
          pos += 1;
          return obj;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      pos += 1;
      const arr: LosslessJsonValue[] = [];
      skipWs();
      if (text[pos] === ']') {
        pos += 1;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[pos] === ',') {
          pos += 1;
          continue;
        }
        if (text[pos] === ']') {
          pos += 1;
          return arr;
        }
        fail('expected "," or "]"');
      }
    }
    if (text.startsWith('true', pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith('false', pos)) {
      pos += 5;
      return false;
    }
    if (text.startsWith('null', pos)) {
      pos += 4;
      return null;
    }
    const match = NUMBER.exec(text.slice(pos));
    if (match?.[0]) {
      pos += match[0].length;
      return new JsonNumberLexeme(match[0]);
    }
    return fail('unexpected token');
  };

  try {
    const value = parseValue(0);
    skipWs();
    if (pos !== text.length) fail('trailing content');
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Walk an object path; returns undefined on any miss. Arrays use numeric segments. */
export function getPath(
  value: LosslessJsonValue | undefined,
  path: (string | number)[],
): LosslessJsonValue | undefined {
  let current: LosslessJsonValue | undefined = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (
      typeof current !== 'object' ||
      Array.isArray(current) ||
      current instanceof JsonNumberLexeme
    ) {
      return undefined;
    }
    current = (current as { [key: string]: LosslessJsonValue })[segment];
  }
  return current;
}

/** String content of a leaf: strings pass through, number lexemes surface exactly. */
export function asLexeme(value: LosslessJsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof JsonNumberLexeme) return value.lexeme;
  return undefined;
}

/** Safe-integer view of a leaf (counts, ids-as-numbers). */
export function asInteger(value: LosslessJsonValue | undefined): number | undefined {
  const lexeme = asLexeme(value);
  if (lexeme === undefined || !/^-?[0-9]+$/.test(lexeme)) return undefined;
  const n = Number(lexeme);
  return Number.isSafeInteger(n) ? n : undefined;
}
