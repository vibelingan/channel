/**
 * Composition root.
 *
 * This is the ONLY file in the BFF allowed to name an engine vendor. Everything
 * else depends on the `ConversationEngine` port, which is what makes swapping
 * engines a one-package change rather than a refactor (ADR-002 §4).
 */

import {
  type ConversationEngine,
  type DeploymentCompensations,
  assertEngineUsable,
  describeEngineRefusals,
} from '@vibelingan-channel/ai-engine';
import { AnythingLlmEngine } from '@vibelingan-channel/ai-engine-anythingllm';
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

/**
 * What the deployment provides around the engine today.
 *
 * Both mapping-layer flags are false because that machinery is LLD-001 §7 work
 * scheduled for a later MIU. They are stated here rather than assumed so the
 * startup gate can do its job instead of being quietly satisfied.
 */
const DEPLOYMENT: DeploymentCompensations = {
  operationIdMappingLayerConfigured: false,
  unrecordedHandleRecoveryConfigured: false,
  answerPolicyRequiresCitations: true,
  knowledgeSourceConfigured: true,
};

function buildEngine(
  config: NonNullable<ReturnType<typeof loadConfig>['engine']>,
): ConversationEngine {
  const engine = new AnythingLlmEngine({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    workspaceSlug: config.workspaceSlug,
    engineVersion: config.engineVersion,
  });

  const refusals = describeEngineRefusals(engine.capabilities, DEPLOYMENT);
  if (refusals.length === 0) return engine;

  if (!config.allowUngated) {
    // Production path: refuse, with every reason at once.
    assertEngineUsable(engine.capabilities, DEPLOYMENT);
  }

  // Development path: serve, but never silently. An operator who sees this in a
  // deployed log is looking at a misconfiguration.
  console.warn(
    JSON.stringify({
      event: 'engine.gate.bypassed',
      severity: 'warning',
      detail: 'AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE=1 — serving with unmet engine guarantees',
      refusals,
    }),
  );
  return engine;
}

try {
  const config = loadConfig();
  const engine = config.engine ? buildEngine(config.engine) : undefined;
  startServer(config, engine ? { engine } : {});
  console.log(
    JSON.stringify({
      event: 'listening',
      port: config.port,
      chat: engine ? 'enabled' : 'disabled (no engine configured)',
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
