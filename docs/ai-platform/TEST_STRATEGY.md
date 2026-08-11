# Test Strategy — Channel Public AI Assistant

**Status:** Proposed; makes §11 of [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md) executable
**Last reviewed:** 2026-08-11

## 1. What this strategy is for

The architecture lists ten production gates. **All ten are open**, and it
separately records five specific claims as not yet proven. Two of the gates — the
route allowlist and the public-only knowledge credential — are the kind of
property that is either enforced by a standing test or quietly not enforced at
all. This document names the test that proves each claim, and says which claims
cannot be proven offline.

The organizing rule: **every security and concurrency property is asserted by a
test that fails closed.** A property with no test is an intention. A test that
passes when the dependency is missing is worse than no test, because it reports
green.

## 2. Layers and where each property is proven

| Layer | Runs against | Proves | Location |
|---|---|---|---|
| Unit | Pure functions | Transitions, authorization, retention decisions, redaction | `packages/*/src/*.test.ts` |
| Store | Real PostgreSQL | Primitives, constraints, sequence integrity | `packages/ai-store/src/*.test.ts` |
| Race | Real PostgreSQL + barriers | The takeover windows and invariants I1–I10 | `packages/ai-store/src/race/*.test.ts` |
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

The claim is "a public credential that cannot reach internal knowledge". The full
probe design, and the reasoning for each part, is in [SECURITY.md](./SECURITY.md)
§4. In test terms:

- **Three assertions per run, one credential**: a positive control against a
  known public document, an explicit permission denial on a known internal
  document, and a write refusal against the known-good public id. A bare
  not-found fails the run — every unrelated breakage produces not-found, so
  accepting it makes the test green precisely when the credential is broken.
- **Every retrieval surface**, enumerated from the MCP tool schema — search,
  query, list, get, attachment download — asserting on returned *content*, since
  a search API can cross spaces while get-by-id is correctly blocked.
- **Pre-deploy, against the deployed credential**, with its fingerprint recorded
  and re-asserted at BFF startup. Nightly against a "production-shaped" token
  checks something that is not serving customers.
- **Fails closed**: unreachable service, or an internal id that cannot be
  confirmed current, is a failure, not a skip.
- **One sensitivity run** with a deliberately over-scoped token that must turn
  the probe red. A check nobody has watched fail is a check nobody has verified.

### 3.2 The tool surface (gate 1)

Exact-set assertion against the live `/v1/toolsets` of the pinned digest:
the approved read-only knowledge tools and nothing else. Individually named
denials for terminal, process, files, patching, browser, code execution,
delegation, cron, memory management, skill management, and messaging — so a
vendor upgrade that adds a tool fails rather than arms it.

Three amplifications, per SECURITY.md §5, because a listing on its own is a weak
subject: the assertion is **parameterized by the serving profile id** and
requires the response to echo it; one **positive probe invokes** a denied tool
through that profile and asserts refusal, since unlisted is not undispatchable;
and the **configured MCP servers and their tools** are asserted in the same gate.
The gate is keyed to a hash of image digest + profile config + MCP server list,
and runs pre-traffic whenever that hash changes.

### 3.3 The route allowlist (gate 10)

A build/route-level test that enumerates every rendered route and asserts the
widget is present on exactly the approved allowlist and absent on admin,
account, authentication, customer-project, and preview routes. Enumeration must
come from the router or the built output — a hand-maintained list of routes to
check will miss the route added next month, which is the only route that matters.
The site is statically built, so walking `dist/**/*.html` is a real surface; the
test must **fail on an empty enumeration**, or a stage that forgot to build
reports zero violations and passes.

Companion E2E: load one admin route and assert no assistant network call is made.
Note that an absence-only assertion is also satisfied by the assistant being
globally broken, so pair it with a presence assertion on an allowlisted route in
the same run.

**This gate does not close session theft.** See SECURITY.md §9: the session JWT
lives in origin-scoped `localStorage` and is read from public pages, so route
exclusion is defence in depth here. The test that addresses the real risk seeds
`channel.token`, drives a hostile Markdown payload through the assistant on an
*allowlisted* route, and asserts the token never leaves the page.

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
threshold, not a pass/fail unit test.

The structural claim behind it — that no capability is granted by text — needs a
test with a real subject. "Tool selection never reads message content" is not
one: LLD-002 §8 says the port has no tools concept at all, so such an assertion
would examine a config object and stay green forever while the actual decision
happens inside the vendor process. Two tests carry the claim instead:

- the profile-scoped **invocation probe** of §3.2, which exercises the real
  dispatch path; and
- a **BFF egress inventory** test that walks the engine-event handler dispatch
  table and requires every reachable outbound effect — database write, outbox
  row, notification, HTTP call — to be on an approved list, so a future event
  variant carrying a side effect fails the build.

## 4. Proving the takeover invariants

Every invariant in LLD-001 §9 gets a named test. Interleaving is driven by
**injectable barriers** — the worker awaits a test-controlled latch at a named
point — never by sleeps. A timing-based race test is a flaky test that will be
disabled within a month.

| Test | Interleaving | Asserts |
|---|---|---|
| `takeover-before-create` | Barrier before `createRun` | R1: no vendor run created; run `CANCELLED`; a terminal event is appended so the widget does not hang |
| `takeover-between-create-and-authorize` | Barrier between create and TX2b | R2: `engine_run_id` **is** recorded; authorization rejected; cancel enqueued; zero visitor-visible AI events after `handoff.started` |
| `takeover-mid-stream` | Barrier between two token appends | R3: earlier tokens remain; no later AI event |
| `takeover-before-final` | Barrier before the final append | R4: final message never committed; run `CANCELLED` |
| `takeover-inside-append` | Barrier **between the fence and the insert** | I2/I6: the conditional update returns zero rows; nothing is appended. This is the window a fence-then-insert implementation opens and no other test in this table can see |
| `close-mid-stream` | T5 during an open run | I7: same guarantee as takeover; run `CANCELLED` |
| `return-to-ai-then-late-token` | T3 while an old run still streams | I2: the twice-bumped epoch keeps the old run unauthorized |
| `visitor-stop-then-tokens` | Stop, then engine keeps emitting | I7: `cancel_requested_at` alone blocks every further append, with the vendor stop call forced to fail |
| `lease-expiry-live-holder` | Reclaim while the original worker still streams | I10: the zombie's `claim_epoch` no longer matches; no interleaved tokens |
| `concurrent-takeover` | Two callers, same epoch | I3: exactly one winner; loser gets a conflict |
| `concurrent-reassign` | T4 racing T3 and T5 | T4's status and assignee predicates hold; no reassign on a closed conversation |
| `two-messages-one-conversation` | Two visitor POSTs in flight | I9: the partial unique index admits one live run |
| `sequence-integrity` | N concurrent appends | I1: unique, increasing, gapless |
| `stop-api-fails` | Engine stop always errors | I7: zero visitor-visible bytes; alert raised |
| `replayed-post` | Same idempotency key twice | I8: one message, one run |
| `crash-after-create` | Kill worker between the vendor call and recording | I4: no second vendor run is created on retry — `CALL_IN_FLIGHT` refuses it |
| `deadlock-order` | Takeover and worker contending on both tables | Lock order holds; a serialization failure retries and then returns a conflict, never a success |

The coverage rule is **one test per transition pair**, not one per named window.
The four windows the architecture happens to name are a starting point; the
transition table has six rows, and a suite that only exercises takeover leaves
close, return-to-AI, reassign, and visitor-stop untested.

Each test asserts on **committed database state and the SSE byte stream**, not on
mock call counts. "The cancel function was called" is not the property; "the
visitor never saw another word" is.

## 5. Contract probes — what cannot be faked

The architecture's "not yet proven" list is a list of things no offline test can
settle. Each becomes a recorded probe (following the SDK-probe discipline in
`AGENTS.md` and `docs/CLOUDBASE_SDK_CONTRACT_VERIFICATION.md`):

| Probe | Question it answers | Consumed by |
|---|---|---|
| Runs create replay | Does one operation id yield one run? | LLD-002 `supportsIdempotentCreate`; decides whether the mapping layer is needed |
| Run metadata + list | Can an orphaned run be found after a crash? | LLD-001 §7 reconciler feasibility |
| Stop semantics | Double stop, unknown id, finished run | `EngineCancelResult` mapping |
| Store transaction | Conditional `UPDATE … RETURNING`, `READ COMMITTED`, rollback, pool behaviour in the target environment | Whether LLD-001's primitives exist at all |
| Knowledge credential scope | Can the public token reach internal material? | Gate 2 |
| SSE through the real proxy | Does streaming survive the production path? | MIU 7 |

Probe results are recorded with a date and the command that produced them.
A probe result older than the current pinned version is not evidence.

## 6. Evaluation

Golden set with recorded expected behaviour per case: FAQ paraphrases,
multilingual queries, exact product terms, unknown questions, stale certificates,
price-promise bait, injection, secret extraction.

Reported metrics — all six of the architecture's pilot targets: grounded-answer
rate (≥90%), citation coverage (≥95%), correct refusal or escalation (≥95%),
secret/internal-cost/cross-conversation leakage (0), old AI events visible after
a committed takeover (0), and pilot availability (99.5%). The two zero-valued
metrics are **release blockers at any non-zero value**, not percentages to trend;
the takeover one is measured by the §4 race suite rather than the golden set.

Evaluation runs against the pinned runtime, is repeatable by one command, and is
re-run on every model, profile, corpus, or engine-version change. It gates
releases; it does not gate every commit, because it costs money and depends on a
live vendor.

## 7. CI shape

| Stage | Contents | Blocking |
|---|---|---|
| Pre-commit | lint, typecheck, fast unit | yes |
| PR | unit, store, race, conformance, integration, **build**, then secret scan and route allowlist over the built output | yes |
| Nightly | contract probes against pinned dependencies | alerts; blocks release |
| Pre-deploy | toolset + MCP assertion, capability check, **knowledge-credential scope probe against the deployed credential**, migration dry run | yes, pre-traffic |
| Release | full evaluation, E2E, failure drills | yes |

The PR stage runs the build before the two scans that read built output. Without
it both scan an empty directory, find nothing, and report green — the failure
mode this document exists to prevent.

The race and store suites need a real PostgreSQL service in CI. If that is not
available, they do not silently skip — the pipeline fails, because the
alternative is a green pipeline that has stopped testing the concurrency design.

## 8. What is deliberately not tested here

- Vendor internals. The conformance suite tests the contract, not Hermes.
- Model quality beyond the golden set thresholds. Open-ended answer quality is a
  product review activity, not a CI gate.
- Enterprise Brain. Different product, different repository boundary, per the
  separation rules in [README.md](./README.md).
