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
import { type BffConfig, loadConfig } from './config.ts';
import { startServer } from './server.ts';
import { assertNoToolSurface } from './tool-surface.ts';

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
  config: NonNullable<BffConfig['engine']>,
  localHarness: boolean,
): ConversationEngine {
  const engine = new AnythingLlmEngine({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    workspaceSlug: config.workspaceSlug,
    engineVersion: config.engineVersion,
  });

  const refusals = describeEngineRefusals(engine.capabilities, DEPLOYMENT);
  if (refusals.length === 0) return engine;

  if (!localHarness) {
    // Anything that is not the local harness refuses, with every reason at once.
    // The bypass is not a production concept, so there is no production branch.
    assertEngineUsable(engine.capabilities, DEPLOYMENT);
  }

  // Harness path: serve, but never silently.
  console.warn(
    JSON.stringify({
      event: 'engine.gate.bypassed',
      severity: 'warning',
      detail: 'AI_LOCAL_HARNESS=1 — serving with unmet engine guarantees',
      refusals,
    }),
  );
  return engine;
}

try {
  const config = loadConfig();
  // The engine is only constructed for the harness. Outside it the conversation
  // route does not exist, so an engine would have nothing to serve — and
  // building one anyway would open a connection to the vendor for no reason.
  const engine =
    config.localHarness && config.engine ? buildEngine(config.engine, true) : undefined;
  if (engine) await assertNoToolSurface(() => (engine as AnythingLlmEngine).inspectToolSurface());
  startServer(config, engine ? { engine } : {});
  console.log(
    JSON.stringify({
      event: 'listening',
      port: config.port,
      mode: config.localHarness ? 'LOCAL HARNESS (not for public traffic)' : 'normal',
      chat: engine ? 'enabled' : 'not registered (harness only until MIU 6)',
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
