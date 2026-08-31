# Engine evaluation — AnythingLLM for the Channel assistant

**Date:** 2026-08-17; live integration evidence updated 2026-08-25
**Question:** is AnythingLLM the right retrieval+chat engine for local development,
and is it good enough for production for a ~100-person enterprise?
**Short answer:** yes for local development, unreservedly. For production it is a
strong candidate *and* a simplification — but adopting it is an ADR-level
decision, because it replaces two components, not one.

---

## 1. The thing nobody said out loud yet

AnythingLLM does **retrieval and chat together**. The current architecture uses
*two* components for that: Hermes (orchestration + model) and Lexiang (knowledge).

So this is not "swap the knowledge base". It is:

```
before:  BFF → Hermes (pinned profile) → Lexiang MCP
after:   BFF → AnythingLLM (workspace + embedded RAG) → zenmux model
```

That removes a whole component and one of the two credentials from the serving
path. It also removes the single most expensive unproven item on the MIU 0 list —
the Lexiang MCP serving credential and its K1–K5 scope proof — because the public
corpus would live in a workspace we control end to end.

That is a genuine simplification, not a lateral move. It is also exactly why it
needs an ADR rather than a quiet substitution.

---

## 2. Why the earlier "interim engine" verdict does not bind here

`docs/enterprise-brain/ARCHITECTURE_BASELINE_AND_RAG.md` already evaluated
AnythingLLM and scheduled its **retirement from the serving path**. Read carefully,
its objections are about *multi-tenancy*:

| Recorded concern (Enterprise Brain) | Does it apply to the Channel assistant? |
|---|---|
| "Workspace ACLs are blast-radius containment, not PostgreSQL RLS" | **No.** One tenant. One corpus. Nothing to isolate between customers |
| "From the second mutually untrusted production tenant, use a separate instance per tenant" | **No.** There is no second tenant |
| Retention/deletion/residency contracts unverified | **Partly.** Still real, but the corpus is *deliberately public material*, so the stakes are far lower than Enterprise Brain's tenant documents |

Enterprise Brain is multi-tenant with confidential per-customer knowledge. The
Channel assistant is single-tenant with knowledge we *want* strangers to read.
The property that made AnythingLLM interim there is absent here.

**This must be stated in the ADR explicitly.** Otherwise a future reader sees two
documents in the same repo reaching opposite conclusions about the same product
and assumes one is stale.

---

## 3. Measured comparison

Independent 2026 benchmark, 5,047-page corpus, 50 queries:

| | AnythingLLM | PrivateGPT | Open WebUI |
|---|---|---|---|
| **Hallucination rate** | **6%** | 11% | 14% |
| **Citations** | filename + page, clickable, verbatim chunk (9/10 correct) | structured JSON, chunk ids | filename only, no page |
| Retrieval latency p50 / p95 | 310ms / 880ms | **240ms / 720ms** | 380ms / 1,040ms |
| Multi-user / ACL | workspaces + doc access control | none | **OAuth, RBAC** |
| Real API surface | developer API + Swagger at `/api/docs` | **purpose-built API** | GUI-first |
| Licence | MIT | Apache-2.0 | MIT |

**The two columns that decide it for us are hallucination and citations**, because
the architecture's answer policy requires grounded answers with source references
and forbids invented prices. AnythingLLM wins both, decisively.

Latency: 310ms p50 is irrelevant beside model generation time of several seconds.
Multi-user/RBAC: irrelevant — our BFF owns authorization; the engine never sees a
visitor identity.

Noted weakness — **scale "cracks around 10,000 pages"**, p95 climbing to ~1.6s.
A headphone OEM's public FAQ, certificates and product facts is realistically
tens to low hundreds of documents. Two orders of magnitude of headroom.

Second weakness — **the desktop build ships closed-source telemetry.** Use the
Docker build from source. This is a hard requirement, not a preference.

---

## 4. What must be probed before the ADR can be approved

The `ConversationEngine` port (MIU 1) makes the switch cheap — it is one adapter
package, which is precisely what the boundary was written for. But three of the
port's declared capabilities are unverified against AnythingLLM, and one of them
is a startup blocker:

| Capability | Why it matters | Status |
|---|---|---|
| `supportsStop` (owner-cancellable) | **Blocking**, but satisfied by aborting the connection — the port's `AbortSignal`. Verified at protocol level: aborting a live stream terminated cleanly | **Resolved** |
| `supportsOutOfBandStop` | **Not blocking** since ADR-002 §3 split the capability. Expected `false`; costs bounded token waste when an owning worker dies | **Resolved as expected-false** |
| Separate retrieval | Lets the answer path enforce grounding/refusal before generation | **Resolved on both.** Local `/vector-search` and the supplied production fork's `/vector-search` each returned ranked results without a model call |
| `supportsCitations` | The answer policy requires citations; the API's source shape must map to `EngineCitation` (`sourceId`, `title`, `url`, `snippet`, `retrievedAt`) | **Local: verified true** — mapped in the adapter, deduplicated to the page rather than the chunk. **Supplied production fork: unverified**, and unverifiable while generation 403s, since no citation has been returned to map. The adapter takes this as an explicit operator assertion (`citationsVerified`) rather than assuming it — and as of Round 5 that assertion alone is no longer enough to be ready: startup verifies a probe-written evidence artifact that must show a positive-control retrieval returning approved material, so an empty or unapproved workspace cannot report ready however cleanly it authenticates |
| `supportsIdempotentCreate` | Chat-completions style APIs usually lack it. If absent, LLD-001 §7's operation-id mapping layer becomes mandatory — which is already designed | **Confirmed false** on both. The adapter declares it false and the composed worker/store compensate |
| Streaming | Token-by-token delivery | **Local: verified true**, with two frame-order traps recorded in ADR-002 §6. **Supplied production fork: transport observed, success unverified** — SSE returned an `abort` event because the provider denied the model request |

Every row above answers for two different systems: the digest-pinned
`mintplexlabs/anythingllm` 1.16.0 container this repository runs locally, and
the separately supplied, externally hosted fork that speaks a compatible API.
A capability proven on one is not proven on the other.

None of these is a reason not to proceed locally. All are answerable in a day
once the container is running.

---

## 5. Model provider — corrected

The ZenMux protocol and model IDs were confirmed reachable on 2026-08-17. That
is historical provider evidence, not current end-to-end readiness: on 2026-08-25
the supplied production-compatible instance reached its configured provider but
received `403` permission errors, and this checkout had no approved local model
key for a fresh local generation test.

**The two model ids requested do not exist. The correct ones are:**

| Requested | Actual |
|---|---|
| `z-ai/glm-5.3` | **`z-ai/glm-5.2`** (latest GLM on the platform) |
| `kimi/k3` | **`moonshotai/kimi-k3`** |

Both were live-tested and answered correctly.

### A finding that changes a design parameter

Both are **reasoning models**, and their reasoning tokens are billed and counted
inside the completion budget:

| Model | `max_tokens: 30` | `max_tokens: 800` |
|---|---|---|
| `z-ai/glm-5.2` | **empty reply** — 30/30 tokens spent on reasoning | correct answer; 31 completion, 22 reasoning |
| `moonshotai/kimi-k3` | **empty reply** — 27/30 spent on reasoning | correct answer; 125 completion, **103 reasoning** |

A too-small `maxDeliveredOutputUnits` therefore produces a **silent empty answer**, not an
error. Kimi K3 spent 103 reasoning tokens on a one-sentence reply.

Consequences to propagate:

- `LLD-002` `EngineRunLimits.maxDeliveredOutputUnits` must be documented as covering
  reasoning tokens, with a floor well above the visible answer length.
- The engine adapter must treat "empty content with non-zero completion tokens"
  as a **failure**, not a successful empty answer — otherwise a visitor sees a
  blank reply and the run records success.
- Cost estimates must count reasoning tokens. For short answers Kimi K3 spent
  ~4x more tokens than GLM 5.2 for the same output.

**Recommendation:** `z-ai/glm-5.2` primary — materially cheaper per answer on this
evidence — with `moonshotai/kimi-k3` as the configured fallback.

---

## 6. Recommendation

**Local development: adopt AnythingLLM now.** MIT, Docker, real retrieval with
real citations against the real model provider. It is strictly better than
developing against `FakeEngine` alone, because it surfaces grounding and citation
behaviour that a fake cannot. `FakeEngine` stays — it is what the deterministic
race and state-machine tests need, and those must not depend on a model.

**Production: recommend adoption, via an ADR.** The multi-tenancy objections
recorded against it elsewhere do not apply to a single-tenant public corpus, it
wins the two metrics our answer policy actually depends on, and it removes a
component and a credential from the serving path. Conditional on the four probes
in §4. The `supportsStop` question that was blocking is now resolved by the ADR-002 §3 capability split.

**What this does not change:** the BFF, the takeover design, the store, and the
port all stand exactly as designed. That is the point of having written the port
first — a change of engine costs one adapter package, not a redesign.
