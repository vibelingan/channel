/**
 * The capability descriptor (LLD-002 §7).
 *
 * This is the mechanism that stops an unproven assumption from becoming a
 * silent one. An adapter declares what its vendor actually guarantees, and the
 * process refuses to serve when a guarantee is missing and nothing compensates
 * for it — at startup, rather than at the first visitor.
 */

export interface EngineCapabilities {
  /** Short adapter identifier. Recorded on every run row so an incident can be scoped. */
  engineId: string;
  /** Pinned release. Recorded on every run row. */
  engineVersion: string;
  /** Container digest, where the runtime has one. Recorded for audit. */
  imageDigest?: string;
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
   * run finishing at the vendor, bounded by maxOutputTokens. See LLD-002 §7.1
   * for which engine families fall on each side.
   */
  supportsOutOfBandStop: boolean;
  /** Retrieval returns source references. */
  supportsCitations: boolean;
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
