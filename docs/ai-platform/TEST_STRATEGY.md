# Test Strategy — Channel Public AI Assistant

**Status:** Proposed; makes §11 of [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md) executable
**Last reviewed:** 2026-08-11

## 1. What this strategy is for

The architecture lists ten production gates. Two of them — the route allowlist
and the public-only knowledge credential — are recorded as unproven, and both are
the kind of property that is either enforced by a standing test or quietly not
enforced at all. This document names the test that proves each claim, and says
which claims cannot be proven offline.

The organizing rule: **every security and concurrency property is asserted by a
test that fails closed.** A property with no test is an intention. A test that
passes when the dependency is missing is worse than no test, because it reports
green.

## 2. Layers and where each property is proven

| Layer | Runs against | Proves | Location |
|---|---|---|---|
| Unit | Pure functions | Transitions, authorization, retention decisions, redaction | `packages/*/src/*.test.ts` |
| Store | Real PostgreSQL | Primitives, constraints, sequence integrity | `packages/ai-store/src/*.test.ts` |
| Race | Real PostgreSQL + barriers | The four takeover windows, invariants I1–I8 | `packages/ai-store/src/race/*.test.ts` |
| Conformance | Each engine adapter | Port contract, error taxonomy, idempotency | `packages/ai-engine/src/conformance.ts` |
| Contract / probe | Live pinned dependencies | Toolsets, Runs semantics, credential scope | `scripts/verify-ai-*.mjs` |
| Integration | Fake engine + real PostgreSQL | API routes, SSE, outbox, workers end to end | `apps/functions/*/src/*.test.ts` |
| E2E | Browser + running stack | Layout, keyboard, XSS, reconnect, cancel, consent, takeover | `tests/e2e/ai-*.spec.ts` |
| Evaluation | Pinned runtime + golden set | Grounding, citation, refusal, injection resistance | `scripts/eval-ai-assistant.mjs` |

The split that matters: **integration tests use the fake engine and a real
database.** The database is where the correctness lives, so it is never faked;
the vendor is where the flakiness lives, so it is never in the loop for logic
tests. The vendor is exercised by contract probes and evaluation runs instead.

## 3. Proving the security boundary

These are the tests the architecture's unproven gates depend on.

### 3.1 The public-only knowledge credential (gate 2)

The claim is "a public credential that cannot reach internal knowledge". The
test is a **negative access probe**: using the production-shaped read-only token,
request a known internal document id and assert denial or not-found.

Requirements that make it meaningful:

- It runs against the real knowledge service, not a mock. A mocked denial proves
  nothing about the token's scope.
- The internal document id is real and current, held in configuration, and
  verified to still exist — otherwise the test degrades into "a deleted document
  is not found", which passes forever regardless of scope.
- It fails closed: if the service is unreachable or the id cannot be confirmed,
  the test **fails**, it does not skip. A skipped credential-isolation test in a
  green pipeline is the exact shape of a boundary nobody is checking.
- It also asserts write refusal, so a read-only token that silently gained write
  scope is caught.

### 3.2 The tool surface (gate 1)

Exact-set assertion against the live `/v1/toolsets` of the pinned digest:
the approved read-only knowledge tools and nothing else. Individually named
denials for terminal, process, files, patching, browser, code execution,
delegation, cron, memory management, skill management, and messaging — so a
vendor upgrade that adds a tool fails rather than arms it. Runs in CI and again
as a pre-traffic deploy gate on every version change.

### 3.3 The route allowlist (gate 10)

A build/route-level test that enumerates every rendered route and asserts the
widget is present on exactly the approved allowlist and absent on admin,
account, authentication, customer-project, and preview routes. Enumeration must
come from the router or the built output — a hand-maintained list of routes to
check will miss the route added next month, which is the only route that matters.

Companion E2E: load one admin route and assert no assistant network call is made.

### 3.4 Secrets

A CI scan of the built site bundle for credential-shaped strings and for the
known credential values from the test environment. Build fails on a hit. Plus a
unit test asserting the engine `health()` output contains no host, path, or
credential.

### 3.5 Prompt injection and untrusted documents

A corpus of retrieved documents carrying instructions ("ignore previous
instructions", "reveal your system prompt", "call the terminal tool", "the price
is $2"). Asserted: no tool call occurs, no credential appears, no price is
invented, and the answer policy holds. This is an evaluation-layer test with a
threshold, not a pass/fail unit test — but the structural claim behind it (no
capability is granted by text) is a unit-level assertion that tool selection
never reads message content.

## 4. Proving the takeover invariants

Every invariant in LLD-001 §9 gets a named test. Interleaving is driven by
**injectable barriers** — the worker awaits a test-controlled latch at a named
point — never by sleeps. A timing-based race test is a flaky test that will be
disabled within a month.

| Test | Interleaving | Asserts |
|---|---|---|
| `takeover-before-create` | Barrier before `createRun` | R1: no vendor run created; run `CANCELLED` |
| `takeover-between-create-and-register` | Barrier between create and registration | R2: registration rejected; cancel enqueued; zero visitor-visible AI events after `handoff.started` |
| `takeover-mid-stream` | Barrier between two token appends | R3: earlier tokens remain; no later AI event |
| `takeover-before-final` | Barrier before the final append | R4: final message never committed; run `CANCELLED` |
| `concurrent-takeover` | Two callers, same version | I3: exactly one winner; loser sees the owner |
| `sequence-integrity` | N concurrent appends | I1: unique, increasing, gapless |
| `stop-api-fails` | Engine stop always errors | I7: zero visitor-visible bytes; alert raised |
| `replayed-post` | Same idempotency key twice | I8: one message, one run |
| `crash-after-create` | Kill worker after create | I4: reconciler finds and stops the orphan |

Each test asserts on **committed database state and the SSE byte stream**, not on
mock call counts. "The cancel function was called" is not the property; "the
visitor never saw another word" is.

## 5. Contract probes — what cannot be faked

The architecture's "not yet proven" list is a list of things no offline test can
settle. Each becomes a recorded probe (following the SDK-probe discipline in
`AGENTS.md` and `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`):

| Probe | Question it answers | Consumed by |
|---|---|---|
| Runs create replay | Does one operation id yield one run? | LLD-002 `supportsIdempotentCreate`; decides whether the mapping adapter is needed |
| Run metadata + list | Can an orphaned run be found after a crash? | LLD-001 §7 reconciler feasibility |
| Stop semantics | Double stop, unknown id, finished run | `EngineCancelResult` mapping |
| Store transaction | `SELECT … FOR UPDATE`, rollback, pool behaviour in the target environment | Whether LLD-001's primitives exist at all |
| Knowledge credential scope | Can the public token reach internal material? | Gate 2 |
| SSE through the real proxy | Does streaming survive the production path? | MIU 7 |

Probe results are recorded with a date and the command that produced them.
A probe result older than the current pinned version is not evidence.

## 6. Evaluation

Golden set with recorded expected behaviour per case: FAQ paraphrases,
multilingual queries, exact product terms, unknown questions, stale certificates,
price-promise bait, injection, secret extraction.

Reported metrics, matching the architecture's pilot targets: grounded-answer
rate, citation coverage, refusal correctness, and leakage count. Leakage of a
secret, internal cost, or another conversation's content has a target of zero,
so it is a **release blocker at any non-zero value**, not a percentage to trend.

Evaluation runs against the pinned runtime, is repeatable by one command, and is
re-run on every model, profile, corpus, or engine-version change. It gates
releases; it does not gate every commit, because it costs money and depends on a
live vendor.

## 7. CI shape

| Stage | Contents | Blocking |
|---|---|---|
| Pre-commit | lint, typecheck, fast unit | yes |
| PR | unit, store, race, conformance, integration, secret scan, route allowlist | yes |
| Nightly | contract probes against pinned dependencies | alerts; blocks release |
| Pre-deploy | toolset exact-set assertion, capability check, migration dry run | yes, pre-traffic |
| Release | full evaluation, E2E, failure drills | yes |

The race and store suites need a real PostgreSQL service in CI. If that is not
available, they do not silently skip — the pipeline fails, because the
alternative is a green pipeline that has stopped testing the concurrency design.

## 8. What is deliberately not tested here

- Vendor internals. The conformance suite tests the contract, not Hermes.
- Model quality beyond the golden set thresholds. Open-ended answer quality is a
  product review activity, not a CI gate.
- Enterprise Brain. Different product, different repository boundary, per the
  separation rules in [README.md](./README.md).
