/**
 * `@vibelingan-channel/ai-engine` — the provider-neutral conversation engine
 * boundary (LLD-002).
 *
 * The BFF imports this package. It must never import an adapter package: the
 * engine instance is constructed once at composition root and passed in.
 */

export {
  ENGINE_ERROR_CATEGORIES,
  EngineError,
  type EngineErrorCategory,
  isEngineErrorCategory,
  isRetriableCategory,
} from './errors.ts';

export {
  assertEngineUsable,
  type DeploymentCompensations,
  describeEngineRefusals,
  type EngineCapabilities,
} from './capabilities.ts';

export type {
  ConversationEngine,
  EngineCancelResult,
  EngineCitation,
  EngineEvent,
  EngineHealth,
  EngineRunHandle,
  EngineRunLimits,
  EngineRunRequest,
  EngineTurn,
  EngineUsage,
  KnowledgeAttestation,
} from './port.ts';

export { type ConformanceHarness, runConformanceSuite } from './conformance.ts';

export { FakeEngine, type FakeEngineOptions, type ScriptedFailure } from './fake-engine.ts';
