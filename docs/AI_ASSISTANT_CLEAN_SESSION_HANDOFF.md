# AI Assistant Clean-Session Handoff

**Prepared:** 2026-08-11  
**Purpose:** Start a new session without importing assumptions or conclusions from the contaminated conversation

## 1. Documents To Carry Into the New Session

Open or attach these files:

1. [AI architecture index](./ai-platform/README.md)
2. [Channel public AI assistant architecture](./ai-platform/CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
3. [Enterprise Brain architecture baseline and RAG decision](./enterprise-brain/ARCHITECTURE_BASELINE_AND_RAG.md)
4. Canonical Enterprise Brain source: `/Users/SeanCai/Downloads/VibeEntAgentsFoundation-v1.md`

Attach `/Users/SeanCai/Downloads/VibeEntAgentsFoundation-v1.1.5.md` only when reviewing or porting selected changes. It is evidence from a divergent branch, not the base specification.

Optional supporting evidence:

- `docs/ai-platform/ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md`
- `docs/ai-platform/ARCHITECTURE_AND_ROADMAP.md`
- `/Users/SeanCai/Downloads/ai-floating-widget`

Do not attach the previous chat transcript unless investigating how a specific conclusion was derived.

## 2. Established Decisions

### Channel website

- The user-provided prototype proved the basic Hermes + model + Lexiang path.
- The production proposal is browser -> Chat BFF -> restricted private Hermes profile -> public-only Lexiang knowledge.
- The BFF, not Hermes, owns conversations, leads, authorization, human takeover, and event ordering.
- Human takeover requires a transactional mode-version and ordered-event fence. Prompt instructions and best-effort cancellation are insufficient.
- The public assistant cannot quote internal prices, expose customer/project data, or receive powerful Hermes tools.
- Public production remains blocked by the ten gates in the canonical Channel architecture.

### Enterprise Brain

- `VibeEntAgentsFoundation-v1.md` is the true ancestor.
- The product is task-centric: agents collaborate through the Task Hub and task chat, not direct agent-to-agent calls.
- Identity and scope are issued at enrollment and derived server-side.
- Database access goes through a trusted proxy with transaction-local scope and FORCE RLS.
- `v1.1.5` is a divergent old architecture with a valuable newer RAG section grafted onto it.
- Rebuild from `v1.md`; do not patch the whole of `v1.1.5` forward.
- RAG may use AnythingLLM as the sole interim engine and PostgreSQL hybrid retrieval as the target, with one authoritative engine at a time and a quantitative shadow cutover.

## 3. Explicit Domain Separation

There are three different systems:

1. **Channel website assistant:** a public sales/customer-service surface with anonymous visitors and hard human takeover.
2. **Enterprise Brain:** a multi-tenant task collaboration platform for enrolled humans and agents.
3. **Standalone Hermes messaging gateway:** an existing operational bot described by `HERMES_OPS_SOP.md`.

They may share security and operations lessons. They do not share a source of truth, identity model, runtime topology, or release decision by default.

## 4. Unresolved Decisions

For the Channel assistant:

- Pinned Hermes release, image digest, and verified Runs/toolset contracts.
- Public-only Lexiang space and read-only credential.
- Model provider and data-processing terms.
- Sales takeover workplace and role workflow.
- Production region, PII, transcript retention, deletion, and consent.
- PostgreSQL network, transaction, outbox, and reconciliation implementation.
- Approved public FAQ corpus, languages, thresholds, and pilot metrics.
- Product and security approval of the exact widget public-route allowlist.

For Enterprise Brain:

- The rewritten PRD based on `v1.md` has not yet been reviewed.
- AnythingLLM's exact installed-version storage, API, citation, deletion, and workspace contracts require implementation-time verification.
- Shared-instance pilot risk acceptance versus immediate per-tenant deployment.
- Final knowledge schema, embedding provider, dimensions, index-version strategy, and deletion propagation.
- Quantitative golden sets and cutover thresholds require product and tenant approval.
- Task scope widening, reauthorization, memory retention, and external-effect idempotency need the corrections listed in the canonical baseline.

The eight Enterprise Brain RAG migration triggers are mandatory actions, not optional approval gates. Approval tunes their thresholds. Any temporary deferral requires named owners, compensating controls, and an expiry date; triggers involving a second mutually untrusted tenant or newly sensitive shared-instance data require immediate per-tenant isolation.

## 5. Recommended First Task in the New Session

Ask the new session to do one bounded task only:

> Review the newly rebuilt Enterprise Brain PRD against the canonical baseline, or continue the Channel assistant architecture. Do not work on both products in the same implementation task.

If Claude has already produced a PRD rebuilt from `v1.md`, attach that new file and request a body-level architecture review. The review should check behavior, security, APIs, schemas, protocols, traces, and roadmap rather than trusting the change log.

## 6. Paste-Ready New-Session Prompt

```text
We are starting a clean architecture session. Do not rely on any prior chat history.

Read these files in order:
1. docs/ai-platform/README.md
2. docs/AI_ASSISTANT_CLEAN_SESSION_HANDOFF.md
3. The owning architecture for the product in scope:
   - Channel website: docs/ai-platform/CHANNEL_AI_ASSISTANT_ARCHITECTURE.md
   - Enterprise Brain: docs/enterprise-brain/ARCHITECTURE_BASELINE_AND_RAG.md
4. For Enterprise Brain, also read the canonical source PRD:
   /Users/SeanCai/Downloads/VibeEntAgentsFoundation-v1.md

Important boundaries:
- Channel website AI assistant and Vibelingan Enterprise Brain are separate products.
- VibeEntAgentsFoundation-v1.md is the canonical Enterprise Brain ancestor.
- VibeEntAgentsFoundation-v1.1.5.md is not the base; use it only as selective RAG/WeCom/commercial source material.
- Do not infer a decision from a version number or change log. Verify the body.
- Keep observed facts, approved decisions, assumptions, and open gates separate.

Before proposing edits, state which product is in scope, identify its source of truth, and list any conflict between the requested work and the canonical architecture. Then perform only the requested bounded task.
```

## 7. Handoff Completion Check

Before ending the old session, verify:

- The new session can understand the architecture without reading this chat.
- Every decision has an owning English document.
- Historical Chinese documents are classified as supporting or superseded, not silently treated as canonical.
- The canonical Enterprise Brain ancestor path is explicit.
- Open production gates remain open; the handoff does not convert them into approvals.
- No secret values or raw environment content appear in the handoff.
