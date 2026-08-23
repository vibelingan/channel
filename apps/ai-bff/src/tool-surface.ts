/**
 * Startup gate for the engine's tool surface.
 *
 * Extracted from `main.ts` so all three outcomes can be tested. While it lived
 * in a module that runs on import, the only way to exercise it was to boot the
 * process, so the "unknown" branch shipped as a warning nobody had asserted on.
 */

import type { ToolSurface } from '@vibelingan-channel/ai-engine-anythingllm';

/**
 * The run contract sets `maxToolCalls: 0`. This protocol never reports a tool
 * call mid-stream, so the limit cannot be enforced there — it is enforced by
 * refusing to serve an engine that has any agent surface switched on.
 *
 * Three outcomes, and only ONE of them starts:
 *
 *   known + no agent surface  -> serve
 *   known + agent surface on  -> refuse
 *   unknown                   -> refuse
 *
 * The last one changed. It used to warn and start, which meant the zero-tool
 * contract was enforced only when the check happened to succeed — a probe
 * against an unreachable inspection endpoint logged
 * `engine.toolsurface.unverified` and then served chat anyway. That is not a
 * control. A transient failure is for the orchestrator to retry; serving with
 * the engine's capabilities unknown contradicts the contract the run declares.
 */
export async function assertNoToolSurface(inspect: () => Promise<ToolSurface>): Promise<void> {
  const surface = await inspect();
  if (surface.enabled) {
    throw new Error(
      `refusing to serve; the engine workspace has an agent surface enabled (${surface.detail}) while the run contract permits zero tool calls. Disable every agent skill that is not retrieval.`,
    );
  }
  if (!surface.known) {
    // Refuse, not warn. Warning through means `maxToolCalls: 0` is enforced
    // only when the check happens to succeed, which is not a control — an
    // unreachable inspection endpoint would have started the chat route with
    // the engine's capabilities entirely unknown. A transient failure is for
    // the orchestrator to retry; serving with an unverified tool surface
    // contradicts the contract the run declares.
    throw new Error(
      `refusing to serve; the engine's tool surface could not be verified (${surface.detail}) and the run contract permits zero tool calls. Unknown is not the same as none.`,
    );
  }
}
