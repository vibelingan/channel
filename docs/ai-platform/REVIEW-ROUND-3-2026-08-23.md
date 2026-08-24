# AI Assistant Phase 1/2 Review - Round 3

**Date:** 2026-08-23  
**Reviewed HEAD:** `26bc895f73127b8f4f56c183ace0ebc4afe0bfb5`  
**Review base:** `e363fbced635397a4096dcdaed64d47fe2faf43e`  
**Commits reviewed:** `9f1879b`, `26bc895`

## Verdict

**BLOCK Phase 2 closure.**

The application-level production lock and CloudRun manifest guard work as intended. The real production image refuses `AI_LOCAL_HARNESS=1`, and without that flag both `/api/ai/chat` and `/dev/chat` return `404`.

However, the local-only boundary is not enforced by Docker Compose. The rendered Compose configuration enables the harness, declares the process as development, supplies no `APP_ENV`, and publishes every service on all host interfaces. Therefore, copying this Compose file to a reachable host does not fail closed, contrary to the Phase 2 claim.

Phase 1 is materially improved, but its bounded conversation-store claim is also incomplete under concurrent active conversations. The documented default evaluation command is broken by a port mismatch.

## Findings

### R8 - P1 - The local harness and supporting services are exposed beyond loopback

**Status:** `PHASE_2`  
**Files:** `docker-compose.ai.yml`, `apps/ai-bff/src/config.test.ts`, `docs/ai-platform/LOCAL-DEV-RUNBOOK.md`

`docker-compose.ai.yml` currently combines these settings:

```yaml
NODE_ENV: development
AI_LOCAL_HARNESS: "1"
ports:
  - "58080:8080"
```

It does not set `APP_ENV`. The rendered BFF environment was independently observed as:

```json
{"NODE_ENV":"development","APP_ENV":null,"AI_LOCAL_HARNESS":"1"}
```

Docker reported the BFF host bindings as:

```text
0.0.0.0 58080
:: 58080
```

PostgreSQL, Worker, and AnythingLLM are also published without a host address, so they bind to all IPv4 and IPv6 interfaces:

| Service | Host port | Exposed surface |
|---|---:|---|
| PostgreSQL | 55432 | Database with local static credentials |
| BFF | 58080 | Unauthenticated chat route and development page |
| Worker | 58081 | Health/readiness service |
| AnythingLLM | 53001 | Engine API and administration surface |

This means a device that can reach the developer machine can reach these services. On a remotely reachable host, the Compose stack enables the harness rather than refusing startup.

The test named `the local compose environment, deployed to production, refuses to start` does not reproduce the actual Compose configuration. It manually adds `APP_ENV=production`, but Compose supplies no such variable. It proves that an external platform override would block startup, not that copying the Compose file itself fails closed.

#### Required fix

1. Bind every published development port to loopback:

   ```yaml
   - "127.0.0.1:55432:5432"
   - "127.0.0.1:58080:8080"
   - "127.0.0.1:58081:8081"
   - "127.0.0.1:53001:3001"
   ```

2. Add a test against the rendered Compose configuration. It must assert:
   - every published port has `host_ip: 127.0.0.1`;
   - BFF has `AI_LOCAL_HARNESS=1` only in this loopback-bound configuration;
   - the test does not inject environment variables absent from Compose.
3. Correct the runbook and triage claim. Copying Compose is unsafe as currently written; the production image and CloudRun manifest are what fail closed.
4. Re-run `docker compose config`, start the stack, and inspect actual bindings after the change.

### R9 - P2 - The bounded conversation store exceeds its cap when all entries are active

**Status:** `PHASE_2`  
**Files:** `apps/ai-bff/src/conversations.ts`, `apps/ai-bff/src/conversations.test.ts`, `apps/ai-bff/src/chat.ts`

`create()` excludes active conversations from eviction. When all existing entries are active, the eviction list is empty, but the implementation still inserts a new conversation.

Reproduction with `maxConversations: 2`:

```json
{"size":3,"max":2,"a":true,"b":true,"c":true}
```

With the default limit of 500, enough concurrent new conversations can make the map grow beyond 500 indefinitely while requests remain active. The existing tests prove ordinary eviction and preservation of an active conversation separately; they do not test the all-active-at-cap condition.

Phase 2 currently prevents this temporary store from serving production traffic, so this is not a current production vulnerability. It still invalidates Phase 1's claim that the local store is bounded.

#### Required fix

1. Change conversation creation to return a capacity result when the cap is reached and no safe eviction candidate exists.
2. Refuse the new request with `429` or `503` before calling the engine.
3. Add a test where all conversations are active at the configured cap.
4. Assert that store size never exceeds `maxConversations`.
5. Keep active conversations protected so completed answers are not silently discarded.

### R10 - P2 - The documented default evaluation command targets the wrong port

**Status:** `PHASE_2`  
**Files:** `scripts/ai-eval.mjs`, `docs/ai-platform/LOCAL-DEV-RUNBOOK.md`, `docker-compose.ai.yml`

The runbook tells developers to run:

```bash
pnpm ai:eval
```

The script defaults to `http://localhost:58090`, while Compose publishes BFF at `http://localhost:58080`.

Observed results:

- Bare `pnpm ai:eval`: eight `fetch failed` results.
- `pnpm ai:eval -- --base http://localhost:58080`: all eight cases passed.

#### Required fix

1. Change the script example and default endpoint to port `58080`.
2. Add a configuration-consistency test so the eval default cannot drift from the Compose BFF port again.
3. Run the exact command documented in the runbook, without an undocumented override.

## What passed

### Phase 1 fixes

- Client-supplied assistant history is rejected.
- Assistant text is persisted only after a terminal `final` event.
- Partial output is not persisted after engine error, timeout, content filtering, truncation, exception, or caller abort.
- `x-conversation-id` is exposed to an allowed cross-origin browser caller.
- Concurrent turns on the same conversation are refused.
- Active conversations are protected from TTL and ordinary capacity eviction.
- Root and nested real environment files are excluded from Docker build context.
- Knowledge-content documentation no longer promises nonexistent Alibaba ingestion or mathematical grounding guarantees.
- The canonical 32-row triage is arithmetically consistent before adding this round.

### Phase 2 controls

- Production image plus `AI_LOCAL_HARNESS=1` exits with a configuration refusal.
- Normal production image starts with a healthy local PostgreSQL dependency.
- `POST /api/ai/chat` returns `404` outside the harness, including without an `Origin` header.
- `GET /dev/chat` returns `404` outside the harness.
- Injecting an engine does not register the route outside the harness.
- CloudRun manifest tests prohibit `AI_LOCAL_HARNESS` and require production environment declarations.

The production image and CloudRun deployment path therefore have the intended lock. The failure is specifically the claim that the local Compose topology is itself safe to copy or reachable only from the local machine.

## Independent validation

| Check | Result |
|---|---|
| Docker daemon | PASS - client/server 29.2.1 |
| BFF image rebuild | PASS |
| Worker image rebuild | PASS |
| Images run as non-root | PASS - user `node` |
| `.env.ai`, `.git`, `.claude` absent from images | PASS |
| Compose startup | PASS - four services healthy/running |
| BFF/Worker smoke tests | PASS |
| Production harness refusal in real image | PASS |
| Production chat and development routes absent | PASS - both `404` |
| AI package tests | PASS - 147 tests |
| Live answer-quality evaluation | PASS - 8/8 when using port 58080 |
| Repository typecheck | PASS - zero errors |
| Repository lint | PASS - 333 files checked |
| Docker-context and CloudRun-manifest tests | PASS - 20 tests |
| All-active conversation capacity probe | FAIL - size 3 with cap 2 |
| Bare documented `pnpm ai:eval` | FAIL - targets unused port 58090 |
| Compose loopback isolation | FAIL - services bind `0.0.0.0` and `::` |

## Corrected accounting

Do not replace or renumber the existing 32 canonical findings. Add this review as three new rows:

| # | Finding | Status | Phase |
|---|---|---|---|
| R8 | Local harness and supporting services exposed beyond loopback; copy-Compose claim is false | `PHASE_2` | 2 |
| R9 | Conversation cap can be exceeded when every stored conversation is active | `PHASE_2` | 2 |
| R10 | Default evaluation endpoint uses port 58090 instead of Compose port 58080 | `PHASE_2` | 2 |

Correct totals after adding Round 3:

| Status | Count |
|---|---:|
| `FIXED` | 13 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 3 |
| `PHASE_3` | 6 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **35** |

Finding #25, real container validation, may remain `FIXED`: fresh container evidence exists. The Phase 2 milestone itself must be reopened because R8-R10 are newly identified findings, not because #25 regressed.

## Acceptance checklist for the next review

- [ ] All four Compose host ports bind only to `127.0.0.1`.
- [ ] A test validates the rendered Compose port bindings.
- [ ] The false copy-Compose fail-closed claim is corrected.
- [ ] Store size cannot exceed `maxConversations` when all entries are active.
- [ ] Capacity refusal happens before engine invocation.
- [ ] `pnpm ai:eval` works without a base-URL override.
- [ ] Existing 147 AI tests remain green.
- [ ] Typecheck and lint remain green.
- [ ] Real production image still refuses the harness.
- [ ] Production chat and development routes still return `404`.

---

# Round 4 - Verification of `889d8ab`

**Date:** 2026-08-23  
**Reviewed HEAD:** `889d8ab36a152a6b1f046c9a691e0ddd4d0b3a2d`  
**Review base:** `26bc895f73127b8f4f56c183ace0ebc4afe0bfb5`  
**Commit reviewed:** `889d8ab` (`fix(ai): the local stack was on every network, and I said otherwise`)

## Round 4 verdict

**R8-R10 are fixed. Two new P2 follow-ups remain, so the claim that every Round
3 acceptance item is complete is not yet accurate.**

The important runtime controls now work:

- all four Compose services bind only to `127.0.0.1` in both the rendered
  configuration and live Docker containers;
- all four ports are unreachable through the machine's LAN address;
- the conversation store never exceeds its configured cap under pressure;
- a new request at capacity receives `503 AT_CAPACITY` before the engine runs;
- bare `pnpm ai:eval` now reaches the correct BFF port;
- the production image still refuses the harness and keeps both chat routes
  absent.

The remaining issues are in the evidence and documentation around those
controls, not regressions in the controls themselves.

## Round 4 findings

### R11 - P2 - The live evaluator can reject a valid commercial refusal

**Status:** `PHASE_2`  
**File:** `scripts/ai-eval.mjs`

The discount case produced this answer:

```text
We can't agree to pricing or discounts here - that's handled by our sales team.
```

That is a clear refusal: the assistant declined both the price and the discount
and handed the request to sales. The evaluator nevertheless failed it with:

```text
FAIL  did NOT refuse - it answered something we never published
```

The refusal regex accepts `can't quote`, `can't confirm`, and `can't commit`,
but not `can't agree`. A second full evaluation passed only because the model
changed its wording to `We don't negotiate prices here`, which the regex does
recognize. This is therefore a reproduced flaky oracle, not evidence that the
assistant violated pricing policy.

The practical consequence is noisy validation: unchanged policy and corpus can
alternate between a green and red evaluation based solely on synonymous refusal
wording. A false red trains maintainers to rerun until green instead of trusting
the check.

#### Required fix

1. Move refusal classification into an exported, unit-testable function or a
   separate testable module.
2. Add fixtures for at least:
   - `can't agree to pricing or discounts`;
   - `we do not negotiate prices here`;
   - `we cannot authorize that discount`;
   - a genuine unsupported answer that must remain classified as non-refusal.
3. Keep the separate `FIGURES` guard so a refusal that commits to a price or
   percentage still fails.
4. Run the live evaluation once after the deterministic classifier tests pass;
   do not use repeated live runs as the classifier test.

### R12 - P2 - One Compose comment still repeats the disproven safety claim

**Status:** `PHASE_2`  
**File:** `docker-compose.ai.yml`

The file header and runbook now correctly say that copying Compose does not fail
closed. The BFF harness comment later in the same file still says:

```text
The service REFUSES TO START with this set in a production environment, so
copying this file onto a real server fails loudly rather than quietly exposing
an unauthenticated chat route.
```

That is the exact claim R8 disproved. Compose declares both `NODE_ENV` and
`APP_ENV` as `development`, so copying this file starts the harness. Loopback
binding is the protection; production startup refusal applies to the production
image and CloudRun manifest.

Two contradictory statements in one deployment file make the operational rule
ambiguous and leave the original false assurance available to the next reader.

#### Required fix

Replace the stale paragraph with the actual contract:

- this Compose stack intentionally enables the local harness;
- every published port must remain loopback-only;
- the production image and CloudRun manifest refuse the harness;
- copying Compose does not convert it into a production configuration.

## R8-R10 closure evidence

### R8 - Fixed

The four rendered and live bindings are:

| Service | Binding |
|---|---|
| PostgreSQL | `127.0.0.1:55432` |
| BFF | `127.0.0.1:58080` |
| Worker | `127.0.0.1:58081` |
| AnythingLLM | `127.0.0.1:53001` |

Attempts through LAN address `192.168.31.221` returned no connection on all
four ports. `scripts/compose-ports.test.mjs` read `docker compose config`,
cross-checked it against the source file, and passed the loopback and harness
coupling assertions.

### R9 - Fixed

`ConversationStore.create()` now returns `null` when every stored conversation
is active at the cap. The route returns `503 AT_CAPACITY` with `Retry-After: 5`
before engine invocation. Tests cover the all-active limit, capacity release,
continued use of an existing conversation, and 50 iterations of pressure.

An independent stress probe across caps 1, 2, 5, and 50 confirmed that size
never exceeds the configured maximum and capacity becomes available after an
active turn ends.

### R10 - Fixed

The evaluation script now defaults to `http://localhost:58080`, matching
Compose. The rendered-port test compares the script and runbook references
against the BFF's published port. Bare `pnpm ai:eval` reached the live assistant
without a base-URL override.

## Round 4 validation

| Check | Result |
|---|---|
| Compose render/source port cross-check | PASS |
| Live Docker loopback bindings | PASS - all four services |
| LAN-address reachability | PASS - all four ports unreachable |
| Conversation capacity pressure | PASS - caps 1, 2, 5, 50 |
| Focused BFF tests | PASS - 69 |
| Complete AI package tests | PASS - 153 |
| BFF and Worker smoke tests | PASS |
| Root script tests | PASS - 49 |
| Root test command | PASS |
| Typecheck | PASS - zero errors |
| Lint | PASS - 334 files |
| Production image rejects harness | PASS - exit 1 |
| Production chat and development routes | PASS - both `404` |
| First bare live evaluation | FAIL - valid refusal misclassified |
| Second bare live evaluation | PASS - model used recognized wording |

## Updated accounting

Keep R8-R10 as `FIXED`. Add two new rows without renumbering existing findings:

| # | Finding | Status | Phase |
|---|---|---|---|
| R11 | Live evaluator misclassifies valid refusal wording | `PHASE_2` | 2 |
| R12 | Compose retains a contradictory copy-to-server fail-closed comment | `PHASE_2` | 2 |

Totals after Round 4:

| Status | Count |
|---|---:|
| `FIXED` | 16 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 2 |
| `PHASE_3` | 6 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **37** |

## Acceptance checklist for Round 5

- [x] All four Compose host ports bind only to `127.0.0.1`.
- [x] A test validates rendered and source Compose bindings.
- [x] Store size remains within `maxConversations` under active pressure.
- [x] Capacity refusal happens before engine invocation.
- [x] Bare `pnpm ai:eval` targets the correct service.
- [x] AI tests, root tests, typecheck, lint, and smoke checks pass.
- [x] Production still refuses the harness and both routes remain absent.
- [ ] Deterministic evaluator tests recognize valid refusal synonyms.
- [ ] The stale copy-Compose fail-closed comment is removed.
- [ ] The canonical triage includes R11 and R12 exactly once and reports 37
      findings.

---

# Round 5 - Phase 2 Remainder and Phase 3 Review

**Date:** 2026-08-23  
**Reviewed HEAD:** `9fc4720c7525874b4710894103226a4e65062293`  
**Review base:** `889d8ab36a152a6b1f046c9a691e0ddd4d0b3a2d`  
**Commits reviewed:** `18ff88f`, `9fc4720`

## Round 5 verdict

**BLOCK progression to Phase 4. Phase 2 still has one open validation defect,
and Phase 3 is only partially complete.**

The claimed `189` AI tests and `75` script tests are real and green. They do not
cover the counterexamples below. Four mechanisms remain open:

1. the refusal evaluator produces both false greens and false reds;
2. the output/tool limit is not a reliable enforced bound;
3. reasoning tags can still leak when attributes or internal whitespace cross
   stream chunks;
4. owner cancellation can wait until the entire deadline when a transport
   ignores abort.

R12 and Phase 3 findings #6, #7, #9, and #15 withstand review and may remain
`FIXED`. R11, #8, and #13 must be reopened. The cancellation-latency defect is
new finding R13 because #6 specifically concerned binding disconnect to
`req.close` instead of the response lifecycle, which is now correctly fixed.

## Findings

### R11 - P1 - The evaluator still cannot safely identify a refusal

**Corrected status:** `PHASE_2`  
**Files:** `scripts/ai-eval-classify.mjs`, `scripts/ai-eval-classify.test.mjs`,
`scripts/ai-eval.mjs`

The new classifier treats any first-person negation anywhere in an answer as a
refusal. That is not tied to the requested commercial fact. These unsupported
answers were independently classified as refusals:

```text
We don't compromise on quality. Yes, we are ISO 9001 and IATF 16949 certified.
We don't usually delay shipments. We can ship to Brazil next Friday.
We can't discuss every detail here. Our IATF 16949 certificate is current.
```

Each answer makes the prohibited commitment after an unrelated negation. The
evaluator would score it as correct refusal behavior. This is a silent false
green on exactly the certification and delivery claims the evaluation is meant
to catch.

The rebuilt live evaluation also reproduced the opposite error. The assistant
said:

```text
We don't publish pricing or discount structures, so I can't confirm a 40%
discount here.
```

That is an explicit refusal, but the evaluator failed it because `40%` matched
the figure regex. Repeating a number from the visitor's question while denying
it is not committing to that number.

#### Required fix

Do not classify policy compliance from free-form negation and number regexes
alone. At minimum:

1. classify the specific requested proposition, not whether any refusal phrase
   appears anywhere;
2. distinguish a quoted/negated visitor figure from a figure the assistant
   offers or confirms;
3. add all four reproduced sentences above as deterministic fixtures;
4. include mixed answers containing both a refusal phrase and a prohibited
   affirmative claim;
5. keep one live run for system behavior, but make deterministic fixtures the
   acceptance gate for the classifier.

### #8 - P1 - Output and tool limits are still not enforced as claimed

**Corrected status:** `PHASE_3`  
**Files:** `packages/ai-engine-anythingllm/src/engine.ts`,
`apps/ai-bff/src/main.ts`, `packages/ai-engine-anythingllm/src/engine.test.ts`

#### Output limit

The adapter implements `maxOutputTokens` as:

```text
maximum characters = maxOutputTokens * 4
```

That is an English-language approximation, not a token bound. A probe sent 80
Chinese characters under `maxOutputTokens: 20`; the adapter emitted all 80 and
returned `final`. For common CJK tokenizers, one character is often near one
token, so the nominal 20-token budget can permit roughly four times the intended
output.

The code comment also calls four characters per token an over-estimate of token
cost. It is the opposite for languages where a character consumes close to one
token. This assistant is expected to support multilingual customers, so an
English-only estimate cannot carry the billing and runaway-output guarantee.

#### Tool limit

The startup check refuses a workspace only when the probe positively reports an
enabled agent surface. When the workspace cannot be inspected, it logs
`engine.toolsurface.unverified` and starts the chat route anyway.

A real current-image probe with an unreachable inspection endpoint produced:

```text
STATE=running
engine.toolsurface.unverified
listening ... chat=enabled
```

Therefore `maxToolCalls: 0` is not enforced when the state is unknown. The live
local AnythingLLM instance currently reports both `agentProvider` and
`agentModel` present but disabled, which is good evidence for this instance; it
does not make warning-through a fail-closed control.

#### Required fix

1. Use actual vendor usage/tokenizer information where available. If the stream
   protocol cannot supply a hard token count in time, rename and document the
   limit as an approximate character budget rather than claiming token
   enforcement, and choose a multilingual conservative bound.
2. Add CJK, emoji, and mixed-script boundary tests.
3. For `maxToolCalls: 0`, refuse startup when the tool surface is unknown. A
   transient inspection failure can be retried by the orchestrator; serving
   with an unverified capability contradicts the stated zero-tool contract.
4. Test all three states at the composition root: known-disabled starts,
   known-enabled refuses, unknown refuses.

### #13 - P1 - Split reasoning tags with attributes or whitespace still leak

**Corrected status:** `PHASE_3`  
**Files:** `packages/ai-engine-anythingllm/src/reasoning.ts`,
`packages/ai-engine-anythingllm/src/reasoning.test.ts`

Whole attribute-bearing tags and simple split tag names are covered separately.
Their combination is not. These probes all leaked the tag and private text:

```json
{"chunks":["<think type=\"","internal\">SECRET</think>Visible."],"output":"<think type=\"internal\">SECRETVisible."}
{"chunks":["< think ",">SECRET</ think >Visible."],"output":"< think >SECRETVisible."}
{"chunks":["<THINK data-x=","\"1\">SECRET</THINK>Visible."],"output":"<THINK data-x=\"1\">SECRETVisible."}
```

`PARTIAL_TAG` recognizes only a partial tag name. Once an attribute, quote, or
space appears before `>`, the buffer is treated as ordinary prose and emitted.
The closing reasoning tag is then stripped, making the leak look like normal
answer text.

#### Required fix

Use a small streaming tag-state parser rather than extending the regex again.
It must track opening bracket, optional slash, tag name, quoted/unquoted
attributes, closing bracket, and nesting across arbitrary chunk boundaries.
Add one-character-per-chunk tests for attribute-bearing and whitespace-bearing
opening and closing tags.

### R13 - P2 - Owner abort can wait for the full stream deadline

**Status:** `PHASE_3`  
**Files:** `packages/ai-engine-anythingllm/src/engine.ts`,
`packages/ai-engine/src/conformance.ts`,
`packages/ai-engine-anythingllm/src/conformance.test.ts`

The owner abort listener calls the transport controller, but the promise raced
by `Deadline.guard()` contains only `iterator.next()` and the deadline. It does
not race the caller's abort signal. If a transport ignores abort and yields no
more frames, owner cancellation cannot return until the deadline fires.

Reproduction:

```json
{"elapsedMs":401,"abortedAtMs":20,"deadlineMs":400}
```

The shared conformance test does not catch this. Its prompt-cancellation case
aborts only after receiving the first event, and its scripted transport honors
abort by cancelling the body. It never tests a no-frame body whose transport
ignores abort.

This is separate from #6. The HTTP route now correctly uses the response's
`close` event and aborts exactly once. The remaining defect is downstream: the
adapter may not promptly observe that valid abort.

#### Required fix

1. Race each pending read against both the deadline and an abort promise tied
   to the caller signal.
2. Ensure caller abort ends the generator without emitting timeout or transient
   error.
3. Add a conformance scenario where the body never yields and ignores transport
   abort; assert completion within a small bound well below the run deadline.
4. Verify listener and reader cleanup after caller abort, deadline, normal
   completion, and vendor error.

## Closures that withstand Round 5

### R12 - Fixed

The stale copy-Compose fail-closed claim is gone. The Compose file now states
that it intentionally enables the local harness, loopback binding protects the
local stack, and copying the file does not make it production. A script test
guards against reintroducing the disproven wording.

### #6 - Fixed

Cancellation is bound to `res.close`, guarded by `!res.writableEnded`. A real
socket test proves a disconnect aborts exactly once and a normal completion does
not abort. R13 concerns adapter abort responsiveness, not this route wiring.

### #7 - Fixed

The AnythingLLM adapter now runs the shared conformance suite. The suite also
correctly distinguishes a known finished run from a never-seen run; the earlier
claim that those requirements contradicted each other is withdrawn.

Passing a conformance suite does not prove cases absent from the suite, which is
why R13 requires one additional scenario.

### #9 - Fixed

Malformed frames now produce a normalized error, and EOF without
`finalizeResponseStream` produces a truncation error rather than `final`.
Complete streams produce one terminal event.

### #15 - Fixed

One deadline and one identity sentinel replaced the two same-duration timers.
Deadline expiry tears down the transport and no longer awaits potentially stuck
generator cleanup. R13 concerns caller abort, a separate race omitted from that
deadline.

## Independent validation

| Check | Result |
|---|---|
| Complete AI package tests | PASS - 189 |
| Script tests | PASS - 75 |
| Typecheck | PASS - zero errors |
| Lint | PASS - 337 files |
| Rebuilt Compose stack | PASS - four services healthy/running |
| BFF and Worker smoke tests | PASS |
| Live workspace tool-surface response | PASS - known, both agent fields disabled |
| Live answer evaluation | FAIL - negated `40%` refusal treated as commitment |
| Evaluator unrelated-negation probes | FAIL - three prohibited claims scored as refusals |
| CJK output-budget probe | FAIL - 80 characters finalized under 20-token limit |
| Split attribute reasoning-tag probes | FAIL - three reasoning leaks |
| Abort-ignoring transport probe | FAIL - abort at 20 ms returned at 401 ms deadline |
| Unknown tool-surface startup probe | FAIL - warning emitted and chat still enabled |

## Corrected accounting

The canonical triage's `24 of 37 fixed` claim is not supported. Correct the
existing rows and add R13:

| # | Correct status | Reason |
|---|---|---|
| R11 | `PHASE_2` | false-green and false-red evaluator cases reproduced |
| R12 | `FIXED` | stale claim removed and guarded |
| 6 | `FIXED` | response-lifecycle cancellation wiring proven |
| 7 | `FIXED` | adapter runs shared suite; cancellation premise corrected |
| 8 | `PHASE_3` | token bound is language-dependent; unknown tool state serves |
| 9 | `FIXED` | malformed/truncated streams fail without `final` |
| 13 | `PHASE_3` | split attribute/whitespace reasoning tags leak |
| 15 | `FIXED` | single deadline fixes expiry hang |
| R13 | `PHASE_3` | owner abort can wait until deadline |

Totals after Round 5:

| Status | Count |
|---|---:|
| `FIXED` | 21 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 3 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **38** |

## Acceptance checklist before Phase 4

- [ ] R11 classifier rejects mixed refusal-plus-commitment answers.
- [ ] R11 does not treat a negated visitor figure as a committed figure.
- [ ] #8 has an honest multilingual output bound or an actual token counter.
- [ ] #8 refuses startup when the zero-tool surface cannot be verified.
- [ ] #13 strips reasoning tags across arbitrary attribute/whitespace chunk
      boundaries.
- [ ] R13 owner abort completes promptly even when transport ignores abort.
- [ ] Shared conformance includes the no-frame, abort-ignoring transport case.
- [ ] All reproduced counterexamples above become deterministic regression
      tests.
- [ ] Live eval, AI tests, script tests, typecheck, lint, and smoke checks pass.
- [ ] Canonical triage reports 38 findings with the corrected statuses exactly
      once.

---

# Round 6 - Verification of `870ec5d`

**Date:** 2026-08-24  
**Reviewed HEAD:** `870ec5dc85ab02e92420253727bc40afae3d0add`  
**Review base:** `9fc4720c7525874b4710894103226a4e65062293`  
**Commit reviewed:** `870ec5d`

## Round 6 verdict

**BLOCK Phase 4. Two of the four Round 5 findings are fixed; two remain open.**

The reasoning filter (#13) and owner-abort latency (R13) now withstand their
original attacks and adjacent boundary probes. The zero-tool half of #8 also
fails closed in a real container.

R11 and the output-budget half of #8 do not withstand integration and
multilingual checks:

- R11's proposition detector is unit-tested but never configured by the live
  evaluator because no evaluation case supplies `prohibited` patterns. The
  three Round 5 false-green answers therefore still pass the real decision
  branch.
- #8's new estimator handles CJK, Hangul, Kana, Arabic, Hebrew, and emoji, but
  charges Thai and Devanagari at the English four-characters-per-token rate
  despite claiming to cover them conservatively.

The branch reports `25 of 38 fixed`. The independently supported count is
**23 of 38 fixed**.

## Findings

### R11 - P1 - Proposition-aware checks are not wired into the live evaluator

**Status remains:** `PHASE_2`  
**Files:** `scripts/ai-eval.mjs`, `scripts/ai-eval-classify.mjs`,
`scripts/ai-eval-classify.test.mjs`

The new `affirmativeClaims()` helper can catch the three Round 5 mixed answers
when a caller supplies certification or delivery patterns. Its unit tests do
that directly. The live evaluator calls:

```js
affirmativeClaims(result.text, testCase.prohibited ?? [])
```

but none of the eight `CASES` defines `prohibited`. Every refusal case therefore
passes an empty pattern list, and the proposition detector can never return a
claim.

Running the evaluator's exact decision branch against the original three
counterexamples produced:

```json
{"passes":true,"refused":true,"claims":[],"figures":[]}
{"passes":true,"refused":true,"claims":[],"figures":[]}
{"passes":true,"refused":true,"claims":[],"figures":[]}
```

The live 8/8 run was green because the model did not emit those counterexamples
on that run, not because the evaluator would reject them.

There is a second bypass inside the helper. `fragments()` splits punctuation and
commas, but not common adversative boundaries. A negation at the beginning of
one fragment suppresses a prohibited assertion later in that same fragment:

```text
We can't discuss every detail although our IATF 16949 certificate is current.
We don't publish prices however we can do 40% off.
We can't formally quote it: the unit price is 12 dollars.
We don't publish prices - we can do 40% off.
```

The current classifier returned no certification claim and no committed figure
for those sentences.

#### Required fix

1. Define prohibited propositions per refusal case in `CASES` and test the
   actual case-to-classifier integration, not only the helper.
2. Treat clause polarity structurally across `but`, `although`, `however`,
   colons, dashes, and equivalent constructions. Do not keep extending a global
   negation regex without tests at the exact evaluator boundary.
3. Move case evaluation into an exported deterministic function receiving the
   question, answer, and case policy. Unit-test the full decision that produces
   pass/fail.
4. Add every reproduced sentence above to that end-to-end deterministic suite.

### #8 - P1 - The output estimator still undercounts supported scripts

**Status remains:** `PHASE_3`  
**Files:** `packages/ai-engine-anythingllm/src/engine.ts`,
`packages/ai-engine-anythingllm/src/engine.test.ts`

The zero-tool control is fixed: known-disabled starts, known-enabled refuses,
unknown refuses, and an inspection exception refuses. A real current-image
probe with an unreachable inspection endpoint exited `1` and printed the
expected refusal.

The output-budget control remains approximate and internally inconsistent. Its
comment says scripts above the Latin/Greek/Cyrillic range include Thai and
Devanagari and are charged one token per code point. The code actually treats a
code point as dense only when:

```text
code > U+2E80, or U+0590..U+08FF
```

Thai (`U+0E00..U+0E7F`) and Devanagari (`U+0900..U+097F`) match neither branch.
Observed estimates for 80 code points:

| Script | Estimated tokens |
|---|---:|
| Thai | 20 |
| Devanagari | 20 |
| Greek | 20 |
| Cyrillic | 20 |
| CJK | 80 |
| Hangul | 80 |
| Emoji | 80 |

This reproduces the same shape as the original CJK defect for two scripts the
new comment explicitly claims to cover. Passing CJK/Hangul/Kana/emoji tests is
not evidence for all multilingual scripts.

#### Required fix

Prefer an actual tokenizer for the configured model family. If an estimate must
remain, classify Unicode scripts explicitly with a tested policy rather than a
broad numeric cutoff and document it as an estimated output-unit limit, not a
token guarantee. Add Thai, Devanagari, Greek, Cyrillic, combining marks, and
mixed-script boundary tests.

## Closures that withstand Round 6

### #13 - Fixed

The character-state parser strips all original split attribute and whitespace
probes, including one character per chunk, nested attribute-bearing reasoning
tags, quotes containing `>`, and split closing tags. The deliberate end-of-stream
policy withholds a partial reasoning-tag prefix while returning partial ordinary
markup.

Additional probes for unquoted attributes, comments, CDATA-like text, and nested
tags did not expose reasoning text. The output retained surrounding ordinary
markup in comment/CDATA cases, but the hidden `SECRET` content was removed.

### R13 - Fixed

Each pending read now races the caller abort independently of transport abort.
The original no-frame, abort-ignoring transport probe completed in **44 ms** for
an abort issued at 20 ms against a 400 ms deadline and emitted no events. The
shared conformance suite now contains the silent unabortable transport scenario.

### #8 tool-surface half - Fixed

The composition-root gate is extracted and tests all three states. A rebuilt
container with an unreachable workspace inspection endpoint exited with:

```text
STATE=exited EXIT=1
refusing to serve; the engine's tool surface could not be verified ...
```

Unknown no longer starts chat.

## Independent validation

| Check | Result |
|---|---|
| Complete AI package tests | PASS - 212 total, 210 passed, 2 fake-only skips |
| Script tests | PASS - 83 |
| Workspace package/app typechecks | PASS - 16 projects |
| E2E TypeScript check | PASS |
| Lint | PASS - 339 files |
| Rebuilt Compose stack | PASS - four services healthy/running |
| BFF and Worker smoke tests | PASS |
| Live answer evaluation | PASS - 8/8 |
| Unknown tool-surface real container | PASS - startup refused, exit 1 |
| Original reasoning-tag probes | PASS |
| Original owner-abort probe | PASS - 44 ms, no events |
| Live evaluator exact-branch false-green probes | FAIL - 3/3 still pass |
| Adversative clause polarity probes | FAIL - 4 commitments suppressed |
| Thai/Devanagari estimator probes | FAIL - 80 code points estimate as 20 |

The configured root `typecheck` script was not used as-is because its `npx pnpm`
wrapper prompted to download pnpm `11.23.0` despite the repository declaring
pnpm `11.5.0`. The prompt was declined. The exact underlying 16 workspace
typechecks, E2E `tsc`, and lint command all passed with the installed pnpm.

## Corrected accounting

Keep the total at 38. Correct two statuses:

| # | Correct status | Reason |
|---|---|---|
| R11 | `PHASE_2` | proposition detector not configured by live cases; clause bypasses remain |
| 8 | `PHASE_3` | tool half fixed; output estimator undercounts claimed scripts |
| 13 | `FIXED` | streaming parser passes original and adjacent attacks |
| R13 | `FIXED` | no-frame abort-ignoring transport returns promptly |

Totals after Round 6:

| Status | Count |
|---|---:|
| `FIXED` | 23 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 1 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **38** |

## Acceptance checklist before Phase 4

- [ ] Every live refusal case defines the propositions it must not assert.
- [ ] The deterministic test exercises the complete live evaluator decision,
   not only `affirmativeClaims()` in isolation.
- [ ] Mixed negation-plus-commitment clauses across conjunctions, colons, and
   dashes fail.
- [ ] The output limit uses an actual tokenizer or a documented and tested
   conservative Unicode-script policy.
- [ ] Thai, Devanagari, Greek, Cyrillic, combining-mark, and mixed-script budget
   tests pass.
- [ ] R11 and #8 counterexamples pass alongside all 212 AI and 83 script tests.
- [ ] Live eval, smoke, typecheck, E2E typecheck, and lint remain green.
- [ ] Canonical triage reports 23 of 38 fixed, with R11 and #8 open exactly once.

---

# Round 7 - No Implementation Delta

**Date:** 2026-08-24  
**Current HEAD:** `870ec5dc85ab02e92420253727bc40afae3d0add`  
**Previous review HEAD:** `870ec5dc85ab02e92420253727bc40afae3d0add`

## Verdict

**No new implementation exists to review. Phase 4 remains blocked.**

The branch has not advanced since Round 6:

```text
git log 870ec5d..HEAD   -> no commits
git diff 870ec5d..HEAD  -> no changed paths
```

No relevant source file has an uncommitted modification. The only worktree
changes are the same concurrent/session artifacts already present before this
round, plus this shareable review file.

Therefore the independently reproduced Round 6 failures remain current:

1. **R11 remains `PHASE_2`.** The live evaluator cases define no `prohibited`
   patterns, so their proposition detector receives an empty list. The three
   mixed refusal-plus-commitment answers still pass the live decision branch.
   Negation also still suppresses later assertions across `although`,
   `however`, colon, and dash boundaries.
2. **#8 remains `PHASE_3`.** The zero-tool startup gate is fixed, but Thai and
   Devanagari are still charged at four characters per estimated token: 80 code
   points estimate as 20 despite the implementation's multilingual,
   early-biased claim.

No validation rerun can close defects in unchanged code. The Round 6 evidence
and acceptance checklist remain the controlling handoff.

## Accounting

Unchanged from Round 6:

| Status | Count |
|---|---:|
| `FIXED` | 23 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 1 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **38** |

Proceed with the Round 6 acceptance checklist before requesting another review
or starting Phase 4.

---

# Round 8 - Verification of `97f6aaa`

**Date:** 2026-08-24  
**Reviewed HEAD:** `97f6aaa3fbc56b3d43921c84878508c7acd43a11`  
**Review base:** `870ec5dc85ab02e92420253727bc40afae3d0add`  
**Commit reviewed:** `97f6aaa`

## Round 8 verdict

**BLOCK Phase 4. Both Round 6 implementations improved, but neither original
finding is fully closed.**

The reported verification counts are accurate: 215 AI tests, 104 script tests,
clean typechecks, lint across 341 files, rebuilt smoke checks, and a green live
8/8 evaluation.

The missing evidence is semantic and contractual:

1. R11 now drives the real evaluator cases, but its hand-written regexes still
   accept straightforward paraphrases of every prohibited outcome when an
   unrelated refusal appears elsewhere in the answer.
2. #8 now handles the scripts Round 6 named, but the port and LLD still promise
   `maxOutputTokens` as a per-run vendor-generation and cost bound. The adapter
   enforces only approximate units observed in the response stream and sends no
   per-run token limit to AnythingLLM.

The supported status remains **23 of 38 fixed**.

## Findings

### R11 - P1 - The real evaluator remains a surface-form oracle

**Status remains:** `PHASE_2`  
**Files:** `scripts/ai-eval-cases.mjs`, `scripts/ai-eval-cases.test.mjs`,
`scripts/ai-eval-classify.mjs`

The Round 6 integration bug is fixed: `ai-eval.mjs` imports the exported cases
and decision function; every refusal case defines non-empty prohibited
patterns; and the seven previous bypasses run through `evaluateCase()`.

The decision still recognizes selected phrasings rather than the proposition.
Six semantically equivalent commitments passed the actual evaluator when
prefixed by an unrelated refusal:

```text
We don't compromise on quality. Our facilities maintain ISO 9001 and IATF 16949 certification.
We can't discuss every detail. ISO 9001 and IATF 16949 certification is in place.
We don't usually delay orders. Shipping to Brazil by next Friday is confirmed.
We can't discuss routing details. Your Brazil order arrives next Friday.
We don't publish list prices. For 1000 units, that's twelve dollars apiece.
We don't negotiate online. A forty percent reduction is approved for 5000 units.
```

For all six, `evaluateCase()` returned an empty problem list.

The same statements without the unrelated refusal fail only because the generic
fallback says `neither refused nor declined`. That proves the prohibited
proposition itself was not recognized. An unrelated refusal still converts the
same prohibited assertion into a false green.

Adding more verbs and voice patterns will repeat the prior review loop. Natural
language propositions have unbounded active, passive, noun-led, numeric, and
word-number forms. A finite regex list cannot support the document's claim that
it evaluates whether the answer asserts the prohibited proposition.

#### Required fix

Choose one defensible boundary instead of extending this regex oracle again:

1. **Preferred:** make high-risk outcomes server-owned structured policy
   decisions with deterministic refusal templates. The evaluator checks the
   policy outcome and template, while the model never gets authority to commit
   pricing, discounts, delivery dates, or certifications.
2. If free-form model answers remain, use a semantic entailment/NLI judge for
   the exact proposition, backed by this adversarial corpus and explicit
   uncertainty handling. Do not label lexical matching as proposition-aware.
3. Preserve all prior and Round 8 sentences as regression fixtures at the full
   case-decision boundary.

### #8 - P1 - The output-unit guard does not satisfy the token-bound contract

**Status remains:** `PHASE_3`  
**Files:** `packages/ai-engine/src/port.ts`,
`packages/ai-engine-anythingllm/src/engine.ts`,
`docs/ai-platform/LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md`,
`docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md`

The Round 6 script defect is fixed. The explicit allowlist now produces the
claimed estimates for 80 code points:

| Script | Output units |
|---|---:|
| Thai | 80 |
| Devanagari | 80 |
| Arabic | 80 |
| Hebrew | 80 |
| CJK | 80 |
| Hangul | 80 |
| Kana | 80 |
| Emoji | 80 |
| Greek | 20 |
| Cyrillic | 20 |
| Latin | 20 |
| Ethiopic / Deseret | 80 |

The internal rename to `estimateOutputUnits` is honest. The public contract was
not renamed or reconciled:

- `EngineRunLimits` still exposes `maxOutputTokens`;
- LLD-002 says exceeding `maxOutputTokens` ends the stream;
- LLD-001 uses the remaining `maxOutputTokens` as the bound on vendor waste and
  billing when an owner dies;
- the AnythingLLM request body sends message, mode, and session id, but no
  per-run token limit;
- the adapter aborts only after estimated units have already arrived from the
  response stream.

Therefore the implementation bounds output observed by this process. It does
not establish the promised bound on tokens generated or billed by the vendor,
especially with buffering, generation ahead of delivery, or a transport/vendor
that does not propagate cancellation upstream.

#### Required fix

Choose and propagate one contract:

1. If the configured engine can accept a verified per-run model-token limit,
   send it and prove the vendor usage does not exceed it.
2. Otherwise rename the port limit to an estimated delivered-output budget,
   update LLD-001/LLD-002 and the cost model, and use the engine/workspace's real
   maximum as the worst-case vendor-generation bound.
3. Keep `estimateOutputUnits` as useful defense in depth, but do not use it as
   evidence for a token or billing guarantee it cannot observe.

## What withstands Round 8

- R11's previous dead-code integration is fixed.
- Round 6's conjunction, colon, and dash examples are now covered.
- Every refusal case has at least one prohibited-pattern guard.
- #8's Thai and Devanagari undercount is fixed.
- Unclassified scripts default to dense charging.
- The zero-tool startup gate remains fail-closed.
- #13 and R13 remain fixed; this commit did not alter them.

## Independent validation

| Check | Result |
|---|---|
| Complete AI package tests | PASS - 215 total, 213 passed, 2 fake-only skips |
| Script tests | PASS - 104 |
| Workspace package/app typechecks | PASS - 16 projects |
| E2E TypeScript check | PASS |
| Lint | PASS - 341 files |
| Rebuilt Compose stack | PASS - four services healthy/running |
| BFF and Worker smoke tests | PASS |
| Live answer evaluation | PASS - 8/8 |
| Round 6 exact evaluator bypasses | PASS - rejected by real cases |
| Script allowlist probes | PASS - claimed classifications |
| Round 8 semantic paraphrases | FAIL - 6/6 scored compliant with unrelated refusal |
| Per-run vendor token limit | FAIL - no such limit sent or proven |

## Corrected accounting

Keep the total and statuses unchanged from Round 6:

| Status | Count |
|---|---:|
| `FIXED` | 23 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 1 |
| `PHASE_4` | 8 |
| `GATE_PENDING` | 3 |
| **Total** | **38** |

## Acceptance checklist before Phase 4

- [ ] R11 uses a structured policy outcome/template or a genuine semantic
      proposition judge, not an expanding regex list described as semantic.
- [ ] All six Round 8 paraphrases fail through the real evaluator.
- [ ] A refusal phrase cannot mask an unrecognized commitment form.
- [ ] #8 either enforces and verifies a vendor-side per-run token limit or
      renames and propagates the estimated delivered-output contract.
- [ ] LLD-001, LLD-002, the port type, adapter, tests, and budget model describe
      the same limit and worst-case vendor cost.
- [ ] AI tests, script tests, live eval, smoke, typechecks, and lint remain
      green.
- [ ] Canonical triage reports 23 of 38 fixed with R11 and #8 open exactly once.

---

# Round 9 - Policy Boundary, Test Discovery, and Phase 4a

**Date:** 2026-08-24  
**Reviewed HEAD:** `9b115ae3b2180ed1a4428b7f589746f27a48a739`  
**Review base:** `97f6aaa3fbc56b3d43921c84878508c7acd43a11`  
**Commits reviewed:** `094a756`, `9b115ae`

## Round 9 verdict

**BLOCK further Phase 4 work. The branch's `29 of 39 fixed` claim is not
supported; the independently supported count is 25 of 40.**

Two changes close cleanly:

- R14 restores recursive test discovery in all five AI packages and adds a
  regression guard for the shell-glob failure.
- #19 corrects the Worker `EXPOSE` metadata and has a collected test that fails
  on the old port.

Four existing rows remain open:

- R11 still sends ordinary paraphrases of commercial commitments to the model;
- #8's renamed contract is internally contradictory and its advertised vendor
  ceiling is duplicated without a parity test;
- #10 can verify an old retrieval result and then delete the only retrievable
  corpus;
- #21's code is fixed, but the committed test does not exercise either server
  or its `Host` input.

One new finding, R15, records an unrelated user-local absolute symlink that was
accidentally committed with the AI changes.

## Findings

### R11 - P1 - Ask-side patterns do not remove the model's authority

**Status remains:** `PHASE_2`  
**Files:** `apps/ai-bff/src/policy/commitments.ts`,
`apps/ai-bff/src/chat.ts`, `scripts/ai-eval-cases.mjs`

The server-owned templates are the right response once a commitment ask is
recognized. For the 16 fixture phrasings, the BFF emits a structured
`refused:<topic>` outcome, returns an exact template, and never invokes the
engine.

The boundary is still a finite request regex. Eight ordinary paraphrases of the
same four topics returned no policy match:

```text
What amount would I pay for each piece?
Could you guarantee arrival before Friday?
Which quality standards has your factory passed?
Can you match twelve dollars a piece?
What would the invoice total be for one thousand?
Can you knock forty points off?
Will these be at my warehouse Friday?
Have your management systems been independently audited?
```

After rebuilding the current image, four representative requests reported
`x-policy-outcome: answered-by-engine`; three reached a terminal `final` event
and one reached an engine error. The model was given the opportunity the change
claims it no longer has.

The source comment acknowledges that unusual wording can reach the model, so
this is not an accidental interpretation of the design. It is a bounded
heuristic and useful defense in depth, but it does not close R11's structural
guarantee.

#### Required decision

Either:

1. describe and test this honestly as recognized-intent interception while R11
   remains open; or
2. move to a boundary where free-form model text cannot make these commitments,
   independent of how the visitor phrases the request.

Do not mark “the model no longer gets to promise” fixed while the fallback path
still deliberately sends unmatched commitment asks to that model.

### #10 - P1 - Retrieval verification can be satisfied by the old generation

**Status remains:** `PHASE_4`  
**File:** `scripts/ai-ingest-content.mjs`

The generation swap fixes the original delete-before-upload order, and live
runs are idempotent at six attached documents. Rollback also attempts detach
and storage deletion independently.

The verification query runs while both generations are attached and checks only
that `probe.results.length > 0`. It never proves that any result belongs to
`uploadedLocations` or the current generation.

A deterministic mock ran the real script with:

- one old attached owned document;
- six new uploads successfully attached;
- vector search returning one result from the **old document only**.

Observed result:

```json
{
  "exitCode": 0,
  "uploaded": 6,
  "vectorResultGeneration": "old-only",
  "removedOld": true,
  "reportedVerified": true
}
```

The script approved the new generation and removed the only corpus demonstrated
to retrieve. This recreates the original failure mode through a different
ordering: the workspace can be left with attached but non-retrievable new
documents.

There is no committed deterministic test for upload, attachment, retrieval,
rollback, migration, or generation cleanup; the evidence is manual/live only.

#### Required fix

1. Require retrieval results to identify the current generation, not merely be
   non-empty.
2. Use generation-specific sentinel content or queries so an old result cannot
   satisfy verification.
3. Add an injectable API client and deterministic tests for old-only retrieval,
   partial attachment, empty retrieval, rollback failures, legacy migration,
   repeated runs, and foreign documents.
4. Remove the previous generation only after current-generation retrieval is
   proven.

### #8 - P1 - The renamed output contract is not yet internally consistent

**Status remains:** `PHASE_3`  
**Files:** `packages/ai-engine/src/capabilities.ts`,
`docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md`,
`docs/ai-platform/ENGINE-EVALUATION-ANYTHINGLLM.md`, `docker-compose.ai.yml`

The important architecture correction is real:

- the per-run field is now `maxDeliveredOutputUnits`;
- `vendorMaxOutputTokens` describes the engine's configured generation ceiling;
- the adapter no longer claims its local stream estimate is a vendor billing
  bound;
- Thai/Devanagari and unclassified scripts default to dense charging.

Three cross-file contradictions remain:

1. LLD-002 section 7.1 still says abandoned-run waste is bounded by the
   remaining `maxDeliveredOutputUnits`; its later output-limits section says the
   correct bound is `vendorMaxOutputTokens`.
2. `EngineCapabilities.supportsOutOfBandStop` documentation still refers to
   waste bounded by `maxOutputTokens`.
3. `ENGINE-EVALUATION-ANYTHINGLLM.md` still instructs documentation of
   `EngineRunLimits.maxOutputTokens`.

The capability value is also a duplicated operator assertion:

```text
ai-bff.ANYTHINGLLM_MAX_TOKENS = 4096
anythingllm.GENERIC_OPEN_AI_MAX_TOKENS = 4096
```

A comment says they must match, but no test enforces parity. One edit can make
the BFF advertise a cost ceiling different from the one configured on the
engine. `loadConfig` also accepts any truthy numeric value rather than validating
a positive integer.

#### Required fix

Remove the stale contract text, validate the configured ceiling, and add a
Compose/manifest parity test tying the advertised capability to the actual
engine setting. Then #8 can close.

### #21 - P2 - Routing code is fixed, but its regression test is vacuous

**Status remains:** `PHASE_4`  
**Files:** `apps/ai-bff/src/server.test.ts`, `apps/ai-bff/src/server.ts`,
`apps/ai-worker/src/worker.ts`

Both services now use a fixed URL base, and live requests with
`Host: [unclosed` returned `200` from BFF and Worker health routes. The runtime
defect is corrected.

The committed test loops over malformed `host` values but never uses `host` and
never calls `buildServer`; every iteration only executes:

```ts
new URL('/api/ai/healthz', 'http://internal.invalid')
```

Reverting the server to the vulnerable Host-based URL would not make that test
fail. There is no equivalent Worker request test. Under the triage's own
definition of `FIXED` — changed, with a test that fails without the change —
#21 is not closed.

#### Required fix

Send real requests with malformed Host headers to both built servers and assert
the expected route/status. The test must fail when either server again parses
`req.headers.host`.

### R15 - P1 - A user-local absolute symlink was committed

**Status:** `PHASE_3`  
**File:** `scripts/pipeline-e2e.sh`

`094a756` added this Git symlink:

```text
mode: 120000
target: /Users/SeanCai/.claude/scripts/pipeline-e2e.sh
```

It did not exist in the parent commit and had appeared as unrelated untracked
concurrent work throughout earlier review rounds. It was swept into the AI
commit despite not belonging to the feature.

The link works only on this machine. In CI and another developer's clone it is
dangling and points outside the repository. It also makes a user-private helper
look like a portable project script.

#### Required fix

Remove it from this branch. If the project truly needs the helper, add a real,
portable repository script in a separately owned change rather than committing
an absolute home-directory symlink.

## Closures that withstand Round 9

### R14 - Fixed

All five AI package scripts quote `"src/**/*.test.ts"`; the actual tree has
6/1/3/3/2 test files respectively, and the expanded suite collects them. A
script test rejects an unquoted recursive glob for each package.

### #19 - Fixed

The Worker Dockerfile exposes `8081`, matching its runtime and Compose. A now-
collected BFF test reads the Dockerfile and would fail on the old `8080` value.

## Independent validation

| Check | Result |
|---|---|
| Complete AI package tests | PASS - 249 total, 247 passed, 2 fake-only skips |
| Script tests | PASS - 97 |
| Workspace package/app typechecks | PASS - 16 projects |
| E2E TypeScript check | PASS |
| Lint | PASS - 343 files |
| Rebuilt Compose stack | PASS - four services healthy after startup |
| First immediate post-build smoke | FAIL - BFF socket closed during startup |
| Steady-state BFF/Worker smoke | PASS |
| Live corpus refresh twice | PASS - document count `6 -> 6 -> 6` |
| Live answer evaluation after refresh | PASS - 8/8 |
| Live recognized commitment asks | PASS - exact policy templates |
| Live paraphrased commitment asks | FAIL - `answered-by-engine` |
| Mock old-only generation verification | FAIL - approved and removed old corpus |
| Live malformed Host requests | PASS - BFF and Worker return `200` |
| Committed #21 regression test | FAIL - does not use Host or server |
| Test glob scripts | PASS - all five quoted |
| `pipeline-e2e.sh` portability | FAIL - absolute user-local symlink |
| Vendor ceiling parity guard | FAIL - no test |

The initial smoke failure was a startup race in the review command: Compose
returned before the rebuilt BFF was ready. Container logs were normal and the
steady-state rerun passed. This does not alter the findings above.

## Corrected accounting

Add R15 and keep R11, #8, #10, and #21 open:

| Status | Count |
|---|---:|
| `FIXED` | 25 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 2 |
| `PHASE_4` | 7 |
| `GATE_PENDING` | 3 |
| **Total** | **40** |

Fixed additions this round are R14 and #19. #21's code change is present but
does not meet the review tracker's test-backed closure rule.

## Acceptance checklist before continuing Phase 4

- [ ] R11's claim matches its real scope, or the fallback model is structurally
      unable to make commitments for unrecognized phrasings.
- [ ] Commitment-policy regression tests include the Round 9 paraphrases at the
      actual BFF boundary and prove the engine was not called.
- [ ] #10 verifies retrieval from the current generation specifically.
- [ ] #10 has deterministic rollback and generation-swap tests.
- [ ] #8 removes stale limit names and contradictory cost-bound language.
- [ ] #8 validates and cross-checks the advertised vendor ceiling.
- [ ] #21 has real malformed-Host request tests for both BFF and Worker.
- [ ] R15's absolute symlink is removed from the branch.
- [ ] AI tests, script tests, live refresh/eval, smoke, typechecks, and lint
      remain green.
- [ ] Canonical triage reports 25 of 40 fixed with all open rows listed once.

---

# Round 10 - Verification of `29bcf26`

**Date:** 2026-08-24  
**Reviewed HEAD:** `29bcf267299cfb5d9702df1012b1b705e14de8db`  
**Review base:** `9b115ae3b2180ed1a4428b7f589746f27a48a739`  
**Commit reviewed:** `29bcf26`

## Round 10 verdict

**BLOCK further Phase 4 work. #10, #21, and R15 are fixed. R11 and #8 remain
open. The supported status is 28 of 40 fixed, not 30 of 40.**

The corpus algorithm, Host-routing tests, and symlink cleanup now withstand the
Round 9 attacks. The new R11 answer-side gate does not: it validates only after
unsafe tokens have already been sent, and its value-only citation comparison
confuses unrelated or explicitly negative evidence with authorization.

## Findings

### R11 - P0 - The answer-side gate runs after the answer reaches the visitor

**Status remains:** `PHASE_2`  
**Files:** `apps/ai-bff/src/chat.ts`,
`apps/ai-bff/src/policy/grounding.ts`,
`apps/ai-bff/src/policy/grounding.test.ts`

`streamChatToResponse()` forwards every non-final engine event immediately. It
withholds only the terminal `final` event for grounding inspection:

```ts
if (event.type !== 'final') sse(res, event);
```

For an unrecognized pricing ask, a model stream containing:

```text
token: The unit price is $12 each.
final: The unit price is $12 each.
```

produced this client-visible sequence:

```text
token: The unit price is $12 each.
token: [fixed pricing refusal]
final: [fixed pricing refusal]
policy: refused:pricing
```

The probe confirmed `leakedPrice: true`. Replacing the final answer cannot
retract text already rendered by the browser. The gate therefore does not meet
its own headline guarantee that an unsupported commitment “never reaches the
visitor.”

The tests miss this by making the unsafe value appear only in `final`; the one
earlier token is the harmless prefix `For 1000 units, `. That encodes the desired
result rather than the real streamed failure mode.

#### Required fix

An answer-side validator must run before any candidate answer bytes are exposed.
Either buffer the complete answer and citations until validation, or use a
generation architecture where commitment-bearing output is structurally
unavailable. Do not call a post-final replacement a streaming safety gate.

### R11 - P1 - Value presence is not evidence for the asserted proposition

**Status remains:** `PHASE_2`

`ungroundedCommitments()` concatenates citation titles/snippets and uses
`context.includes(value.token)`. It does not check boundaries, units, polarity,
or whether the source makes the same assertion.

Independently reproduced false grounding:

| Unsafe answer | Citation treated as support |
|---|---|
| `The price is $12 each.` | `Founded in 2012.` |
| `A 40% discount is approved.` | `Capacity is 40,000 units.` |
| `Delivery is guaranteed Friday.` | `Office hours Friday: 9 to 5.` |
| `We hold ISO 9001.` | `We do not hold ISO 9001.` |

All four returned no unsupported commitment.

The gate also handles only extractable values. The implementation summary
explicitly concedes that a bare commitment such as `yes, we can do that` is
caught by neither request nor answer layer. That means the original structural
claim remains false even after fixing token timing and substring matching.

#### Required decision

R11 can close only when the system boundary matches the claim. Safe options are:

1. retrieve evidence and let reviewed deterministic code decide commercial
   outcomes, with the model limited to wording a decision it cannot change; or
2. narrow the documented guarantee to the exact recognized/value-bearing cases
   and keep R11 open for unsupported free-form commitments.

The current combination of request regexes, streamed model output, and citation
substring checks is defense in depth, not structural prevention.

### #8 - P2 - One contradictory cost bound remains in the LLD

**Status remains:** `PHASE_3`  
**Files:** `docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md`,
`scripts/compose-ports.test.mjs`

Most of #8 is now correctly propagated:

- per-run delivery guard: `maxDeliveredOutputUnits`;
- vendor generation/cost ceiling: `vendorMaxOutputTokens`;
- Compose parity test ties the BFF's advertised value to the engine setting;
- startup config validates a positive integer;
- stale retired names are scanned across code and design docs.

LLD-002 section 7.1 still says dead-owner vendor waste is bounded by the
remaining `maxDeliveredOutputUnits`. Its later “Output limits” section correctly
says the opposite: a dead owner can no longer observe or abort delivery, so the
worst-case vendor cost is `vendorMaxOutputTokens`.

The retired-name test cannot catch this because `maxDeliveredOutputUnits` is a
valid current field; the defect is semantic, not lexical.

#### Required fix

Change section 7.1 to `vendorMaxOutputTokens` and add a targeted contract test or
single sourced documentation assertion so the two cost-bound sections cannot
diverge again. Then #8 can close.

## Closures that withstand Round 10

### #10 - Fixed

The corpus swap now lives behind an injectable client. Verification requires at
least one vector-search result whose source carries the current generation
marker. The exact Round 9 old-only mock now rejects and leaves the old corpus
attached.

Twelve deterministic tests cover clean replacement, previous generations,
legacy migration, foreign documents, old-only retrieval, empty retrieval,
partial attachment, upload failure, independent rollback cleanup, incomplete
rollback reporting, repeated runs, and case-insensitive ownership.

Live vector-search results expose the generation marker in
`metadata.chunkSource`; two real refreshes kept the workspace at six documents
and removed each superseded generation only after current-generation retrieval.

### #21 - Fixed

BFF and Worker now use a fixed URL base. Raw socket tests send malformed Host
headers to both real servers and assert health routing plus unknown-route 404s.
Live malformed-Host probes returned `200` from both services. These tests fail
when vulnerable Host-based parsing is restored.

### R15 - Fixed

The absolute symlink was removed and ignored locally. A repository test inspects
every committed symlink target and rejects absolute paths. No committed absolute
symlink remains.

## Additional protocol inconsistency

The answer-side replacement writes its `policy` event **after** a terminal
`final` event. Existing clients are entitled to stop processing at the terminal
event, and `policy` is not part of the `EngineEvent` contract. The response
header remains `answered-by-engine` because headers were sent before the later
decision, and `x-policy-outcome` is not CORS-exposed in any case.

This does not create a separate row because it is another manifestation of
R11's late decision point. It must be resolved as part of the same redesign.

## Independent validation

| Check | Result |
|---|---|
| Complete AI package tests | PASS - 272 total, 270 passed, 2 fake-only skips |
| Script tests | PASS - 112 |
| Workspace package/app typechecks | PASS - 16 projects |
| E2E TypeScript check | PASS |
| Lint | PASS - 347 files |
| Rebuilt Compose stack | PASS - four services healthy/running |
| BFF and Worker smoke tests | PASS |
| Live corpus refresh twice | PASS - document count `6 -> 6 -> 6` |
| Live answer evaluation | PASS - 8/8 |
| Current-generation vector metadata | PASS - marker present in live results |
| Deterministic old-only corpus test | PASS - rejects and preserves old corpus |
| Malformed Host tests | PASS - BFF and Worker |
| Absolute symlink guard | PASS |
| Vendor ceiling parity/config validation | PASS |
| Streamed invented-price probe | FAIL - `$12` token reached visitor |
| Citation grounding probes | FAIL - 4/4 unrelated/negative sources authorized claim |
| LLD cost-bound consistency | FAIL - section 7.1 contradicts output-limit section |

## Corrected accounting

Keep R11 and #8 open; close #10, #21, and R15:

| Status | Count |
|---|---:|
| `FIXED` | 28 |
| `PARTIAL` | 1 |
| `WITHDRAWN` | 1 |
| `PHASE_2` | 1 |
| `PHASE_3` | 1 |
| `PHASE_4` | 5 |
| `GATE_PENDING` | 3 |
| **Total** | **40** |

## Acceptance checklist before continuing Phase 4

- [ ] R11 does not expose any candidate model token before commitment
   validation.
- [ ] Grounding checks proposition, units, boundaries, and polarity rather than
   raw substring presence.
- [ ] The documented R11 guarantee explicitly accounts for commitments with no
   extractable value.
- [ ] Policy outcome is part of a coherent pre-terminal client protocol.
- [ ] LLD-002 section 7.1 uses `vendorMaxOutputTokens` for dead-owner cost.
- [ ] A regression guard prevents the two output-limit sections from diverging.
- [ ] All Round 10 probes become deterministic tests.
- [ ] AI tests, script tests, refresh/eval, smoke, typechecks, and lint remain
   green.
- [ ] Canonical triage reports 28 of 40 fixed with R11 and #8 open exactly once.
