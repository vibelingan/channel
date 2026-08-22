/**
 * CloudRun manifest drift contract (MIU 2a).
 *
 * The manifest is only worth having if it cannot quietly disagree with reality.
 * These tests pin it against the things it would otherwise drift from: the
 * workspace, the Dockerfiles, the compose file, and the servers' own routes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  CLOUDRUN_SERVICE_NAMES,
  FORBIDDEN_ENV_KEYS,
  SECRET_ENV_KEYS,
  buildCloudRunServiceDefs,
} from './cloudrun-service-manifest.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ctx = {
  envId: 'env-fixture',
  appEnv: 'test',
  imageTag: 'registry.example/channel@sha256:deadbeef',
  siteOrigins: 'https://site.example',
  requireEnv: (name) => `secret://${name}`,
  optionalEnv: () => undefined,
};
const defs = buildCloudRunServiceDefs(ctx);

test('a floating image tag is refused', () => {
  assert.throws(() => buildCloudRunServiceDefs({ ...ctx, imageTag: undefined }), /imageTag/);
});

test('every deployable AI app is in the manifest', () => {
  // The point of the whole file. A new apps/ai-* package that nobody adds here
  // would deploy by hand once and then never again — or never at all.
  const onDisk = readdirSync(join(repoRoot, 'apps'))
    .filter((name) => name.startsWith('ai-'))
    .sort();
  assert.deepEqual([...CLOUDRUN_SERVICE_NAMES].sort(), onDisk);
  assert.deepEqual(defs.map((d) => d.name).sort(), onDisk);
});

test('every declared Dockerfile and package actually exists', () => {
  for (const def of defs) {
    assert.ok(existsSync(join(repoRoot, def.dockerfile)), `missing ${def.dockerfile}`);
    const pkgPath = join(repoRoot, 'apps', def.name, 'package.json');
    assert.ok(existsSync(pkgPath), `missing ${pkgPath}`);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    assert.equal(pkg.name, def.workspacePackage);
    assert.ok(pkg.scripts?.start, `${def.name} has no start script to run in the container`);
  }
});

test('container ports match the local compose stack', () => {
  // Local and deployed must agree, or "it works in compose" stops being
  // evidence about production — which is exactly what MIU 2a claims it is.
  const compose = parseYaml(readFileSync(join(repoRoot, 'docker-compose.ai.yml'), 'utf8'));
  for (const def of defs) {
    const service = compose.services[def.name];
    assert.ok(service, `docker-compose.ai.yml has no ${def.name} service`);
    assert.equal(String(service.environment.PORT), String(def.containerPort));
    // Short syntax is [host_ip:]published:target, so the CONTAINER port is the
    // last segment. Assuming two segments broke the moment ports were bound to
    // 127.0.0.1 and grew a third.
    const containerPorts = service.ports.map((entry) => String(entry).split(':').at(-1));
    assert.ok(
      containerPorts.includes(String(def.containerPort)),
      `${def.name} does not publish container port ${def.containerPort} in compose`,
    );
  }
});

test('every declared health and readiness path is implemented by its service', () => {
  const sources = {
    'ai-bff': readFileSync(join(repoRoot, 'apps/ai-bff/src/server.ts'), 'utf8'),
    'ai-worker': readFileSync(join(repoRoot, 'apps/ai-worker/src/worker.ts'), 'utf8'),
  };
  for (const def of defs) {
    assert.ok(sources[def.name].includes(def.healthPath), `${def.name} lacks ${def.healthPath}`);
    assert.ok(sources[def.name].includes(def.readyPath), `${def.name} lacks ${def.readyPath}`);
  }
});

test('the worker is never publicly exposed', () => {
  // It has no visitor-facing route and never should; publishing it would put a
  // health surface and the run machinery on the internet for no benefit.
  assert.equal(defs.find((d) => d.name === 'ai-worker').publicAccess, false);
  assert.equal(defs.find((d) => d.name === 'ai-bff').publicAccess, true);
});

test('neither service is allowed to scale to zero', () => {
  // Different reasons, same requirement: the BFF would make the hour's first
  // visitor wait out a cold start, and the worker would have nothing running to
  // drain the outbox, so a queued run would never begin.
  for (const def of defs) assert.ok(def.minNum >= 1, `${def.name} may scale to zero`);
});

test('no secret is inlined; secrets arrive through requireEnv', () => {
  for (const def of defs) {
    for (const key of SECRET_ENV_KEYS) {
      const value = def.envVariables[key];
      if (value === undefined) continue;
      assert.ok(
        value.startsWith('secret://'),
        `${def.name}.${key} is a literal in the manifest, not a secret reference`,
      );
    }
  }
});

test('the BFF gets its CORS allowlist and the worker does not', () => {
  const bff = defs.find((d) => d.name === 'ai-bff');
  const worker = defs.find((d) => d.name === 'ai-worker');
  assert.equal(bff.envVariables.CORS_ALLOWED_ORIGINS, ctx.siteOrigins);
  assert.equal(worker.envVariables.CORS_ALLOWED_ORIGINS, undefined);
});

test('no deployed service may switch on the local harness', () => {
  // Defence before the service's own startup refusal, not instead of it. A
  // manifest that sets this is wrong even if the process would reject it,
  // because the next reader assumes the manifest describes something valid.
  for (const def of defs) {
    for (const key of FORBIDDEN_ENV_KEYS) {
      assert.equal(
        def.envVariables[key],
        undefined,
        `${def.name} sets ${key}, which must never appear in a deployed service`,
      );
    }
  }
});

test('every deployed service declares itself production', () => {
  // The harness refusal keys off NODE_ENV/APP_ENV. If a deployed service left
  // both unset, the last line of defence would never fire.
  for (const def of defs) {
    assert.equal(def.envVariables.NODE_ENV, 'production', `${def.name} is not marked production`);
  }
});

test('the manifest declares no gateway prefix route', () => {
  // MIU 2a is explicit: /api and /api/admin already belong to public-api and
  // admin. A route here would divert storefront traffic, not gain assistant
  // traffic. The BFF is reached on its own CloudRun hostname instead.
  for (const def of defs) assert.equal(def.routePath, undefined);
});
