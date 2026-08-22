/**
 * Local development stack exposure.
 *
 * `"58080:8080"` in a compose file binds 0.0.0.0 and ::, not localhost. This
 * stack publishes a PostgreSQL with static credentials, an AnythingLLM
 * administration surface, and — in harness mode — an unauthenticated chat
 * route. Published on every interface, all three are reachable by anything that
 * can reach the developer's machine.
 *
 * Verified against the RENDERED configuration where a Docker daemon is
 * available, because interpolation and overrides can change what a literal file
 * appears to say. Without a daemon it falls back to parsing the file, so the
 * invariant is still enforced in CI.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(repoRoot, 'docker-compose.ai.yml');

/** `[{ service, hostIp, published, target }]` — from the daemon when possible. */
function loadPublishedPorts() {
  const rendered = renderWithDocker();
  if (rendered) return { source: 'docker compose config', ports: rendered };
  return { source: 'docker-compose.ai.yml', ports: parseComposeFile() };
}

function renderWithDocker() {
  try {
    const json = execFileSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
        // The file uses `${ANYTHINGLLM_API_KEY:?...}`, so rendering fails
        // outright without a value. A placeholder keeps this check independent
        // of whether a developer has a real .env.ai — an earlier version
        // omitted it and silently fell back to file parsing while appearing to
        // verify the rendered configuration.
        env: {
          ...process.env,
          ANYTHINGLLM_API_KEY: process.env.ANYTHINGLLM_API_KEY ?? 'placeholder',
        },
      },
    );
    const config = JSON.parse(json);
    const ports = [];
    for (const [service, definition] of Object.entries(config.services ?? {})) {
      for (const port of definition.ports ?? []) {
        ports.push({
          service,
          hostIp: port.host_ip ?? null,
          published: String(port.published),
          target: String(port.target),
        });
      }
    }
    return ports;
  } catch {
    // No daemon, no docker binary, or an interpolation failure. The file-based
    // path below still enforces the rule.
    return null;
  }
}

function parseComposeFile() {
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const ports = [];
  for (const [service, definition] of Object.entries(compose.services ?? {})) {
    for (const entry of definition.ports ?? []) {
      // Short syntax only, which is all this file uses: [host_ip:]published:target
      const parts = String(entry).split(':');
      ports.push(
        parts.length === 3
          ? { service, hostIp: parts[0], published: parts[1], target: parts[2] }
          : { service, hostIp: null, published: parts[0], target: parts[1] },
      );
    }
  }
  return ports;
}

const { source, ports } = loadPublishedPorts();

test('the compose stack publishes at least one port, so the check is not vacuous', () => {
  // Printed so nobody reads a pass as daemon-verified when it was file-parsed.
  console.log(`      (bindings read from: ${source})`);
  assert.ok(ports.length > 0, `no published ports found via ${source}`);
});

test('the file and the rendered configuration agree, where a daemon exists', () => {
  const rendered = renderWithDocker();
  if (!rendered) {
    console.log('      (skipped: no Docker daemon — file parsing only)');
    return;
  }
  const asKey = (port) =>
    `${port.service} ${port.hostIp ?? 'ALL'}:${port.published}->${port.target}`;
  assert.deepEqual(
    rendered.map(asKey).sort(),
    parseComposeFile().map(asKey).sort(),
    'the rendered configuration differs from the literal file',
  );
});

test('every published port binds to loopback only', () => {
  // The finding this exists for: all four services bound 0.0.0.0 and ::, so a
  // laptop on shared wifi served its database, its engine console and an
  // unauthenticated assistant to the whole network.
  for (const port of ports) {
    assert.equal(
      port.hostIp,
      '127.0.0.1',
      `${port.service} publishes ${port.published} on ${port.hostIp ?? 'ALL INTERFACES'} (via ${source}); prefix it with 127.0.0.1`,
    );
  }
});

test('every published port stays in the 5xxxx range', () => {
  for (const port of ports) {
    const published = Number(port.published);
    assert.ok(
      published >= 50_000 && published <= 59_999,
      `${port.service} publishes ${port.published}, outside the 5xxxx range this file reserves`,
    );
  }
});

test('the harness flag appears only on a stack that is loopback-bound', () => {
  // The two properties are one decision. A harness-enabled service that is not
  // loopback-bound is an unauthenticated assistant on the network.
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  for (const [service, definition] of Object.entries(compose.services ?? {})) {
    const environment = definition.environment ?? {};
    if (String(environment.AI_LOCAL_HARNESS ?? '') !== '1') continue;
    const servicePorts = ports.filter((port) => port.service === service);
    assert.ok(servicePorts.length > 0, `${service} enables the harness but publishes nothing`);
    for (const port of servicePorts) {
      assert.equal(
        port.hostIp,
        '127.0.0.1',
        `${service} enables AI_LOCAL_HARNESS while published on ${port.hostIp ?? 'ALL INTERFACES'}`,
      );
    }
  }
});

test('the evaluation script defaults to the port compose actually publishes', () => {
  // These drifted: the script defaulted to 58090, a port only a hand-started
  // dev server ever used, so the documented `pnpm ai:eval` failed on every case
  // while `--base http://localhost:58080` passed.
  const bffPort = ports.find((port) => port.service === 'ai-bff');
  assert.ok(bffPort, 'compose no longer publishes ai-bff');

  const evalSource = readFileSync(join(repoRoot, 'scripts/ai-eval.mjs'), 'utf8');
  const defaults = [...evalSource.matchAll(/http:\/\/localhost:(\d+)/g)].map((match) => match[1]);
  assert.ok(defaults.length > 0, 'no default base URL found in ai-eval.mjs');
  for (const port of defaults) {
    assert.equal(
      port,
      bffPort.published,
      `ai-eval.mjs references port ${port} but compose publishes ai-bff on ${bffPort.published}`,
    );
  }
});

test('the runbook quotes the port compose publishes', () => {
  const bffPort = ports.find((port) => port.service === 'ai-bff');
  const runbook = readFileSync(join(repoRoot, 'docs/ai-platform/LOCAL-DEV-RUNBOOK.md'), 'utf8');
  const quoted = [...runbook.matchAll(/localhost:(\d{4,5})\/(?:dev\/chat|api\/ai)/g)].map(
    (m) => m[1],
  );
  for (const port of quoted) {
    assert.equal(port, bffPort.published, `the runbook sends developers to port ${port}`);
  }
});
