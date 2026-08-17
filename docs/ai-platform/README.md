# AI Architecture Documentation Index

**Status:** Canonical documentation index  
**Last reviewed:** 2026-08-17

This directory contains the AI architecture for the Diversity Technology Channel website. It does not define the architecture of the separate Vibelingan Enterprise Brain product.

## Authoritative Documents

| Scope | Authoritative document | Use |
|---|---|---|
| Public website AI assistant | [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md) | Current English architecture, security boundary, human handoff, APIs, delivery gates, and open decisions |
| Clean-session transfer | [AI_ASSISTANT_CLEAN_SESSION_HANDOFF.md](../AI_ASSISTANT_CLEAN_SESSION_HANDOFF.md) | Start a new AI-assistant session without relying on the contaminated conversation |
| Enterprise Brain platform | [ARCHITECTURE_BASELINE_AND_RAG.md](../enterprise-brain/ARCHITECTURE_BASELINE_AND_RAG.md) | Separate product lineage, Task Hub architecture, and staged RAG decision |

### Implementation-level documents

These specify the architecture; they do not replace it. Where wording differs,
the architecture above wins and the specifying document is corrected.

| Document | Specifies | Read before |
|---|---|---|
| [MIU_BREAKDOWN.md](./MIU_BREAKDOWN.md) | The architecture decomposed into independently verifiable units, with a gate coverage map and an estimate reconciliation | Starting any implementation work |
| [LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md](./LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md) | Architecture §8 — states, the authorization epoch, run-level cancellation, the ordered-event fence, and the race windows | Writing any conversation state or streaming code |
| [LLD-002-CONVERSATION-ENGINE-INTERFACE.md](./LLD-002-CONVERSATION-ENGINE-INTERFACE.md) | The provider-neutral `ConversationEngine` boundary that keeps Hermes swappable | Writing the engine adapter, and before it |
| [SECURITY.md](./SECURITY.md) | Architecture §9 — trust zones, the credential inventory, the public-only knowledge space, and the tool surface contract | Provisioning any credential |
| [TEST_STRATEGY.md](./TEST_STRATEGY.md) | Architecture §11 — which test proves each gate, and which claims cannot be proven offline | Planning any MIU's verification |
| [PROCUREMENT-BRIEF.md](./PROCUREMENT-BRIEF.md) | Architecture §14 — staged development, CloudRun cost model, database alternatives, purchase timing, and the architect checklist | Approving or buying any AI infrastructure |
| [MIU-0-RUNBOOK.md](./MIU-0-RUNBOOK.md) | The executable preflight for local Docker, cloud integration probes, credentials, external providers, and human decisions | Starting infrastructure or MIU 0 work |

## Historical and Supporting Documents

| Document | Classification | Rule |
|---|---|---|
| [ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md](./ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md) | Supporting decision evidence, Chinese | Retains the detailed pattern audit and handoff-race derivation. Where wording differs, the English canonical architecture wins. |
| [ARCHITECTURE_AND_ROADMAP.md](./ARCHITECTURE_AND_ROADMAP.md) | Historical research and broad roadmap, Chinese | Useful for estimates and the five wider AI domains. It is not the clean-session entry point. |
| [HERMES_OPS_SOP.md](./HERMES_OPS_SOP.md) | Operations evidence for a separate Hermes gateway instance, Chinese | Do not treat this systemd messaging gateway as the website assistant deployment. The website design uses a private API service behind a BFF. |
| [AI_PLATFORM_DESIGN.md](../AI_PLATFORM_DESIGN.md) | Partially superseded proposal | The deterministic estimator and general security principles remain useful. Its CloudBase Agent customer-service route is superseded. |

## Product Boundaries

### A. Channel website AI assistant

The public website assistant answers approved questions about MOQ, price factors, lead-time ranges, certificates, and OEM availability. Its current proposed runtime is:

```text
Browser widget -> Chat BFF -> restricted Hermes profile -> public Lexiang knowledge
```

The BFF owns browser authentication, conversations, leads, rate limits, consent, audit, and human takeover. Hermes never owns business control state.

### B. Wider Channel AI roadmap

These capabilities share governance and operational patterns but are separate product modules:

| Capability | Governing rule |
|---|---|
| Instant estimator / cost matrix | Prices are produced by a deterministic, versioned rules engine. An LLM may explain but never invent or alter numbers. |
| Trend insights | Use only licensed data sources. Preserve source, timestamp, coverage, and review status. |
| Supplier optimization | Rank only approved suppliers under explicit constraints and weights. Human approval remains mandatory. |
| Agile logistics control | Recalculate recommendations from contracted carrier/forwarder data. Do not auto-book or promise global real-time coverage. |
| Shared controls | Reuse identity, audit, configuration, cost, observability, and lead patterns where ownership is genuinely shared. Do not force all modules through Hermes. |

### C. Vibelingan Enterprise Brain

Enterprise Brain is a different product with a Task Hub, enrolled agents, task-scoped collaboration, and multi-tenant knowledge retrieval. Its `KnowledgePort`, AnythingLLM interim engine, PostgreSQL hybrid target, and tenant isolation model do not automatically apply to the public Channel website.

## Non-Negotiable Separation Rules

1. Do not import Enterprise Brain `Task Hub`, `authctx`, workspace routing, or RAG migration decisions into the Channel assistant without a separate ADR.
2. Do not import the Channel assistant's sales takeover state machine into Enterprise Brain as a generic agent-coordination protocol.
3. Do not treat the standalone `hermes-gateway.service` operations SOP as proof that the website API deployment is production-ready.
4. Do not expose Hermes, Lexiang, AnythingLLM, model, or database credentials to a browser or agent prompt.
5. Do not infer architecture ancestry from a version number. Verify the body against the declared canonical source.
6. A production gate or mandatory migration trigger can be deferred only through explicit, time-bounded risk acceptance with named owners and compensating controls.

## Normative Surface Index

Two consecutive external review rounds found the same failure: a decision changed
in the paragraph that explains it, while the artifact that *specifies* it still
said the old thing. Fifteen findings in one round were one mistake repeated.

So before a design change in this directory is called done, check it against
every surface below that the change touches. A change present in fewer than all
of them is not made — it is half-made, which reads as done and behaves as before.

| If you change… | It must also change in… |
|---|---|
| A state transition | LLD-001 §2.3 table, the SQL that implements it, the invariant in §9, its row in TEST_STRATEGY §4, the owning MIU's "Done" |
| A conditional write's predicate | The SQL block, the sibling paths that share its shape, MIU 2c's schema if a constraint backs it, its test row |
| A run terminal status | LLD-001 §3.2 matrix (which is total — add a row), the event-type list in §4.3, the status→event table, its test row |
| A field | LLD-001 §2.2 or §3 field table, every SQL block that reads or writes it, MIU 2c's schema list, the constraint tests |
| An MIU dependency | The per-MIU `Depends on:` line **first** — that is what wins — then the §1 table, the pilot subset, the longest path |
| A test's claim | TEST_STRATEGY row, the invariant it cites, and any metric in the architecture that restates it |
| A security claim | SECURITY.md, its proof row in the credential inventory, its TEST_STRATEGY section, the owning MIU, and the non-negotiables list in §11 |
| An engine capability | LLD-002 port interface, its type, the conformance table, the startup-refusal list, and every consumer that reads it |
| Anything the architecture states | The architecture **first** (it wins), then every specifying document that repeats it |

The last two rows are where the recurrence concentrated: a claim restated in four
places, corrected in one.

## Change Procedure

- Update the owning English canonical document first.
- Add an ADR when replacing a runtime, knowledge engine, trust boundary, or source of truth.
- Keep observed facts, decisions, assumptions, and open gates visibly separate.
- Validate every cross-document link and search for contradictory runtime or ownership statements before approval.
