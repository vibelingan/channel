import { createHash } from 'node:crypto';
import { visit } from 'jsonc-parser';
import { ContractValidationError } from './errors.ts';

const MAX_DEPTH = 64;
const MAX_BYTES = 262_144;
const fail = (): never => {
  throw new ContractValidationError('Expected bounded, lossless JSON');
};

function codePoint(character: string): number {
  const point = character.codePointAt(0);
  if (point === undefined) return fail();
  return point;
}

function validUnicode(value: string): void {
  for (const character of value) {
    const point = codePoint(character);
    if (point >= 0xd800 && point <= 0xdfff) fail();
  }
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, (x) => codePoint(x));
  const right = Array.from(b, (x) => codePoint(x));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const leftPoint = left[i];
    const rightPoint = right[i];
    if (leftPoint === undefined || rightPoint === undefined) return fail();
    const difference = leftPoint - rightPoint;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function canonicalizeJson(value: unknown): string {
  const active = new Set<object>();
  let bytes = 0;
  const emit = (part: string): string => {
    bytes += Buffer.byteLength(part, 'utf8');
    if (bytes > MAX_BYTES) fail();
    return part;
  };
  function encode(input: unknown, depth: number): string {
    if (depth > MAX_DEPTH) fail();
    if (input === null) return emit('null');
    if (typeof input === 'string') {
      validUnicode(input);
      return emit(JSON.stringify(input));
    }
    if (typeof input === 'boolean') return emit(String(input));
    if (typeof input === 'number') {
      if (!Number.isSafeInteger(input)) fail();
      return emit(String(input === 0 ? 0 : input));
    }
    if (typeof input !== 'object' || active.has(input)) return fail();
    active.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(input).some((key) => typeof key !== 'string')) fail();
      if (Array.isArray(input)) {
        if (Object.keys(descriptors).length !== input.length + 1) fail();
        emit('[');
        emit(']');
        const parts: string[] = [];
        for (let i = 0; i < input.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
          if (i) emit(',');
          parts.push(encode(descriptor.value, depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
      emit('{');
      emit('}');
      const parts: string[] = [];
      for (const key of Object.keys(descriptors).sort(compareCodePoints)) {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return fail();
        if (parts.length) emit(',');
        validUnicode(key);
        parts.push(
          `${emit(JSON.stringify(key))}${emit(':')}${encode(descriptor.value, depth + 1)}`,
        );
      }
      return `{${parts.join(',')}}`;
    } finally {
      active.delete(input);
    }
  }
  return encode(value, 0);
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

export function parseStrictJson(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES) fail();
  const stack: (Set<string> | null)[] = [];
  const begin = (keys: Set<string> | null) => {
    stack.push(keys);
    if (stack.length > MAX_DEPTH + 1) fail();
  };
  visit(
    raw,
    {
      onObjectBegin: () => begin(new Set()),
      onArrayBegin: () => begin(null),
      onObjectEnd: () => {
        stack.pop();
      },
      onArrayEnd: () => {
        stack.pop();
      },
      onObjectProperty: (key) => {
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) return fail();
        keys.add(key);
      },
      onLiteralValue: (value, offset, length) => {
        if (typeof value !== 'number') return;
        const lexeme = raw.slice(offset, offset + length);
        if (lexeme.length > 17 || !/^-?(0|[1-9]\d*)$/.test(lexeme)) fail();
        const integer = BigInt(lexeme);
        if (integer < -9007199254740991n || integer > 9007199254740991n) fail();
      },
      onComment: fail,
      onError: fail,
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );
  const result: unknown = JSON.parse(raw);
  canonicalizeJson(result);
  return result;
}
