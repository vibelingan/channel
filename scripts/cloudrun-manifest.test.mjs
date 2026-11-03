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
  vpc: { vpcId: 'vpc-fixture', subnetId: 'subnet-fixture' },
  siteOrigins: 'https://site.example',
  engineId: 'anythingllm',
  engineProvenanceKind: 'oci',
  requireEnv: (name) => `secret://${name}`,
  optionalEnv: () => undefined,
};
const defs = buildCloudRunServiceDefs(ctx);
const vibekb = (optional = {}) =>
  buildCloudRunServiceDefs({ ...ctx, engineId: 'vibekb', optionalEnv: (name) => optional[name] });
const byName = (list, name) => list.find((d) => d.name === name);

test('each service is built by CloudRun from its own Dockerfile, not from a pre-built image', () => {
  // Deploys upload a clean copy of the tested commit and CloudRun runs the
  // Dockerfile, so nothing here may point at an image built somewhere else.
  for (const def of defs) {
    assert.equal(def.image, undefined, `${def.name} still names a pre-built image`);
    assert.equal(def.dockerfile, `apps/${def.name}/Dockerfile`);
    assert.equal(def.buildContext, '.', 'the Dockerfiles copy the whole workspace');
  }
});

test('both services join the database VPC through the CloudRun subnet', () => {
  // PostgreSQL only accepts connections from that subnet, so a service outside
  // it cannot reach the database at all.
  for (const def of defs) assert.deepEqual(def.vpc, ctx.vpc, `${def.name} is not in the VPC`);
  assert.throws(() => buildCloudRunServiceDefs({ ...ctx, vpc: undefined }), /VPC/);
  assert.throws(
    () => buildCloudRunServiceDefs({ ...ctx, vpc: { vpcId: 'vpc-fixture', subnetId: '' } }),
    /VPC/,
  );
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
    assert.equal(
      String(def.envVariables.PORT),
      String(def.containerPort),
      `${def.name} listens on a different port than CloudRun routes`,
    );
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

test('the production services carry every runtime gate needed by the local Phase 1 path', () => {
  const required = {
    'ai-bff': [
      'DATABASE_URL',
      'CORS_ALLOWED_ORIGINS',
      'AI_ENGINE_ID',
      'AI_ENGINE_VERSION',
      'AI_ENGINE_IMAGE_DIGEST',
      'AI_IP_HASH_SECRET',
      'AI_TRUST_PROXY',
    ],
    'ai-worker': [
      'DATABASE_URL',
      'AI_ENGINE_ID',
      'AI_ENGINE_VERSION',
      'AI_ENGINE_IMAGE_DIGEST',
      'AI_PROFILE_ID',
      'AI_WORKER_LEASE_SECONDS',
      'AI_MAX_STREAM_DURATION_MS',
      'AI_MAX_OUTPUT_TOKENS',
      'AI_MAX_TOOL_CALLS',
      'KB_BASE_URL',
      'KB_API_KEY',
      'KB_WORKSPACE_SLUG',
      'KB_WORKSPACE_ID',
      'AI_KNOWLEDGE_CREDENTIAL_ID',
      'KB_CITATIONS_VERIFIED',
      'KB_CREDENTIAL_ROTATION',
      'AI_CORPUS_GENERATION',
      'AI_KB_EVIDENCE_JSON',
      'AI_APPROVED_SOURCE_PREFIX',
      'AI_SITE_ORIGIN',
    ],
  };
  for (const def of defs) {
    for (const key of required[def.name]) {
      assert.notEqual(def.envVariables[key], undefined, `${def.name} is missing ${key}`);
    }
  }
});

test('BFF and worker attest the same engine identity in local compose', () => {
  const compose = parseYaml(readFileSync(join(repoRoot, 'docker-compose.ai.yml'), 'utf8'));
  for (const key of ['AI_ENGINE_ID', 'AI_ENGINE_VERSION', 'AI_ENGINE_IMAGE_DIGEST']) {
    assert.equal(
      compose.services['ai-bff'].environment[key],
      compose.services['ai-worker'].environment[key],
      `local BFF and worker disagree on ${key}`,
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

test('git provenance emits commit and repository, never an image digest', () => {
  const defs = buildCloudRunServiceDefs({ ...ctx, engineProvenanceKind: 'git' });
  for (const def of defs) {
    assert.equal(def.envVariables.AI_ENGINE_PROVENANCE_KIND, 'git');
    assert.equal(def.envVariables.AI_ENGINE_GIT_COMMIT, 'secret://AI_ENGINE_GIT_COMMIT');
    assert.equal(def.envVariables.AI_ENGINE_GIT_REPOSITORY, 'secret://AI_ENGINE_GIT_REPOSITORY');
    assert.equal(def.envVariables.AI_ENGINE_CONFIG_DIGEST, 'secret://AI_ENGINE_CONFIG_DIGEST');
    assert.equal(
      def.envVariables.AI_ENGINE_IMAGE_DIGEST,
      undefined,
      `${def.name} still claims an image digest while running a git checkout`,
    );
  }
});

test('BFF and worker are given IDENTICAL provenance', () => {
  // The BFF stamps the run row and the worker serves the run. If they disagree,
  // every run records a provenance nothing can check.
  for (const kind of ['oci', 'git']) {
    const [bff, worker] = buildCloudRunServiceDefs({ ...ctx, engineProvenanceKind: kind });
    const keys = Object.keys(bff.envVariables).filter((k) => k.startsWith('AI_ENGINE_'));
    for (const key of keys.filter(
      (k) => k.includes('PROVENANCE') || k.includes('GIT') || k.includes('DIGEST'),
    )) {
      assert.equal(worker.envVariables[key], bff.envVariables[key], `${key} differs (${kind})`);
    }
  }
});

test('an unknown provenance kind is refused rather than defaulted', () => {
  assert.throws(
    () => buildCloudRunServiceDefs({ ...ctx, engineProvenanceKind: 'sha' }),
    /must be "oci" or "git"/,
  );
  assert.throws(
    () => buildCloudRunServiceDefs({ ...ctx, engineProvenanceKind: undefined }),
    /must be/,
  );
});

test('a vibekb worker gets the model, the MCP knowledge scope and the catalog, not the AnythingLLM settings', () => {
  const worker = byName(vibekb(), 'ai-worker');
  for (const key of [
    'AI_MODEL_BASE_URL',
    'AI_MODEL_ID',
    'AI_MODEL_API_KEY',
    'VIBEKB_MCP_URL',
    'VIBEKB_MCP_API_KEY',
    'VIBEKB_PUBLIC_WORKSPACE_ID',
    'VIBEKB_PUBLIC_DOCUMENT_IDS',
    'AI_PUBLIC_CATALOG_ORIGIN',
  ]) {
    assert.notEqual(worker.envVariables[key], undefined, `ai-worker is missing ${key}`);
  }
  for (const key of ['KB_BASE_URL', 'KB_API_KEY', 'AI_KB_EVIDENCE_JSON', 'KB_WORKSPACE_ID']) {
    assert.equal(worker.envVariables[key], undefined, `a vibekb worker must not carry ${key}`);
  }
  assert.equal(worker.envVariables.AI_ENGINE_ID, 'vibekb');
  assert.equal(byName(vibekb(), 'ai-bff').envVariables.AI_ENGINE_ID, 'vibekb');
  // Optional settings are left out when unset, and passed through when set.
  assert.equal('AI_MODEL_THINKING_MODE' in worker.envVariables, false);
  const tuned = byName(vibekb({ AI_MODEL_THINKING_MODE: 'disabled' }), 'ai-worker');
  assert.equal(tuned.envVariables.AI_MODEL_THINKING_MODE, 'disabled');
});

test('the model and MCP keys are secrets, never literals', () => {
  for (const key of ['AI_MODEL_API_KEY', 'VIBEKB_MCP_API_KEY', 'AI_INQUIRY_TOKEN']) {
    assert.ok(SECRET_ENV_KEYS.includes(key), `${key} must be a secret`);
  }
  for (const def of vibekb({ AI_INQUIRY_ENABLED: '1' })) {
    for (const key of SECRET_ENV_KEYS) {
      const value = def.envVariables[key];
      if (value !== undefined) assert.ok(value.startsWith('secret://'), `${def.name}.${key}`);
    }
  }
});

test('the BFF reaches the sales intake only when inquiries are switched on', () => {
  const off = byName(vibekb(), 'ai-bff');
  for (const key of ['AI_INQUIRY_ENABLED', 'AI_INQUIRY_BASE_URL', 'AI_INQUIRY_TOKEN']) {
    assert.equal(off.envVariables[key], undefined, `${key} is set while inquiries are off`);
  }
  const on = byName(vibekb({ AI_INQUIRY_ENABLED: '1' }), 'ai-bff');
  assert.equal(on.envVariables.AI_INQUIRY_ENABLED, '1');
  assert.equal(on.envVariables.AI_INQUIRY_BASE_URL, 'secret://AI_INQUIRY_BASE_URL');
  assert.equal(on.envVariables.AI_INQUIRY_TOKEN, 'secret://AI_INQUIRY_TOKEN');
  // The worker never holds the intake token.
  assert.equal(
    byName(vibekb({ AI_INQUIRY_ENABLED: '1' }), 'ai-worker').envVariables.AI_INQUIRY_TOKEN,
    undefined,
  );
});

test('an unknown engine is refused rather than deployed with half its settings', () => {
  assert.throws(
    () => buildCloudRunServiceDefs({ ...ctx, engineId: 'fake' }),
    /AI_ENGINE_ID must be one of anythingllm, vibekb/,
  );
});

test('the developer-only plain-HTTP MCP switch can never be deployed', () => {
  assert.ok(FORBIDDEN_ENV_KEYS.includes('VIBEKB_MCP_ALLOW_LOOPBACK_HTTP'));
  for (const def of vibekb())
    assert.equal(def.envVariables.VIBEKB_MCP_ALLOW_LOOPBACK_HTTP, undefined);
});
