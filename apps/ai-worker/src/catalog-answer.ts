import type { PublicProductCard } from '@vibelingan-channel/ai-contracts';
import type {
  ConversationEngine,
  EngineCitation,
  EngineRunRequest,
} from '@vibelingan-channel/ai-engine/port';
import { PRODUCT_ANSWER_PROFILE_ID } from '@vibelingan-channel/ai-engine/port';
import { enforceGroundedFinal } from '@vibelingan-channel/ai-policy';
import { parseProductPlan } from './product-workflow.ts';

/** Optional prose over just-read public facts; cards remain usable if synthesis fails. */
export async function explainCatalog(
  engine: ConversationEngine,
  request: EngineRunRequest,
  products: PublicProductCard[],
  signal: AbortSignal,
  prefix: string,
) {
  if (!products.length) return null;
  const citations: EngineCitation[] = products.map((product) => ({
    sourceId: `${prefix}/catalog/${product.id}`,
    title: product.name,
    snippet: `${product.name}\n${product.summary}`,
    retrievedAt: product.retrievedAt ?? new Date().toISOString(),
  }));
  try {
    const handle = await engine.createRun(
      {
        ...request,
        operationId: `${request.operationId}:catalog-answer`,
        profileId: PRODUCT_ANSWER_PROFILE_ID,
        turns: [
          ...request.turns,
          {
            role: 'assistant',
            text: 'Current published catalog DATA, retrieved for the latest visitor question. Do not add or change these facts.',
            publicCatalog: {
              products: products.map((p) => ({ id: p.id, name: p.name, summary: p.summary })),
              unavailableProductIds: [],
            },
          },
        ],
        limits: { ...request.limits, maxDeliveredOutputUnits: 1024, maxToolCalls: 0 },
      },
      signal,
    );
    for await (const event of engine.streamRun(handle, signal)) {
      if (event.type === 'error') return null;
      if (event.type !== 'final') continue;
      const plan = parseProductPlan(event.text);
      if (plan.kind !== 'answer' || plan.text.length > 1200) return null;
      const checked = enforceGroundedFinal(
        { type: 'final', text: plan.text, citations },
        { approvedSourcePrefix: prefix },
      );
      return checked.type === 'final' && checked.text === plan.text ? checked : null;
    }
    return null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
