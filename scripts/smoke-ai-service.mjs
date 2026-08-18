/**
 * Shared assertions for the AI services' smoke tests.
 *
 * The point of a smoke test here is that it runs unchanged against local
 * compose, CI, and the deployed CloudRun origin. MIU 2a's Done criterion is
 * that the same behaviour is proven in all three — so anything asserted here
 * must be true of a real deployment, not just of a laptop.
 */

import { decodeUtf8, fetchFully } from './smoke-http.mjs';

export function parseArgs(argv, fallbackBase) {
  // Both forms are supported on purpose: MIU 2a names the positional form
  // (`smoke-ai-bff.mjs <deployed-url>`), while `--base` reads better in CI.
  const flagIndex = argv.indexOf('--base');
  const positional = argv.slice(2).find((arg) => !arg.startsWith('--'));
  const base =
    (flagIndex >= 0 ? argv[flagIndex + 1] : undefined) ??
    positional ??
    process.env.SMOKE_BASE_URL ??
    fallbackBase;
  if (!base) throw new Error('no base URL: pass a URL, --base <url>, or set SMOKE_BASE_URL');
  return { base: base.replace(/\/+$/, '') };
}

export function createChecks() {
  const failures = [];
  return {
    check(name, condition, detail = '') {
      if (condition) {
        console.log(`  ok    ${name}`);
      } else {
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
        failures.push(name);
      }
    },
    finish(label) {
      if (failures.length > 0) {
        console.error(`\n${label}: ${failures.length} check(s) failed`);
        process.exit(1);
      }
      console.log(`\n${label}: all checks passed`);
    },
  };
}

export async function getJson(url, headers) {
  const res = await fetchFully('GET', url, { headers, timeoutMs: 15_000 });
  const text = decodeUtf8(res.body);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/**
 * Liveness and readiness, asserted the same way for both services.
 *
 * Readiness is checked for what it *established*, not merely for a 200. A
 * readiness endpoint that returns `{"ok":true}` after `select 1` also passes
 * against a read-only replica, and the takeover fence in LLD-001 §4.4 would
 * then fail in production having passed every smoke test.
 */
export async function checkHealthAndReadiness({ base, healthPath, readyPath, checks }) {
  const health = await getJson(`${base}${healthPath}`);
  checks.check('liveness returns 200', health.status === 200, `got ${health.status}`);
  checks.check('liveness body is ok', health.json?.ok === true, health.text.slice(0, 120));

  const ready = await getJson(`${base}${readyPath}`);
  checks.check('readiness returns 200', ready.status === 200, `got ${ready.status}`);
  checks.check(
    'readiness reports a live store',
    ready.json?.store === 'live',
    ready.text.slice(0, 120),
  );
  checks.check(
    'readiness proves a transaction and rollback',
    ready.json?.txn === 'proven',
    'readiness passed without proving a transaction',
  );
  checks.check(
    'store runs at READ COMMITTED',
    ready.json?.isolation === 'read committed',
    `isolation is "${ready.json?.isolation}" — LLD-001 §4.4 requires read committed`,
  );
  checks.check(
    'readiness leaks no connection string',
    !/postgres:\/\//.test(ready.text),
    'readiness body contained a connection string',
  );
  checks.check(
    'readiness leaks nothing credential-shaped',
    !/(password|secret|token)/i.test(ready.text),
    'readiness body looked credential-shaped',
  );
  return ready;
}
