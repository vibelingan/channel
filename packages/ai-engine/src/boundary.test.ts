/**
 * The boundary tests (LLD-002 §8 rule 1, §9 "Package boundary").
 *
 * These are the tests that keep the abstraction honest a year from now. The
 * port's whole value is that a vendor can be swapped through an ADR; the moment
 * a vendor name or an adapter import appears in this package, that stops being
 * true and nothing else would notice.
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Every source file except this one. The scanner necessarily contains the
 * vendor list it scans for, so exempting it is correct — but it is the ONLY
 * exemption, and adding a second one should be treated as suspicious.
 */
function sourceFiles(): string[] {
  const self = 'boundary.test.ts';
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith('.ts') && name !== self)
    .map((name) => join(SRC_DIR, name));
}

/**
 * Vendor and provider names that must never appear in the port package. The
 * list is the set named in the architecture as candidate engines — if a future
 * adapter introduces another, it belongs here too.
 */
const VENDOR_NAMES = [
  'hermes',
  'lexiang',
  '乐享',
  'deepseek',
  'anythingllm',
  'openai',
  'anthropic',
  'tencent',
  'adp',
];

test('no vendor name appears anywhere in the port package', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const contents = readFileSync(file, 'utf8').toLowerCase();
    for (const vendor of VENDOR_NAMES) {
      if (contents.includes(vendor)) {
        offenders.push(`${file.split('/').pop()}: '${vendor}'`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the port must name no vendor — a vendor-shaped port only fits that vendor',
  );
});

test('the port package imports nothing from an adapter package', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const contents = readFileSync(file, 'utf8');
    // Any cross-package import at all is suspect here: this package is meant to
    // be a leaf, depending on nothing but the standard library.
    const imports = contents.matchAll(/from\s+'([^']+)'/g);
    for (const match of imports) {
      const specifier = match[1] ?? '';
      const isRelative = specifier.startsWith('.');
      const isNodeBuiltin = specifier.startsWith('node:');
      if (!isRelative && !isNodeBuiltin) {
        offenders.push(`${file.split('/').pop()} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the port package must depend on nothing but relative modules and node builtins',
  );
});

test('the package declares no runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(SRC_DIR, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    manifest.dependencies,
    undefined,
    'a runtime dependency here becomes a dependency of every adapter and of the BFF',
  );
});

test('the port exposes no database, HTTP, or clock surface', () => {
  // LLD-002 §2: an adapter that receives a Response object or a database handle
  // has already lost the boundary. The port cannot be the thing that hands it
  // over, so these names must not appear in its type surface.
  const port = readFileSync(join(SRC_DIR, 'port.ts'), 'utf8');
  for (const forbidden of ['Response', 'Request<', 'Pool', 'Client<', 'Date.now']) {
    assert.ok(
      !port.includes(forbidden),
      `port.ts references '${forbidden}' — that belongs on the BFF side of the boundary`,
    );
  }
});
