import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const emailSource = readFileSync(require.resolve('@vibelingan-channel/email'), 'utf8');
const handlerSource = readFileSync(fileURLToPath(new URL('./handler.ts', import.meta.url)), 'utf8');

test('OEM confirmation email uses the approved response time in text and HTML', () => {
  const oemEmail = emailSource.match(
    /export function sendOemConfirmationEmail[\s\S]*?return sendMail\(\{ to: data\.to, subject, html, text \}\);\n}/,
  );
  assert.ok(oemEmail, 'OEM confirmation email source exists');
  const lines = oemEmail[0].split('\n');
  const textLine = lines.find((line) => line.trimStart().startsWith('const text ='));
  const htmlLine = lines.find((line) => line.trimStart().startsWith('const html ='));
  assert.ok(textLine?.includes('respond within 24 hours.'));
  assert.ok(htmlLine?.includes('respond within 24 hours.</p>'));
  assert.equal((`${textLine}\n${htmlLine}`.match(/respond within 24 hours\./g) ?? []).length, 2);
  assert.doesNotMatch(`${textLine}\n${htmlLine}`, /business[-\s]+days?/i);
});

test('OEM submission keeps the existing best-effort confirmation payload', () => {
  const confirmationCall = handlerSource.match(
    /await sendOemConfirmationEmail\(\{([\s\S]*?)\}\)\.catch\(/,
  );
  assert.ok(confirmationCall, 'submitProject confirmation call exists');
  const payload = confirmationCall[1];
  assert.ok(payload, 'submitProject confirmation payload exists');
  for (const field of [
    'to: email.toLowerCase()',
    'contact',
    'company',
    "category: category ?? ''",
    'projectId: project._id',
  ]) {
    assert.ok(payload.includes(field), `confirmation payload retains ${field}`);
  }
});
