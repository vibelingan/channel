# Vibelingan Enterprise Brain: Architecture Baseline and RAG Decision

**Status:** Canonical review baseline; implementation has not been approved by this document  
**Last reviewed:** 2026-08-11  
**Canonical source PRD:** `/Users/SeanCai/Downloads/VibeEntAgentsFoundation-v1.md`

## 1. Lineage Decision

`VibeEntAgentsFoundation-v1.md` is the true starting point for the current product architecture.

`VibeEntAgentsFoundation-v1.1.5.md` is not a valid whole-document descendant. Its body restores an older autonomous-chain branch and then grafts a newer RAG section onto it. Version labels and change-log claims do not override the body.

The next PRD must therefore be rebuilt from `v1.md`. Selected improvements may be ported from `v1.1.5`, but its Sections 1-20 must not be patched forward as the architectural base.

## 2. Canonical Product Model From v1

### The task chat is the product

- A task is a durable conversation containing humans and agents.
- `@mention` is the single assignment operation.
- Each assignment has its own lifecycle: `asked -> ack -> working -> done | failed`.
- Tasks do not have an aggregate workflow state and do not become an invisible side channel.
- Humans can observe and participate in coordination directly.

### Hub topology

- Every cloud or on-premises agent opens one persistent outbound connection to the Task Hub.
- Agents do not expose an inbound service and do not connect directly to one another.
- The Hub assigns per-task sequence numbers, fans out messages, persists assignments, and queues deliveries for offline agents.
- Agent-to-agent cooperation is an `@mention` in a task, not an internal RPC or delegation tree.

### Issued identity

- Enrollment exchanges a one-time code for a rotating mTLS credential.
- Tenant, organizational scope, role, and clearance are derived from the credential and server-side registries.
- Templates and messages never carry authoritative scope.
- Claims by an agent about its own tenant, organization, role, workspace, or database scope are ignored.

### Database isolation

- Agents reach PostgreSQL only through a trusted data proxy.
- The proxy derives scope from issued identity and the current task, opens the transaction, and applies transaction-local settings.
- Tenant tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Application roles neither own protected tables nor hold `BYPASSRLS`.
- Agent-owned pools, raw sessions, session-level `SET`, and caller-selected organization IDs are prohibited.

### Protocols

- **Agent-Hub:** internal persistent outbound stream with server-derived identity, idempotency keys, and at-least-once delivery.
- **MCP:** agent-to-tool calls behind T4 authority checks and scoped connectors.
- **External A2A:** third-party agent interoperability exposed by the Hub, not by individual on-premises agents.

Internal HXA, direct agent chat, broadcast, parent/child delegation trees, and wait-for graphs are not part of the canonical architecture. Vector clocks are not needed for Task Hub message ordering. The v1 memory schema still contains a legacy `vector_clock` field; Section 9 treats its removal as a required hardening correction unless a separate causal-consistency requirement is demonstrated.

## 3. Keep, Drop, and Selectively Port

| Area | Decision |
|---|---|
| Task Hub, task chat, assignments | Keep from `v1.md` |
| Enrollment, mTLS, outbound runner, Hub queue | Keep from `v1.md` |
| Issued identity and immutable authorization context | Keep and harden from `v1.md` |
| Trusted PostgreSQL proxy and FORCE RLS | Keep and extend to knowledge tables |
| Two portals and task workspace | Keep from `v1.md` |
| Skill Assignment Matrix | Keep; optional industry skills are a catalog, not a fixed execution chain |
| Agent-Hub, MCP, external A2A | Keep; drop internal HXA and mislabeled external integrations |
| WeCom Smart Robot and Self-built App modes | Port only after implementation-time official contract verification |
| Pricing and market appendix | Port only after product and commercial approval |
| RAG Section 21 | Port the hardened concepts, corrected as described below |

## 4. RAG Decision

Use a staged engine strategy behind a narrow platform-owned boundary:

```text
Phase 1: AnythingLLM is the sole authoritative production retrieval engine.
Phase 2: PostgreSQL hybrid RAG is built and evaluated in shadow mode.
Cutover: PostgreSQL becomes authoritative after the quantitative gate passes.
Retirement: AnythingLLM leaves the serving path after the rollback window.
```

There is exactly one authoritative customer-facing engine at a time. A shadow index may coexist during migration, but shadow results never affect customer answers.

### Why stage the engines

- AnythingLLM accelerates first-customer delivery and supplies ingestion, vector retrieval, source references, and operations UI.
- The PostgreSQL target supplies enforceable tenant isolation, exact-term Chinese lexical retrieval, hybrid ranking, stable chunk provenance, and per-KB evolution.
- Canonical originals remain in platform object storage, so either derived index can be rebuilt without re-authoring.

## 5. Engine-Independent Knowledge Contract

The platform authorizes before invoking an engine. Agents and clients never choose an engine, instance, workspace, namespace, API key, or raw KB route.

```ts
type KnowledgeOutcome = 'grounded' | 'no-hit' | 'denied' | 'unavailable';

interface AuthorizedKnowledgeQuery {
  authctxId: string;
  grantsRevision: string;
  resolvedKnowledgeBaseIds: string[];
  rewrittenQuery: string;
  tokenBudget: number;
}

interface KnowledgeEvidence {
  sourceId: string;
  documentId: string;
  title: string;
  text: string;
  version: string;
  url?: string;
  score?: number;
  headingPath?: string;
  chunkId?: string;
}

interface KnowledgeSearchResult {
  outcome: KnowledgeOutcome;
  evidence: KnowledgeEvidence[];
  engine: { name: 'anythingllm' | 'postgres-hybrid'; version: string };
  citationGranularity: 'source' | 'document' | 'chunk';
  retrievedAt: string;
  staleAt?: string;
  latencyMs: number;
}

interface KnowledgePort {
  search(query: AuthorizedKnowledgeQuery): Promise<KnowledgeSearchResult>;
}
```

`AuthorizedKnowledgeQuery` is constructed only by trusted platform code after resolving the immutable authorization context, current task scope, KB grants, and policy revision. It is not an agent tool payload.

Outcome rules:

- `grounded`: sufficient approved evidence passed the configured threshold.
- `no-hit`: the engine worked, but no permitted evidence passed the threshold.
- `denied`: authorization removed all requested knowledge bases or denied the operation.
- `unavailable`: retrieval failed or its freshness guarantee could not be met.

`unavailable` must never be presented as "the answer does not exist." Adapters must not invent chunk IDs, headings, scores, or citation precision that the engine did not supply.

## 6. Interim AnythingLLM Boundary

### Allowed interim work

- `KnowledgePort` and the AnythingLLM adapter.
- Canonical `kb_documents` originals registry with metadata and checksums.
- Tenant, task, agent, and KB assignment records.
- Authorization, token budgets, T5 disclosure filtering, traces, refusal policy, golden sets, and migration metadata.
- Table-aware preprocessing before upload.
- Platform-side query rewriting before retrieval.

### Explicitly deferred

- `kb_chunks` and custom chunking infrastructure.
- Custom embedding pipeline and vector indexes.
- Chinese FTS, vector/lexical fusion, RRF, and custom reranking.
- A second production retrieval path.

### Isolation topology

- The platform proxy holds the server credential and resolves tenant -> instance -> workspace from issued identity and task scope.
- No prompt, message, skill argument, MCP argument, browser field, or agent configuration may provide workspace, instance URL, namespace, API key, tenant routing, or unfiltered KB IDs.
- AnythingLLM workspace ACLs are blast-radius containment, not PostgreSQL RLS.
- A shared instance is a recorded-risk, low-sensitivity pilot posture only.
- From the second mutually untrusted production tenant, use a separate AnythingLLM instance per tenant while the PostgreSQL target is being built.

The statement "AnythingLLM stores only a disposable index" must be verified and narrowed. Its application database, parsed content, workspace metadata, chat history, cache, and vector-store persistence all need explicit retention, deletion, backup, and residency contracts.

If a managed embedding service is used, document that source text leaves the platform trust boundary. "Nothing leaves our infrastructure" is valid only for fully self-hosted parsing, embedding, retrieval, and inference.

## 7. PostgreSQL Hybrid Target

Every shared knowledge table must include `tenant_id` and use FORCE RLS. Organizational scope supplements tenant identity; it does not replace it.

Logical storage:

```text
kb_documents
  tenant_id, document_id, kb_id, org_scope, source, title,
  version, checksum, status, updated_at

kb_chunks
  tenant_id, chunk_id, document_id, kb_id, org_scope, sequence,
  heading_path, content, embedding, lexical_tokens,
  embed_model, embed_dimensions, token_count, created_at
```

Target mechanics:

- Heading-aware 400-800 token chunks with measured overlap.
- Table chunks repeat headers and preserve row meaning.
- The same Chinese segmentation contract runs at ingestion and query time.
- Vector and lexical candidate lists are fused with a versioned ranking configuration, initially RRF with `k = 60` and up to 40 candidates per path.
- Optional cross-encoder reranking is disabled until evaluation proves it is needed.
- Price, policy, certification, lead-time, and QC skills refuse or escalate below their evidence threshold.

Embedding vectors from different models are not automatically comparable. `embed_model` metadata alone does not make mixed vector spaces safe. A model or dimension change requires a versioned parallel index and controlled cutover, or a complete per-KB re-embedding before queries switch.

## 8. Migration Triggers and Cutover

The following triggers are mandatory. When any trigger fires, the PostgreSQL build enters the committed roadmap and the listed containment action starts immediately:

1. A second mutually untrusted enterprise tenant reaches production.
2. A shared instance would hold sensitive contracts, finance, customer, or similarly regulated records beyond pilot acceptance.
3. Chunk-level RLS or stable provenance becomes mandatory.
4. Memory and knowledge must share one governed retrieval substrate.
5. Retention, deletion, residency, or audit evidence exceeds AnythingLLM's proven capability.
6. Golden-set quality remains below its threshold for two review cycles.
7. The global embedder blocks required per-KB evolution.
8. Freshness or latency repeatedly violates its SLO.

Product approval is required to define and tune the thresholds, not to ignore a fired trigger. A temporary deferral requires a named security and product owner, written risk acceptance, compensating controls, and an expiry date. Triggers 1 and 2 always require immediate per-tenant AnythingLLM isolation while the PostgreSQL target is being built; a waiver cannot retain a shared instance for mutually untrusted or newly sensitive production tenants.

Initial cutover gate, tunable per KB:

| Metric | Threshold |
|---|---:|
| Retrieval Recall@5 | at least 90% |
| Expected-source hit rate | at least 95% |
| Citation correctness | at least 95% |
| Grounded-answer faithfulness | at least 95% |
| Unsupported price/policy/QC answers | 0 |
| Cross-tenant retrieval | 0 |
| p95 retrieval latency | under 800 ms |
| Index freshness | under 15 minutes |
| Shadow evaluation | at least 14 days |
| Golden set | at least 20 cases per KB and 50 for critical KBs |

Migration procedure:

1. Freeze chunking, embedding, and ranking versions for evaluation.
2. Ingest canonical originals into PostgreSQL.
3. Continue serving only from AnythingLLM.
4. Replay or sample queries against PostgreSQL in shadow mode.
5. Compare retrieval, grounding, citations, refusals, latency, and isolation.
6. Perform a final incremental source sync.
7. Pass RLS, T5, deletion, and cross-tenant tests.
8. Switch the trusted adapter feature flag.
9. Keep a bounded rollback window in which rollback is an adapter switch.
10. Remove AnythingLLM production data and credentials after the approved retention window.

## 9. Corrections Required While Rebasing From v1

The canonical ancestor also needs targeted hardening:

- Reauthorize task history reads and deliveries, not only initial joins. Define revocation and re-check participants after scope widening.
- Intersect management clearance with the task's current organization set. A broad management role must not silently bypass task scope.
- Replace the single `authctx.org_id` with an immutable authorized organization-scope set where tasks span organizations.
- Define issued identities for humans, channel actors, scheduled jobs, and service principals as well as agents.
- Reconcile immortal tasks and seven-year transcripts with L1-L4 memory retention. Distill after a run or assignment outcome, not "task completion."
- Remove obsolete vector clocks from memory provenance unless a real distributed causal requirement is demonstrated.
- Use operation-specific idempotency, compare-and-set, outbox, and reconciliation for external effects. A generic Retry button is not proof of safe replay.
- Verify channel signatures, replay protection, deduplication, actor mapping, and authoritative channel-to-task binding.
- Never expose raw chain-of-thought, secrets in tool parameters, or unredacted authorization context. Show redacted evidence and rationale summaries.
- Move Hub, enrollment, identity, and transport ahead of task-chat implementation in every roadmap section.

## 10. Rebase Instruction

The next PRD author should:

1. Copy `VibeEntAgentsFoundation-v1.md` as the structural base.
2. Apply the corrections in Section 9 of this document.
3. Port the corrected RAG design in Sections 4-8.
4. Optionally port verified WeCom connection modes and approved commercial material.
5. Regenerate change logs and cross-references from the resulting body.
6. Run a body-level consistency review across identity, task scope, database scope, knowledge routing, APIs, traces, protocols, portals, and roadmap.

Do not port direct agent chat, HXA, fixed skill-chain orchestration, caller-controlled scope, agent-owned database pools, global authorization switchers, the old Integration Runtime topology, or the old Agent-to-Agent API.
