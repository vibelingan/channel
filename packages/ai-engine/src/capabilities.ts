/**
 * The capability descriptor (LLD-002 §7).
 *
 * This is the mechanism that stops an unproven assumption from becoming a
 * silent one. An adapter declares what its vendor actually guarantees, and the
 * process refuses to serve when a guarantee is missing and nothing compensates
 * for it — at startup, rather than at the first visitor.
 */

/**
 * An immutable name for the artifact that served a run.
 *
 * `oci` is the strong form: a digest names exact bytes anyone can pull.
 * `git` is the honest weaker form for a source checkout — a commit alone is not
 * enough to reproduce a running service, so it carries the repository it came
 * from and, where the deployment has one, a digest over the configuration that
 * was applied on top. Both are auditable; neither pretends to be the other.
 */
export type EngineProvenance =
  | { kind: 'oci'; imageDigest: string }
  | { kind: 'git'; commit: string; repository: string; configDigest: string };

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const CONFIG_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Reject provenance that cannot be what it claims.
 *
 * Shape-checking here rather than trusting the caller: the whole failure this
 * replaces was a well-typed `string` holding the wrong kind of identifier.
 */
export function assertProvenance(value: EngineProvenance): EngineProvenance {
  if (value.kind === 'oci') {
    if (!OCI_DIGEST.test(value.imageDigest)) {
      throw new Error(
        `engine provenance declares kind "oci" but ${JSON.stringify(value.imageDigest)} is not a sha256 image digest. A git commit is not an image digest; declare kind "git" instead.`,
      );
    }
    return value;
  }
  if (!GIT_COMMIT.test(value.commit)) {
    throw new Error(
      `engine provenance declares kind "git" but ${JSON.stringify(value.commit)} is not a 40-character commit sha.`,
    );
  }
  if (!value.repository.trim()) {
    throw new Error(
      'engine provenance of kind "git" needs the repository it came from; a commit alone names nothing you can find.',
    );
  }
  if (!CONFIG_DIGEST.test(value.configDigest)) {
    throw new Error(
      'engine provenance of kind "git" needs AI_ENGINE_CONFIG_DIGEST as sha256:<64 lowercase hex>; a commit does not identify the deployed service configuration.',
    );
  }
  return value;
}

/**
 * Read provenance from the environment, saying which KIND of artifact it names.
 *
 * Lives beside the contract rather than in either process, because the BFF
 * stamps the run row and the worker serves the run: if they parsed this
 * separately they could disagree, and a run's provenance would be
 * unfalsifiable — the one property it exists to provide.
 */
export function provenanceFromEnv(env: Record<string, string | undefined>): EngineProvenance {
  const kind = env.AI_ENGINE_PROVENANCE_KIND?.trim();
  if (kind === 'oci') {
    return assertProvenance({
      kind: 'oci',
      imageDigest: requiredVar(env, 'AI_ENGINE_IMAGE_DIGEST'),
    });
  }
  if (kind === 'git') {
    return assertProvenance({
      kind: 'git',
      commit: requiredVar(env, 'AI_ENGINE_GIT_COMMIT'),
      repository: requiredVar(env, 'AI_ENGINE_GIT_REPOSITORY'),
      configDigest: requiredVar(env, 'AI_ENGINE_CONFIG_DIGEST'),
    });
  }
  throw new Error(
    'AI_ENGINE_PROVENANCE_KIND must be "oci" or "git". Every run records what produced it, ' +
      'and a deployment that cannot say which kind of artifact it runs cannot be audited.',
  );
}

function requiredVar(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** One short line for logs and readiness. Never a secret, never a host. */
export function describeProvenance(value: EngineProvenance): string {
  return value.kind === 'oci'
    ? `oci:${value.imageDigest}`
    : `git:${value.repository}@${value.commit}+cfg:${value.configDigest}`;
}

export interface EngineCapabilities {
  /** Short adapter identifier. Recorded on every run row so an incident can be scoped. */
  engineId: string;
  /** Pinned release. Recorded on every run row. */
  engineVersion: string;
  /**
   * What artifact actually produced this answer. Recorded on every run row.
   *
   * A discriminated union, not a `string`, because the field used to be
   * `imageDigest` and the knowledge base it now names is a Git checkout on a
   * VM rather than a container. The only values available were a Git SHA or a
   * placeholder, and both are lies in a field whose name promises an OCI
   * digest — the kind of lie that survives review, because an auditor reads
   * `imageDigest`, believes they can pull it, and only finds out when they try.
   *
   * Optional at the type level and required at startup for any non-fake engine;
   * see `assertProvenance`.
   */
  provenance?: EngineProvenance;
  /** Creating twice with one operationId yields one run and the same handle. */
  supportsIdempotentCreate: boolean;
  /** A handle can be resolved from its operationId alone, after a crash. */
  supportsRunLookupByOperationId: boolean;
  /** A run can be stopped. */
  /**
   * The worker that OWNS an in-flight run can cancel it. Where an engine's
   * protocol has no explicit cancel operation, this is satisfied by aborting
   * the connection — the AbortSignal passed to `streamRun` is that mechanism.
   */
  supportsStop: boolean;
  /**
   * A run can be stopped by a process that does NOT hold its connection —
   * i.e. the engine exposes a stop operation addressed by run id. Whole
   * families of chat protocols lack this, because in them cancellation simply
   * IS closing the connection, which only the owner can do.
   *
   * Deliberately NOT a startup blocker. When false, the owning worker aborts
   * itself at its next fenced append; the residual cost is one dead worker's
   * run finishing at the vendor, bounded by `vendorMaxOutputTokens` — the
   * engine's own ceiling, NOT the delivered-output budget, which bounds only
   * what this process receives. See LLD-002 §7.1
   * for which engine families fall on each side.
   */
  supportsOutOfBandStop: boolean;
  /** Retrieval returns source references. */
  supportsCitations: boolean;
  /**
   * The engine's OWN configured ceiling on generated tokens per answer, where
   * it has one — the number the vendor actually enforces.
   *
   * This is the honest input to a cost model. `maxDeliveredOutputUnits` bounds
   * what we receive; only this bounds what is generated and billed, which is
   * what LLD-001 needs when a worker dies holding a stream and nothing can stop
   * the vendor finishing. Absent when the engine exposes no such setting.
   */
  vendorMaxOutputTokens?: number;
}

/**
 * What the deployment provides *around* the engine. A missing vendor guarantee
 * is acceptable only when something here covers it — which is why these are
 * inputs to the check rather than assumptions inside it.
 */
export interface DeploymentCompensations {
  /** The persistent operation-id mapping layer of LLD-001 §7 is wired up. */
  operationIdMappingLayerConfigured: boolean;
  /** Some route exists to recover and stop a run whose handle was never recorded. */
  unrecordedHandleRecoveryConfigured: boolean;
  /** The active answer policy requires citations on grounded answers. */
  answerPolicyRequiresCitations: boolean;
  /** A knowledge source is configured at all. */
  knowledgeSourceConfigured: boolean;
}

/**
 * Every reason this engine may not serve, in one pass.
 *
 * Returning the full list rather than the first failure is deliberate: an
 * operator fixing a misconfiguration should see all of it at once instead of
 * rediscovering the next problem on each restart.
 */
export function describeEngineRefusals(
  capabilities: EngineCapabilities,
  deployment: DeploymentCompensations,
): string[] {
  const refusals: string[] = [];

  if (!capabilities.supportsStop) {
    refusals.push(
      'supportsStop is false: the owning worker cannot cancel its own run, so a visitor ' +
        'pressing Stop would be ignored entirely. Note this is NOT about out-of-band ' +
        'cancellation — see supportsOutOfBandStop, which is deliberately not a blocker.',
    );
  }

  if (!capabilities.supportsIdempotentCreate && !deployment.operationIdMappingLayerConfigured) {
    refusals.push(
      'supportsIdempotentCreate is false and no operation-id mapping layer is configured: ' +
        'a retried create would produce a second vendor run.',
    );
  }

  if (
    !capabilities.supportsRunLookupByOperationId &&
    !deployment.unrecordedHandleRecoveryConfigured
  ) {
    refusals.push(
      'supportsRunLookupByOperationId is false and no other route can recover a run whose ' +
        'handle was never recorded: such a run could never be found or stopped.',
    );
  }

  if (!capabilities.supportsCitations && deployment.answerPolicyRequiresCitations) {
    refusals.push('supportsCitations is false while the active answer policy requires citations.');
  }

  if (!deployment.knowledgeSourceConfigured) {
    // Absent is not the same as unreachable. Serving without retrieval yields an
    // assistant answering from the model's own memory, which SECURITY.md forbids.
    refusals.push(
      'no knowledge source is configured: the assistant would answer without retrieval.',
    );
  }

  return refusals;
}

/** Throws unless the engine may serve. Call once, at startup, before opening a port. */
export function assertEngineUsable(
  capabilities: EngineCapabilities,
  deployment: DeploymentCompensations,
): void {
  const refusals = describeEngineRefusals(capabilities, deployment);
  if (refusals.length === 0) return;

  const detail = refusals.map((reason) => `  - ${reason}`).join('\n');
  throw new Error(`engine '${capabilities.engineId}' may not serve:\n${detail}`);
}
