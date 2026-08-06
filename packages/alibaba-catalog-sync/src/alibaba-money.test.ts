import { strict as assert } from 'node:assert';
import test from 'node:test';
import { parseDecimalToMinorUnits } from './alibaba-money.ts';

const ok = (lexeme: string, minor: number) => {
  const result = parseDecimalToMinorUnits(lexeme);
  assert.deepEqual(
    result,
    { ok: true, minorUnits: minor },
    `expected ${JSON.stringify(lexeme)} -> ${minor}`,
  );
};

const bad = (lexeme: unknown, reason?: string) => {
  const result = parseDecimalToMinorUnits(lexeme as string);
  assert.equal(result.ok, false, `expected ${JSON.stringify(lexeme)} to be rejected`);
  if (reason && result.ok === false) {
    assert.equal(result.reason, reason, `wrong reason for ${JSON.stringify(lexeme)}`);
  }
};

// --- golden values ----------------------------------------------------------

test('parses integer lexemes into minor units', () => {
  ok('0', 0);
  ok('1', 100);
  ok('12', 1200);
  ok('19999', 1999900);
});

test('parses one- and two-digit fractions exactly', () => {
  ok('0.5', 50);
  ok('0.50', 50);
  ok('1.05', 105);
  ok('12.34', 1234);
  ok('0.01', 1);
  ok('0.00', 0);
});

test('parses values that are lossy as binary floats', () => {
  // 0.1 + 0.2 !== 0.3 territory: string math must stay exact.
  ok('0.1', 10);
  ok('0.2', 20);
  ok('0.3', 30);
  ok('19.99', 1999);
  ok('1.15', 115); // (1.15 * 100) === 114.99999... under float math
  ok('8.2', 820);
});

test('parses large but safe amounts', () => {
  // 90071992547409.91 * 100 = 9007199254740991 = Number.MAX_SAFE_INTEGER
  ok('90071992547409.91', 9007199254740991);
});

// --- rejections -------------------------------------------------------------

test('rejects non-string input', () => {
  bad(12.5 as unknown, 'not-a-string');
  bad(null, 'not-a-string');
  bad(undefined, 'not-a-string');
  bad({} as unknown, 'not-a-string');
});

test('rejects empty and whitespace', () => {
  bad('', 'malformed');
  bad(' ', 'malformed');
  bad(' 1', 'malformed');
  bad('1 ', 'malformed');
});

test('rejects signs', () => {
  bad('-1', 'malformed');
  bad('+1', 'malformed');
  bad('-0.5', 'malformed');
});

test('rejects separators and exponent notation', () => {
  bad('1,000', 'malformed');
  bad('1_000', 'malformed');
  bad('1e2', 'malformed');
  bad('1E2', 'malformed');
});

test('rejects malformed decimals', () => {
  bad('.5', 'malformed');
  bad('5.', 'malformed');
  bad('1.234', 'malformed'); // more than two fraction digits
  bad('1..2', 'malformed');
  bad('1.2.3', 'malformed');
});

test('rejects leading zeros', () => {
  bad('00', 'malformed');
  bad('01', 'malformed');
  bad('00.5', 'malformed');
});

test('rejects NaN and Infinity lexemes', () => {
  bad('NaN', 'malformed');
  bad('Infinity', 'malformed');
  bad('-Infinity', 'malformed');
});

test('rejects unsafe integers', () => {
  // one minor unit above Number.MAX_SAFE_INTEGER
  bad('90071992547409.92', 'unsafe-integer');
  bad('99999999999999999', 'unsafe-integer');
});
