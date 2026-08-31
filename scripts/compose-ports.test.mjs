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

/**
 * Replace `${NAME:-default}` with its default.
 *
 * The published port became overridable when the two lines of work merged, and
 * a naive split on ':' turned `127.0.0.1:${AI_POSTGRES_PORT:-55432}:5432` into
 * four fields — which silently mis-parsed the host interface and would have let
 * the loopback check pass on a binding it never actually read. The default is
 * what the file declares, so it is what these checks are about.
 */
function expandComposeValue(entry, overrides = {}) {
  return String(entry).replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (_, name, fallback) =>
    Object.hasOwn(overrides, name) ? String(overrides[name]) : fallback,
  );
}

function expandDefaults(entry) {
  return expandComposeValue(entry);
}

function parseComposeFile() {
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const ports = [];
  for (const [service, definition] of Object.entries(compose.services ?? {})) {
    for (const entry of definition.ports ?? []) {
      // Short syntax only, which is all this file uses: [host_ip:]published:target
      const parts = expandDefaults(entry).split(':');
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

test('the disproven fail-closed claim appears nowhere in the deployment docs', () => {
  // R8 disproved "copying this file onto a real server fails loudly". The file
  // header was corrected and an identical claim was left standing on the BFF
  // service twenty lines below, so the false assurance stayed available to the
  // next reader. Correcting the readable copy is not the same as correcting the
  // artifact.
  const sources = [
    'docker-compose.ai.yml',
    'docs/ai-platform/LOCAL-DEV-RUNBOOK.md',
    'docs/ai-platform/REVIEW-TRIAGE-2026-08-19.md',
  ];
  // Phrases that assert compose itself fails closed. The corrected text says
  // the opposite, and quotes the old claim only to mark it wrong — so the
  // pattern requires the assertion, not a mention.
  const DISPROVEN = [
    /copying this file onto a real server fails loudly/i,
    /copying [^.\n]{0,40}compose[^.\n]{0,40} (?:therefore )?fails? (?:loudly|closed)/i,
  ];
  for (const relative of sources) {
    const text = readFileSync(join(repoRoot, relative), 'utf8');
    for (const pattern of DISPROVEN) {
      assert.ok(
        !pattern.test(text),
        `${relative} still asserts that copying compose fails closed; it does not`,
      );
    }
  }
});

test('no package collects its tests with an unquoted recursive glob', () => {
  // `sh` — which pnpm uses to run scripts — expands `src/**/*.test.ts` as a
  // SINGLE level. The moment a subdirectory appeared, apps/ai-bff silently
  // dropped from 76 tests to 27 and reported green, hiding eight real failures.
  // Quoting hands the pattern to Node, which expands it recursively.
  const packages = [
    'apps/ai-bff',
    'apps/ai-worker',
    'packages/ai-engine',
    'packages/ai-store',
    'packages/ai-engine-anythingllm',
  ];
  for (const relative of packages) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, relative, 'package.json'), 'utf8'));
    const script = manifest.scripts?.test ?? '';
    if (!script.includes('**')) continue;
    assert.match(
      script,
      /"[^"]*\*\*[^"]*"/,
      `${relative} test script has an unquoted ** glob, which sh collapses to one level: ${script}`,
    );
  }
});

test('the advertised engine ceiling matches the engine actually configured', () => {
  // Two operator assertions of the same number, in two services. A comment said
  // they must match and nothing enforced it, so one edit could make the BFF
  // advertise a cost ceiling the engine does not have — and the cost model
  // multiplies by it.
  // The engine moved from the BFF to the WORKER when the runtime split
  // generation out, so the consumer side of this pair moved with it. The check
  // is unchanged in substance: two operator assertions of the same number, in
  // two services, that nothing previously forced to agree.
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const advertised = expandDefaults(
    compose.services?.['ai-worker']?.environment?.AI_MAX_OUTPUT_TOKENS ?? '',
  );
  const configured = compose.services?.anythingllm?.environment?.GENERIC_OPEN_AI_MAX_TOKENS;
  assert.ok(advertised, 'ai-worker advertises no engine ceiling');
  assert.ok(configured, 'the engine declares no generation ceiling');
  assert.equal(
    String(advertised),
    String(configured),
    `ai-worker advertises ${advertised} while the engine is configured for ${configured}`,
  );
});

test('the retired output-limit name is gone from code and design docs', () => {
  // Three files kept saying maxOutputTokens after the rename, each stating a
  // bound the implementation does not provide. A contract that reads two ways
  // is worse than one that reads wrongly, because both readers think they are
  // right.
  const surfaces = [
    'packages/ai-engine/src/port.ts',
    'packages/ai-engine/src/capabilities.ts',
    'packages/ai-engine-anythingllm/src/engine.ts',
    'apps/ai-worker/src/worker.ts',
    'docs/ai-platform/LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md',
    'docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md',
    'docs/ai-platform/ENGINE-EVALUATION-ANYTHINGLLM.md',
  ];
  // Two uses are legitimate and must NOT be flagged, or the check becomes a
  // nuisance that gets deleted: naming the retired field while explaining the
  // rename, and quoting the vendor REQUEST fields that were probed and ignored.
  const HISTORICAL =
    /renamed from|was called|formerly|retired|request body|all ignored|accepted with/i;

  for (const relative of surfaces) {
    const lines = readFileSync(join(repoRoot, relative), 'utf8').split('\n');
    const stale = lines.filter((line, index) => {
      const uses = [...line.matchAll(/(\w*)maxOutputTokens/g)].filter(
        (match) => match[1] !== 'vendor',
      );
      if (uses.length === 0) return false;
      // The explanation can wrap, so accept the sentence around it too.
      const context = [lines[index - 1] ?? '', line, lines[index + 1] ?? ''].join(' ');
      return !HISTORICAL.test(context);
    });
    assert.deepEqual(
      stale,
      [],
      `${relative} still states a live contract in terms of maxOutputTokens`,
    );
  }
});

test('no committed file is an absolute symlink', () => {
  // R15: a link to /Users/<someone>/.claude/… was swept into a feature commit.
  // It resolves only on one machine; everywhere else it dangles and points
  // outside the repository.
  const listing = execFileSync('git', ['ls-files', '-s'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  for (const line of listing.split('\n')) {
    if (!line.startsWith('120000')) continue;
    const path = line.split('\t')[1];
    const target = execFileSync('git', ['cat-file', '-p', line.split(/\s+/)[1]], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.ok(
      !target.startsWith('/'),
      `${path} is a symlink to an absolute path (${target.slice(0, 60)})`,
    );
  }
});

test('the abandoned-run cost bound is stated as the vendor ceiling everywhere', () => {
  // Both LLDs described the waste from a dead worker's run. One said the bound
  // was the delivered-output budget, which bounds only what we RECEIVE and
  // therefore says nothing about what the vendor keeps generating after we stop
  // listening. Two documents giving different bounds for the same cost is worse
  // than one giving the wrong bound.
  for (const relative of [
    'docs/ai-platform/LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md',
    'docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md',
    'packages/ai-engine/src/capabilities.ts',
  ]) {
    const text = readFileSync(join(repoRoot, relative), 'utf8');
    for (const match of text.matchAll(/bound(?:ed)? (?:by|is) ([^.\n]{0,80})/gi)) {
      const claim = match[1];
      if (!/output|token|unit|waste|generat/i.test(claim)) continue;
      assert.ok(
        !/maxDeliveredOutputUnits/.test(claim) || /NOT `maxDeliveredOutputUnits`/.test(claim),
        `${relative} bounds vendor cost by the delivered-output budget: "${claim.trim()}"`,
      );
    }
  }
});

test('no service runs a mutable image tag', () => {
  // `latest` means the engine can change under a stack whose answers are its
  // whole product — silently, with no diff, and with no way to tell afterwards
  // which version produced an answer a customer is quoting back at you.
  // ADR-002 §4 required a pinned digest; the compose file said `latest`.
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const MUTABLE = /:(?:latest|main|master|stable|edge|dev)$/;
  for (const [service, definition] of Object.entries(compose.services ?? {})) {
    const image = definition.image;
    if (!image) continue; // built from a Dockerfile in this repo
    assert.ok(!MUTABLE.test(image), `${service} runs a mutable tag (${image}); pin it by digest`);
  }
});

test('the third-party engine is pinned by digest, not merely by version', () => {
  // A version tag is still mutable — a vendor can republish it. Only a digest
  // names the exact bytes.
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const engine = compose.services?.anythingllm?.image ?? '';
  assert.match(engine, /@sha256:[0-9a-f]{64}$/, `the engine image is not digest-pinned: ${engine}`);
});

test('fake defaults and explicit AnythingLLM provenance stay consistent across services', () => {
  // Compose starts safely and without cost on the fake engine. AnythingLLM is
  // an explicit opt-in, at which point both services must attest the exact
  // version and digest of the image this stack runs.
  const composeText = readFileSync(COMPOSE_FILE, 'utf8');
  const compose = parseYaml(composeText);
  const bffEnv = compose.services?.['ai-bff']?.environment ?? {};
  const workerEnv = compose.services?.['ai-worker']?.environment ?? {};
  for (const [service, environment] of [
    ['ai-bff', bffEnv],
    ['ai-worker', workerEnv],
  ]) {
    assert.equal(
      expandDefaults(environment.AI_ENGINE_ID ?? ''),
      'fake',
      `${service} default engine`,
    );
    assert.equal(
      expandDefaults(environment.AI_ENGINE_VERSION ?? ''),
      '0.1.0',
      `${service} fake-engine version`,
    );
    assert.equal(
      expandDefaults(environment.AI_ENGINE_IMAGE_DIGEST ?? ''),
      '',
      `${service} must not claim an image digest for the in-process fake engine`,
    );
    assert.equal(
      expandDefaults(environment.AI_ENGINE_PROVENANCE_KIND ?? ''),
      '',
      `${service} must not claim OCI provenance for the in-process fake engine`,
    );
  }

  const running = String(compose.services?.anythingllm?.image ?? '').split('@')[1] ?? '';
  const documented = composeText.match(/#\s*anythingllm\s+(\d+\.\d+\.\d+)\b/i)?.[1];
  assert.ok(documented, 'the digest is not accompanied by a version comment naming its release');

  const anythingllm = {
    AI_ENGINE_ID: 'anythingllm',
    AI_ENGINE_VERSION: documented,
    AI_ENGINE_PROVENANCE_KIND: 'oci',
    AI_ENGINE_IMAGE_DIGEST: running,
  };
  for (const [service, environment] of [
    ['ai-bff', bffEnv],
    ['ai-worker', workerEnv],
  ]) {
    assert.equal(expandComposeValue(environment.AI_ENGINE_ID ?? '', anythingllm), 'anythingllm');
    assert.equal(
      expandComposeValue(environment.AI_ENGINE_VERSION ?? '', anythingllm),
      documented,
      `${service} does not advertise the reviewed AnythingLLM version`,
    );
    assert.equal(
      expandComposeValue(environment.AI_ENGINE_PROVENANCE_KIND ?? '', anythingllm),
      'oci',
      `${service} does not declare OCI provenance for AnythingLLM`,
    );
    assert.equal(
      expandComposeValue(environment.AI_ENGINE_IMAGE_DIGEST ?? '', anythingllm),
      running,
      `${service} does not attest the digest the stack runs`,
    );
  }
});
