import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  type DeploymentCompensations,
  type EngineCapabilities,
  assertEngineUsable,
  assertProvenance,
  describeEngineRefusals,
  describeProvenance,
  provenanceFromEnv,
} from './capabilities.ts';

/**
 * A capability set with every guarantee present, and a deployment with no
 * compensating control configured. Each test below removes exactly one thing,
 * so a failure names the rule that broke rather than "something is off".
 */
function fullCapabilities(overrides: Partial<EngineCapabilities> = {}): EngineCapabilities {
  return {
    engineId: 'fake',
    engineVersion: '0.0.0-test',
    supportsIdempotentCreate: true,
    supportsRunLookupByOperationId: true,
    supportsStop: true,
    supportsOutOfBandStop: true,
    supportsCitations: true,
    ...overrides,
  };
}

function deployment(overrides: Partial<DeploymentCompensations> = {}): DeploymentCompensations {
  return {
    operationIdMappingLayerConfigured: false,
    unrecordedHandleRecoveryConfigured: false,
    answerPolicyRequiresCitations: true,
    knowledgeSourceConfigured: true,
    ...overrides,
  };
}

test('a fully capable engine with a configured knowledge source is usable', () => {
  assert.doesNotThrow(() => assertEngineUsable(fullCapabilities(), deployment()));
  assert.deepEqual(describeEngineRefusals(fullCapabilities(), deployment()), []);
});

test('refuses when the OWNING worker cannot cancel its own run', () => {
  const caps = fullCapabilities({ supportsStop: false });
  assert.throws(() => assertEngineUsable(caps, deployment()), /supportsStop/);
  assert.equal(describeEngineRefusals(caps, deployment()).length, 1);
});

test('does NOT refuse an engine lacking out-of-band stop', () => {
  // A whole family of chat protocols is in this position: cancellation there is
  // closing the connection, which only the owner can do. LLD-001's fence still
  // guarantees no text commits after takeover, so the cost is bounded token
  // waste, not a correctness hole — blocking startup on it would rule out most
  // of the available engines for no safety gain.
  const caps = fullCapabilities({ supportsOutOfBandStop: false });
  assert.doesNotThrow(() => assertEngineUsable(caps, deployment()));
  assert.deepEqual(describeEngineRefusals(caps, deployment()), []);
});

test('refuses non-idempotent create when no mapping layer compensates for it', () => {
  const caps = fullCapabilities({ supportsIdempotentCreate: false });
  assert.throws(() => assertEngineUsable(caps, deployment()), /mapping layer/);
});

test('accepts non-idempotent create once the mapping layer is configured', () => {
  const caps = fullCapabilities({ supportsIdempotentCreate: false });
  assert.doesNotThrow(() =>
    assertEngineUsable(caps, deployment({ operationIdMappingLayerConfigured: true })),
  );
});

test('refuses when an unrecorded run handle could never be recovered or stopped', () => {
  const caps = fullCapabilities({ supportsRunLookupByOperationId: false });
  assert.throws(() => assertEngineUsable(caps, deployment()), /recover/i);
});

test('accepts no lookup capability when another recovery route is configured', () => {
  const caps = fullCapabilities({ supportsRunLookupByOperationId: false });
  assert.doesNotThrow(() =>
    assertEngineUsable(caps, deployment({ unrecordedHandleRecoveryConfigured: true })),
  );
});

test('refuses missing citation support only while the policy requires citations', () => {
  const caps = fullCapabilities({ supportsCitations: false });
  assert.throws(() => assertEngineUsable(caps, deployment()), /citation/i);
  assert.doesNotThrow(() =>
    assertEngineUsable(caps, deployment({ answerPolicyRequiresCitations: false })),
  );
});

test('refuses an unconfigured knowledge source — absent is not the same as unreachable', () => {
  // The repo precedent this guards against: the public catalog treats a missing
  // JWT_SECRET as "anonymous viewer" and serves on. The same shape here would
  // yield an assistant with no retrieval answering from the model's own memory.
  const refusals = describeEngineRefusals(
    fullCapabilities(),
    deployment({ knowledgeSourceConfigured: false }),
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? '', /knowledge source/i);
});

test('reports every independent refusal at once, not just the first', () => {
  const caps = fullCapabilities({
    supportsStop: false,
    supportsCitations: false,
    supportsIdempotentCreate: false,
  });
  const refusals = describeEngineRefusals(caps, deployment({ knowledgeSourceConfigured: false }));
  // Operators fixing a misconfiguration should see all of it in one pass rather
  // than rediscovering the next problem on each restart.
  assert.equal(refusals.length, 4);
});

test('the thrown error names every reason, so a restart loop is diagnosable', () => {
  const caps = fullCapabilities({ supportsStop: false, supportsCitations: false });
  assert.throws(
    () => assertEngineUsable(caps, deployment()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /supportsStop/);
      assert.match(error.message, /citation/i);
      return true;
    },
  );
});

/**
 * Provenance must not be able to lie about which KIND of artifact it names.
 * The whole failure this replaces was a well-typed `string` holding a Git SHA
 * in a field called `imageDigest`.
 */
test('a git commit offered as an image digest is refused', () => {
  assert.throws(
    () => assertProvenance({ kind: 'oci', imageDigest: 'a'.repeat(40) }),
    /not a sha256 image digest[\s\S]*declare kind "git"/,
  );
});

test('a placeholder is refused as an image digest', () => {
  for (const bad of ['unpinned', 'sha256:deadbeef', '', 'latest']) {
    assert.throws(() => assertProvenance({ kind: 'oci', imageDigest: bad }), /not a sha256/);
  }
});

test('a real oci digest and a real git commit are both accepted', () => {
  assert.doesNotThrow(() =>
    assertProvenance({ kind: 'oci', imageDigest: `sha256:${'a'.repeat(64)}` }),
  );
  assert.doesNotThrow(() =>
    assertProvenance({
      kind: 'git',
      commit: 'b'.repeat(40),
      repository: 'vibelingan/channel',
      configDigest: `sha256:${'c'.repeat(64)}`,
    }),
  );
});

test('a git commit with no repository names nothing anyone can find', () => {
  assert.throws(
    () =>
      assertProvenance({
        kind: 'git',
        commit: 'b'.repeat(40),
        repository: '  ',
        configDigest: `sha256:${'c'.repeat(64)}`,
      }),
    /needs the repository/,
  );
});

test('an abbreviated commit is refused', () => {
  assert.throws(
    () =>
      assertProvenance({
        kind: 'git',
        commit: 'b'.repeat(12),
        repository: 'r',
        configDigest: `sha256:${'c'.repeat(64)}`,
      }),
    /not a 40-character commit sha/,
  );
});

test('the environment parser refuses a deployment that will not say what it runs', () => {
  assert.throws(() => provenanceFromEnv({}), /must be "oci" or "git"/);
  assert.throws(
    () => provenanceFromEnv({ AI_ENGINE_PROVENANCE_KIND: 'git' }),
    /AI_ENGINE_GIT_COMMIT is required/,
  );
  assert.throws(
    () =>
      provenanceFromEnv({
        AI_ENGINE_PROVENANCE_KIND: 'oci',
        AI_ENGINE_IMAGE_DIGEST: 'a'.repeat(40),
      }),
    /not a sha256 image digest/,
  );
  assert.deepEqual(
    provenanceFromEnv({
      AI_ENGINE_PROVENANCE_KIND: 'git',
      AI_ENGINE_GIT_COMMIT: 'c'.repeat(40),
      AI_ENGINE_GIT_REPOSITORY: 'vibelingan/channel',
      AI_ENGINE_CONFIG_DIGEST: `sha256:${'d'.repeat(64)}`,
    }),
    {
      kind: 'git',
      commit: 'c'.repeat(40),
      repository: 'vibelingan/channel',
      configDigest: `sha256:${'d'.repeat(64)}`,
    },
  );
});

test('the description never leaks anything but the identity itself', () => {
  assert.equal(
    describeProvenance({
      kind: 'git',
      commit: 'd'.repeat(40),
      repository: 'vibelingan/channel',
      configDigest: `sha256:${'e'.repeat(64)}`,
    }),
    `git:vibelingan/channel@${'d'.repeat(40)}+cfg:sha256:${'e'.repeat(64)}`,
  );
});

test('git provenance refuses a missing or malformed configuration digest', () => {
  assert.throws(
    () =>
      assertProvenance({
        kind: 'git',
        commit: 'b'.repeat(40),
        repository: 'vibelingan/channel',
        configDigest: '',
      }),
    /CONFIG_DIGEST/,
  );
});
