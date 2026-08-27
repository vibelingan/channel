# External review triage — AI assistant local phase

Rounds 1–10 by Codex 5.6. Every finding appears **exactly once** in the
canonical table below, with a status. Totals are computed from that table, so
any claim made about progress is checkable against it.

| Status | Meaning |
|---|---|
| `FIXED` | Changed, with a test that fails without the change |
| `PARTIAL` | Code is done; an action outside the repository remains |
| `WITHDRAWN` | Not a distinct finding — duplicate or superseded |
| `PHASE_2/3/4/5` | Accepted, scheduled, not started |
| `GATE_PENDING` | Correct, and unprovable until the resource exists |

---

## Rounds

- **Round 1** — 25 numbered findings against `bc93f0e..8d6ac94`.
- **Round 2** — 7 findings against `8d6ac94..e363fbc`, numbered `R1`–`R7`.
  Round 2 was a **BLOCK**, and it was right to be: three of its findings were
  reproduced here before anything was changed.
- **Round 5** — 1 new finding (`R13`) plus **three reopenings** of items this
  document had marked `FIXED`: R11, #8 and #13. A reopening is worth more than a
  new finding, because a wrong `FIXED` is a claim this document made and did not
  hold. All four were reproduced here before anything changed, and the R13
  timing matched the reviewer's to the millisecond.
- **Round 8** — verified `97f6aaa` and reopened **R11 and #8 a third time**. Both
  reopenings were right, and the R11 one ended the loop: it showed that no
  pattern list can grade free-form answers, so the fix had to remove the model's
  opportunity rather than improve the grader.
- **Round 6** — verified `870ec5d` and reopened **R11 and #8 again**. Round 7
  confirmed no further work had landed. Both reopenings were correct, and both
  were failures of VERIFICATION rather than of the fix idea — see below.
- **Round 3** — 5 findings against `e363fbc..26bc895` and the fix commit that
  followed, numbered `R8`–`R12`.
  Also a **BLOCK**, and also right. R8 identified a **false safety claim** made
  in the Phase 2 commit and runbook, which is the most serious kind of defect in
  this document: a control that was described as existing and did not.

---

## Canonical table — 40 findings

| # | Finding | Status | Phase |
|---|---|---|---|
| 1 | Exposed key handling and secret-printing guidance | `PARTIAL` | done / see note |
| 2 | No root `.dockerignore` | `FIXED` | 1 |
| 3 | Unsafe engine bypass works regardless of `NODE_ENV` | `FIXED` | 2 |
| 4 | `/api/ai/chat` registers whenever an engine is injected | `FIXED` | 2 |
| 5 | Client-supplied assistant history | `FIXED` | 1 |
| 6 | Cancellation bound to `req.close`, not the response socket | `FIXED` | 3 |
| 7 | Adapter does not run the shared conformance suite | `FIXED` | 3 |
| 8 | Output/tool limits: contract promised a token bound nothing could keep — reopened R5, R6, R8 | `FIXED` | 3 |
| 9 | Corrupt or truncated SSE treated as success | `FIXED` | 3 |
| 10 | Corpus refresh: destructive order, then verification the old generation satisfied | `FIXED` | 4 |
| 11 | Workspace policy applied without read-back | `FIXED` | 4 |
| 12 | Readiness ignores the engine; version defaults to `unpinned` | `FIXED` | 4 |
| 13 | Reasoning filter leaks split attribute-bearing tags — reopened R5 | `FIXED` | 3 |
| 14 | Citation URLs relative and unvalidated | `FIXED` | 4 |
| 15 | Two timers for one deadline | `FIXED` | 3 |
| 16 | Ordinary CI job runs database tests without a database | `FIXED` | 1 |
| 17 | `mintplexlabs/anythingllm:latest` is a mutable tag | `FIXED` | 4 |
| 18 | Docker build-context safety | `WITHDRAWN` | — |
| 19 | Worker `EXPOSE 8080` vs actual 8081 | `FIXED` | 4 |
| 20 | Shutdown does not drain | `FIXED` | 4 |
| 21 | Routing URL built from the `Host` header (test was vacuous) | `FIXED` | 4 |
| 22 | CloudRun manifest has no deploy consumer | `GATE_PENDING` | — |
| 23 | VPC / TencentDB / TLS validation | `GATE_PENDING` | — |
| 24 | Production secret management | `GATE_PENDING` | — |
| 25 | Real container validation | `FIXED` | 2 |
| R1 | Partial failed answers stored as authoritative history | `FIXED` | 1 |
| R2 | `x-conversation-id` not readable cross-origin | `FIXED` | 1 |
| R3 | Knowledge brief promises non-existent Alibaba ingestion | `FIXED` | 1 |
| R4 | Concurrent turns can fork and reorder conversation history | `FIXED` | 1 |
| R5 | Dockerignore test fidelity, and a raw NUL sentinel | `FIXED` | 1 |
| R6 | Triage accounting not auditable | `FIXED` | 1 |
| R7 | Knowledge brief overclaims and internal contradictions | `FIXED` | 1 |
| R8 | Compose publishes every service on all interfaces; copy-Compose fail-closed claim was false | `FIXED` | 2 |
| R9 | Conversation cap exceeded when every stored conversation is active | `FIXED` | 2 |
| R10 | Evaluation script default port does not match the Compose port | `FIXED` | 2 |
| R11 | Commercial commitments — reopened R5, R6, R8, R9, R10 | `PARTIAL` | 2 |
| R12 | A disproven safety claim left standing elsewhere in the same file | `FIXED` | 2 |
| R13 | Owner abort waits out the full stream deadline | `FIXED` | 3 |
| R14 | `sh` collapses an unquoted `**` glob; 76 tests silently became 27 | `FIXED` | 3 |
| R15 | A user-local absolute symlink was swept into a feature commit | `FIXED` | 3 |

### Totals, computed from the table

| Status | Count | IDs |
|---|---|---|
| `FIXED` | 34 | 2–17, 19–21, 25, R1–R10, R12–R15 |
| `PARTIAL` | 2 | 1, R11 |
| `WITHDRAWN` | 1 | 18 |
| `GATE_PENDING` | 3 | 22, 23, 24 |
| **Total** | **40** | 34 + 2 + 1 + 3, one row per finding, never renumbered |

Round 2 was right that "21 accepted, 4 disputed" was not derivable from the
previous table. It was a count carried in prose rather than computed, which is
exactly how a status claim drifts from the thing it describes.

**#18 restored and withdrawn.** Round 1's item 18 read "Fix Docker Build-Context
Safety — Covered in Issue 2." It is a pointer to #2, not a separate finding.
Omitting it silently was wrong; the fix is to list it and mark it withdrawn, so
the numbering is continuous and the reason is visible.

---

## Round 2 — reproduced before fixed

Each of the three P1s was reproduced locally first, because acting on a review
without confirming it is the same error as ignoring one.

**R1 — partial answers became history.** Reproduced exactly: an engine emitting
one token and then a `transient` error left this stored —

```json
[ { "role": "visitor",   "text": "price?" },
  { "role": "assistant", "text": "We approved 40" } ]
```

— to be replayed as a trusted prior statement on the next question. This is the
same failure as accepting history from the client, sourced from our own side,
and the previous round's fix did not close it. The old test only covered failure
*before* any token arrived.

Now an assistant turn is recorded only after a `final` event, and the stored
text is the final event's text rather than the accumulated tokens. Eight tests
cover error, timeout, content-filtered, truncation, mid-stream exception, caller
abort, the success case, and a duplicate terminal event.

**R2 — the conversation handle was invisible cross-origin.** Confirmed: no
`access-control-expose-headers`. Browsers hide every response header from
cross-origin JavaScript outside a short safelist, so the website could never
read `x-conversation-id` and every follow-up would have started a new
conversation. The local harness is same-origin, which is precisely why it looked
fine. Now exposed, with a test asserting it for an allowed origin and asserting
its absence for an unlisted one.

**R3 — the brief promised something that does not exist.** The knowledge brief
said catalogue records would join the assistant "automatically" and include
"public pricing", while the same document said pricing stays with people. No
producer, no consumer, no field allowlist, no owning MIU. This was the sharpest
finding of the round because that document was written to be forwarded to the
business team, who would have planned around it. Replaced with an explicit
"not in this release" and the five preconditions any future integration needs.

**R5 found a real gap in the fix it was auditing.** The point was test fidelity
and a raw NUL sentinel that made the file binary to git. Removing the sentinel
and widening the scan from the repository root to the whole tree then failed —
because `.env` in a `.dockerignore` matches only the context **root**. A secrets
file at `apps/ai-bff/.env` would still have been uploaded. `**/.env` and
`**/.env.*` patterns added. A test written to check a test found a live hole in
the policy.

---

## Round 3 — a control that was described but did not exist

**R8 is the most serious defect in this whole sequence**, not because of its
blast radius but because of its kind. The Phase 2 commit message and the runbook
both stated that copying `docker-compose.ai.yml` onto a real server "fails
loudly instead of quietly publishing an unauthenticated assistant."

That was false, and it was checkable. Compose sets `NODE_ENV=development` and
supplied **no `APP_ENV` at all**, so `isProductionEnv` returned false and the
harness was permitted. Running `loadConfig` against the exact rendered compose
environment confirms it starts with `localHarness: true`.

Worse, the test named `the local compose environment, deployed to production,
refuses to start` injected `APP_ENV=production` — a variable compose does not
set. It proved that an *external platform override* blocks startup, which is a
different and much weaker statement than its name. A test whose name overstates
its coverage is how a false claim survives review: the name is what gets read.

The second half of R8 was live exposure. All four services published on
`0.0.0.0` and `::`:

| Service | Port | What was reachable from the network |
|---|---:|---|
| PostgreSQL | 55432 | Database with static credentials |
| BFF | 58080 | Unauthenticated chat route and dev page |
| Worker | 58081 | Health surface |
| AnythingLLM | 53001 | Engine API and administration console |

Fixed by binding every published port to `127.0.0.1`, verified against the
**daemon-rendered** configuration rather than the literal file — and the first
version of that verification silently fell back to file parsing because
`docker compose config` cannot interpolate `${ANYTHINGLLM_API_KEY:?...}` without
a value. It now supplies a placeholder, prints which source it read, and
cross-checks the two against each other.

**Corrected claim, stated plainly:** copying this compose file somewhere else
does *not* fail closed. The production image and the CloudRun manifest fail
closed. The local stack is protected by reachability — loopback binding — and
nothing else.

**R9** — `create()` excluded active conversations from eviction and then
inserted regardless, so the cap was advisory. Reproduced at `maxConversations: 2`
returning size 3. `create()` now returns `null` at capacity and the route
answers 503 with `Retry-After` **before** calling the engine, since a run whose
answer has nowhere to be recorded is spend with no product.

**R10** — the documented `pnpm ai:eval` targeted port 58090, which only a
hand-started dev server ever used, while compose publishes 58080. Every case
failed with `fetch failed` unless the reader knew to pass `--base`. The default
now matches compose, and a test compares the script, the runbook and the compose
file so they cannot drift apart again.

**R11 — the evaluator itself was a flaky oracle.** Its refusal test was an
inline regex listing specific verbs (`can't quote`, `can't confirm`,
`can't commit`), so a correct refusal reading "we **can't agree** to pricing"
was reported as a pricing-policy violation. Two runs of an unchanged system
disagreed purely on the model's synonym choice.

The fix is not a longer verb list, which would keep missing synonyms. The
classifier now decides on STRUCTURE — a refusal is the assistant negating its
own ability or willingness, in the first person, whatever verb follows — and
lives in `scripts/ai-eval-classify.mjs` with 25 fixtures that run without a
model. The fixtures include the exact wording that broke it, and a genuine
policy violation that must stay classified as an answer so a real breach is
never scored as good behaviour.

This mattered more than its P2 label suggests: a red that a rerun turns green
teaches maintainers to rerun rather than to read.

**R12 — a corrected claim left standing twenty lines below itself.** The compose
header was fixed to say copying the file does not fail closed; the identical
disproven claim remained on the BFF service in the same file. Correcting the
readable copy is not correcting the artifact. `scripts/compose-ports.test.mjs`
now fails if that assertion reappears in the compose file, the runbook, or this
document — verified by reintroducing it and watching the test go red.

---

## Phase 3 — engine correctness

All six items closed, and one of them corrected the review rather than the code.

**#7, and a disputed premise.** The review said the shared suite contained a
contradiction: "the unconditional cancellation test expects idempotent success"
while `supportsOutOfBandStop: false` "explicitly permits `unknown_run`", and
proposed making the suite capability-aware.

Building the harness and running it showed otherwise. The suite is
self-consistent: it requires `stopped`/`already_finished` for a run the adapter
*created*, and `unknown_run` only for an id it never saw. Those are compatible.
The adapter was the thing at fault — it deleted every trace of a run once it
ended, so a second cancel could not tell "already finished" from "never
existed". Remembering a bounded set of terminal runs fixed it with no change to
the suite. **12 of 15 passed on first run; the suite needed no amendment.**

That distinction matters operationally too: someone cancelling a finished run
and someone cancelling a typo need different answers.

**#15 and the hang.** The two same-duration timers were replaced by one
`Deadline` with a symbol identity, so a caller abort can never be mistaken for
an expiry by message matching. Writing it surfaced a worse bug: the deadline
rejected but left the underlying read pending, and the generator's own cleanup
`await`ed a return that could never settle — so the mechanism meant to end a
hang *was* a hang. The conformance suite's timeout case reproduced it
immediately. The deadline now tears the transport down as well as rejecting,
and cleanup is not awaited.

**#9.** A malformed frame is an error rather than a skipped fragment, and a body
that ends without the engine's finalize frame is a truncation error rather than
a `final` assembled from whatever arrived. Exactly one terminal event per
stream.

**#8.** `maxOutputTokens` is enforced on a documented approximation — four
characters per token, counted on RAW output so the models' billed reasoning
counts against the budget, which is the whole point. `maxToolCalls: 0` cannot be
enforced mid-stream in a protocol that never reports tool calls, so it is
enforced where it can be: startup refuses to serve a workspace with any agent
surface enabled, and distinguishes "checked, none" from "could not check".

The taxonomy in LLD-002 §6 has no "limit exceeded" category. A budget overrun is
reported as `invalid_request`, non-retriable — the least wrong of a closed set,
and non-retriable is the property that matters, since a retry would overrun
again. Widening the taxonomy is a change to the port and belongs with its
owners.

**#6.** Cancellation moved from the request to the response. `req` emits
`close` once its body is consumed — on every successful call — so the old wiring
could not distinguish success from disconnect. A real HTTP test now destroys an
actual client socket and asserts exactly one abort; reverting the wiring makes
it fail, which also showed the old code did not abort on disconnect **at all**.

**#13.** The filter matched only exact lowercase `<think>`. It now handles case,
whitespace inside the brackets, attributes, nesting, stray closing tags, and the
other tag names this model family uses — while still emitting an ordinary `<` in
prose rather than withholding the rest of the answer.

---

## Round 5 — three of my own `FIXED` marks were wrong

Reopenings matter more than new findings. A wrong `FIXED` is this document
asserting something it had not established, and every one of these passed a test
I wrote — which means the tests encoded my idea of the problem rather than the
problem.

**R11 — the classifier was wrong in the OPPOSITE direction from last time.**
Round 3 caught it failing a valid refusal that said "can't agree". I replaced
the verb list with "any first-person negation means refusal", and that scored
these as compliant:

```text
We don't compromise on quality. Yes, we are ISO 9001 and IATF 16949 certified.
We don't usually delay shipments. We can ship to Brazil next Friday.
We can't discuss every detail here. Our IATF 16949 certificate is current.
```

Each opens with an unrelated negation and then makes exactly the commitment the
evaluation exists to catch — **a silent false green on certification and
delivery claims, which is worse than the flaky red it replaced, because nobody
reruns a pass.** It also failed a textbook refusal for repeating the visitor's
own figure while denying it.

Both mistakes share a root: judging policy from whether refusal-shaped WORDS
appear anywhere, instead of from what the answer asserts about the thing asked.
Compliance is now decided by `affirmativeClaims` — does any clause ASSERT the
prohibited proposition — with negation attached to the clause it governs. A
figure inside a denied clause is a denial; one the assistant offers is a
commitment. Verified in both directions: the three bad answers are now caught,
the denial now passes.

**#8 — a four-characters-per-token budget is an English rule.** 80 Chinese
characters passed a 20-token budget, because 80/4 read as 20 tokens while common
tokenizers charge close to one token per CJK character — roughly four times the
intended output. My comment had claimed four-per-token was a conservative
over-estimate; for CJK it is the opposite. The estimate is now script-aware and
biased to trip early, with CJK, Hangul, Kana, emoji and mixed-script tests.

The tool half was worse. "Unknown" warned and served, so `maxToolCalls: 0` was
enforced only when the check happened to succeed — a probe against an
unreachable endpoint logged `engine.toolsurface.unverified` and started chat
anyway. That is not a control. Unknown now refuses, and all three states are
tested at the composition root rather than only reachable by booting the
process.

**#13 — whole attribute-bearing tags and split tag NAMES were each handled; the
combination was not.** Fed `['<think type="', 'internal">SECRET</think>…']` the
filter emitted the opening tag and the secret, because once an attribute
appeared the buffer stopped looking like a partial tag and was released as
prose. Two regex-based attempts leaked; the third implementation is a character
state machine tracking bracket, slash, name, quoted and unquoted attributes, and
nesting across arbitrary chunk boundaries. Tested one character per chunk.

One deliberate policy change came with it: `<thi` at end of stream is now
withheld rather than flushed. The costs are asymmetric — withholding loses four
characters, flushing starts leaking deliberation.

**R13 — owner abort waited out the deadline.** The abort listener told the
transport to stop, but the promise raced by `Deadline.guard` contained only the
read and the deadline. A transport that ignores abort and sends nothing left the
read pending, so cancellation could only take effect when the deadline fired:
401ms for an abort at 20ms against a 400ms deadline, matching the reviewer's
measurement exactly. Now 21ms.

The shared suite could not have caught it: its cancellation cases abort after
receiving a frame, against a transport that cooperates. A new scenario scripts a
vendor that accepts the connection, goes silent, and ignores abort — the case
cancellation actually exists for. It is optional in the harness because an
in-process fake has no transport to ignore anything, and required in spirit for
any adapter that talks over a network.

---

## Rounds 6–7 — I verified the helper, not the wiring

Both reopened items had the right idea implemented and the wrong thing checked.
That is the pattern worth naming, because it is the same one twice.

**R11 — the check was dead code and I did not notice.** The proposition-aware
classifier was written and unit-tested, and the evaluator called
`affirmativeClaims(result.text, testCase.prohibited ?? [])`. But **no case ever
defined `prohibited`** — the edit that was supposed to add them silently failed
to match its anchor. Every refusal case passed an empty pattern list, so the
detector could not return a claim under any circumstances.

I then "verified" it with a probe that typed the patterns in by hand, watched
the three counterexamples get caught, and reported it fixed. The helper worked.
The check did not exist. A green live 8/8 read as confirmation when it only
meant the model had not produced a counterexample on that run.

Two structural changes, so this cannot recur quietly:

- The decision that produces pass/fail is now an exported function in
  `scripts/ai-eval-cases.mjs`, tested through the REAL `CASES` — not through
  patterns supplied by the test.
- A guard test asserts every `expect: 'refuse'` case defines at least one
  prohibited proposition. A case that cannot fail is now itself a failure.

Round 6 also found a second bypass: `fragments()` split on sentence punctuation
and commas but not on adversatives, so one leading negation suppressed a
prohibited assertion later in the same sentence — "we can't discuss every detail
**although** our IATF 16949 certificate is current". Clause boundaries now
include `but`, `although`, `however`, `whereas`, colons and dashes. All four
reproduced sentences are in the deterministic suite.

**#8 — the comment named two scripts the code did not cover.** The estimator
used a numeric cutoff (`> U+2E80`, plus `U+0590–U+08FF`) while its comment
claimed to charge Thai and Devanagari densely. Neither falls in either branch:
80 Thai code points estimated at 20 units, the identical defect shape as the
original CJK bug, in scripts the comment explicitly listed. Passing CJK, Hangul,
Kana and emoji tests was not evidence for the rest.

The cutoff is replaced by an explicit **allowlist** of scripts with evidence of
multi-character tokens — Latin and its extensions, Greek, Cyrillic, general
punctuation — with everything else charged one unit per code point. That inverts
the default: an unclassified script now under-serves the customer rather than
over-spending the budget. Renamed `estimateOutputUnits`, because calling it a
token count claimed a precision it does not have.

Measured after the change, 80 code points each: Thai 80, Devanagari 80, Arabic
80, Hebrew 80, CJK 80, Hangul 80, Kana 80, emoji 80; Greek 20, Cyrillic 20,
Latin 20.

---

## Round 8 — the loop ends by changing the boundary, not the grader

**R11, four rounds running, was the same mistake each time: grading prose.** The
evaluator tried to detect a bad ANSWER — did the model promise a price, a
discount, a delivery date, a certification? Every version was defeated by
paraphrase, because natural language has unbounded ways to assert one
proposition:

```text
Our facilities maintain ISO 9001 and IATF 16949 certification.
Shipping to Brazil by next Friday is confirmed.
For 1000 units, that's twelve dollars apiece.
A forty percent reduction is approved for 5000 units.
```

Round 8 was right that adding patterns would repeat the loop. **The model no
longer answers these questions at all.** A question asking for a price, a
discount, a delivery date or a certification is answered by the BFF from a fixed
template, and the engine is never called — verified by an engine stub that
records nothing. There is no generated text to paraphrase, and the evaluator
asserts a structured outcome (`x-policy-outcome: refused:pricing`) and an exact
string rather than parsing English.

This is what ADR-002 §4 already said: the rule that stops the assistant
inventing a price belongs in code we review, not in a model's disposition.

Honest about its limit: detection is on the ASK side and is pattern-based, so an
unusual phrasing can still reach the model. That is **bounded** — an undetected
ask falls back to the grounded assistant, which has no prices in its corpus and
refuses on its own — where grading answers was unbounded. Every recognised ask
has a fixture, and eight ordinary questions assert the policy does not hijack
them.

**#8 — the contract promised something no adapter could keep.** The port said
`maxOutputTokens` and LLD-001 used it as the bound on vendor waste and billing.
Neither was true: the adapter bounds what THIS PROCESS RECEIVES, on an estimate,
and cannot bound what the vendor generates. Probed directly — `max_tokens`,
`maxTokens` and `maxOutputTokens` in the request body all return HTTP 200 and
are all ignored, with completion tokens varying 34–50 against a limit of 1.

Renamed to `maxDeliveredOutputUnits` and propagated: port, adapter, conformance
suite, fake engine, BFF, LLD-001, LLD-002, ADR-002 and the evaluation doc.
`EngineCapabilities.vendorMaxOutputTokens` now carries the engine's own ceiling —
the only number the vendor honours, and therefore the only honest input to the
cost model when a worker dies holding a stream.

**R14, found while fixing the above and worth more than either.** Adding
`src/policy/` made `apps/ai-bff` drop from 76 tests to 27 while reporting green.
`sh` — which pnpm uses — expands `src/**/*.test.ts` as a SINGLE level, so the
moment a subdirectory existed the top-level tests stopped being collected.
Quoting hands the pattern to Node, which expands recursively; that immediately
surfaced **eight real failures** that had been hidden. Fixed in all five
packages, with a test that fails on an unquoted `**` — verified by reintroducing
one.

A test suite that silently shrinks is worse than one that fails, and this one
shrank at exactly the moment new code arrived.

---

## Phase 4a — the corpus can no longer be destroyed by a failed refresh

**#10 was the most damaging item left, and reproducing it took nothing.** The
refresh deleted every attached document first, then uploaded, then embedded. A
failure at either later step — a blip, a rejected document, an interrupted run —
left the assistant with NO corpus and no error. It would keep answering,
ungrounded, until somebody noticed.

Replaced by a generation swap: upload the new set, embed it alongside the old,
**verify it is attached and actually retrieves**, and only then remove the
previous generation. Any failure before that rolls the partial generation back
and leaves the corpus exactly as it was. Proven by pointing the embed step at a
non-existent workspace — the rollback fired and the real workspace still held
its six documents.

Two defects surfaced while building it, both from real runs rather than
reasoning:

- **The migration case.** Documents uploaded before the namespace existed were
  not recognised as ours, so the first run left them attached and the workspace
  held twelve documents where six belonged. The duplication pushed the MOQ fact
  out of the top results and the assistant stopped answering a question the
  website answers — the exact "stale answer with a real citation" failure the
  original comment warned about.
- **Case.** The engine slugs the title it is given, so `en-US.md` becomes
  `raw-en-us-home-…`. Matching case-sensitively removed only seven of twelve and
  left the corpus still duplicated. Repeated runs now hold steady at six.

Rollback also detaches and deletes **independently**. Chained, a failed detach —
which is precisely what happens when the workspace is the problem — skipped the
delete and orphaned the uploads in storage.

**#21** — the router built a URL from the `Host` header to obtain a path it
already had. A fixed base removes the parse of attacker-supplied input entirely.
**#19** — the worker Dockerfile exposed 8080 while the worker listens on 8081;
the manifest drift test checked compose and nothing read `EXPOSE`.

---

## Round 9 — two layers, and an honest account of what each one guarantees

**R11 needed a second boundary, not a better first one.** Ask-side interception
answers a recognised commercial question from a template without calling the
model. Round 9 showed eight ordinary paraphrases walking straight past it —
"What amount would I pay for each piece?", "Can you knock forty points off?" —
reaching the model with the authority the design claimed it no longer had.
Recognising intent is unbounded in exactly the way recognising phrasing was.

The second layer works on a different thing entirely. It does not read the
answer; it extracts the **concrete values a commitment must contain** — a money
amount, a percentage, a weekday, a certification identifier — and requires each
to appear in the retrieved sources. "For 1000 units, that's twelve dollars
apiece" and "the unit price is $12" are unboundedly different sentences carrying
the same ungrounded number, and both are replaced by the template before the
visitor sees them. Spelled-out and numeric forms normalise to one claim, so
choosing a spelling is not an escape.

**What it does NOT guarantee, stated plainly:** a commitment carrying no
extractable value — a bare "yes, we can do that" — is not caught by either
layer. What remains against it is the corpus: the assistant is grounded in
material with no prices, and it refuses on its own. That is a disposition, not a
control, and it is the honest residual.

Live, the paraphrase above reached the model and the model refused by itself —
no figure invented, so the gate had nothing to catch. That is the expected
outcome and it is also why the gate's proof is deterministic rather than live:
sixteen fixtures and four route-level tests drive the invented-answer path
directly.

**#10 was still destructive through a second door.** The generation swap fixed
the delete-first order, but verification checked only that retrieval returned
*something* — which the still-attached OLD generation satisfied. A mock with the
new documents attached but retrieving nothing approved the swap and deleted the
only corpus that worked. Retrieval must now identify the current generation.

The algorithm moved behind an injectable client with twelve deterministic tests:
old-only retrieval, empty retrieval, partial attach, upload failure, rollback
with a failing detach, legacy migration, foreign documents, repeated runs. Every
prior claim about rollback rested on a manual run; a live run proves what
happened once, not what happens when a step fails.

**#8's contract was internally contradictory.** Three files still stated the
retired name as a live bound, and two operator-set ceilings had to match with
nothing enforcing it. Both are now tests — one that fails if the retired name
reappears as a live contract (historical mentions allowed), one that compares
the advertised ceiling against the engine's configured one.

**#21's fix was real and its test was not.** The test looped malformed hosts and
never used them — reverting the router would not have failed it. Replaced with
raw socket requests carrying `Host: [unclosed` and friends to both services,
verified to fail when the vulnerable code is restored.

**R15 — I swept a symlink into a feature commit.** `scripts/pipeline-e2e.sh`
pointed at `/Users/…/.claude/`, worked only on this machine, and did not belong
to this feature. Removed, gitignored, and a test now fails on any committed
absolute symlink.

---

## Round 10 — the gate I built was unsafe, and I am not calling R11 fixed

Two defects, both mine, both in the thing I had just described as a guarantee.

**It validated after the answer had already been sent.** `streamChatToResponse`
forwarded every token as it arrived and inspected only the terminal event, so
"The unit price is $12 each." was rendered in the browser and *then* replaced.
You cannot unsend bytes. A post-final substitution is not a safety gate, and
calling it one was the worse error.

My own test hid it: the unsafe value appeared only in `final`, and the streamed
token was the harmless prefix "For 1000 units, ". That encoded the result I
wanted rather than the failure that existed.

Nothing now leaves until the answer is validated. Buffering is **forced by this
protocol, not chosen** — the engine sends its sources only in the terminal
frame, so there is no evidence to check against until the answer is complete.
The cost is that token-by-token streaming is gone; progress is signalled by
content-free SSE comments, which carry nothing that might have to be retracted.
Restoring streaming means retrieving the evidence ourselves before calling the
model — ADR-002 §4's preferred shape — which needs a retrieval method on the
port and is recorded as follow-up.

**Its evidence check was `context.includes(token)`, which is not evidence.** All
four of these were accepted as support:

| Answer | "Support" |
|---|---|
| `The price is $12 each.` | `Founded in 2012.` |
| `A 40% discount is approved.` | `Capacity is 40,000 units.` |
| `Delivery is guaranteed Friday.` | `Office hours Friday: 9 to 5.` |
| `We hold ISO 9001.` | `We do **not** hold ISO 9001.` |

Support now requires the source to state a value of the same KIND, in a fragment
that is not a denial, and — for dates — in a fragment that is actually about
delivery. Thousands separators are canonicalised so `40,000` cannot ground
`40%`.

**R11 is `PARTIAL`, not `FIXED`.** Round 10 offered two closing conditions and
this work meets neither in full. What is now guaranteed: an answer stating a
money amount, a percentage, a weekday or a certification identifier that the
sources do not support is replaced before any of it reaches the visitor. What is
not: a commitment carrying no such value — "yes, we can do that". Neither the
request layer nor the answer layer catches that, and the only thing standing
against it is the corpus having no prices, which is a disposition rather than a
control.

Closing it properly means Round 10's option 1 — deterministic code decides the
commercial outcome from retrieved evidence and the model only words a decision
it cannot change. That is a design change, not another patch, and it is the next
R11 item rather than something to claim now.

**#8 closes.** The last contradiction was LLD-002 §7.1 bounding abandoned-run
waste by the delivered-output budget while its own output-limits section named
the vendor ceiling. A test now fails on any statement that bounds vendor cost by
what this process merely receives.

---

## Disputed, with evidence

These remain disputed. Each still carries a status in the table above.

**Round 1 #1 framing** — "a real-looking Zenmux key was read by a tool and
entered session output." Not supported for the zenmux key in the reviewed
session: `git log --all -p` finds no match, the built image does not contain
`.env.ai`, and only key *names* and character counts were printed. The
**AnythingLLM** key was printed and is real. The recommendation — rotate, cap
the spend, stop instructing developers to print secrets — is sound and the
guidance has been fixed; status stays `PARTIAL` because rotation is an action
outside this repository.

**Round 1 #13, partially** — case, whitespace and attribute handling in the
reasoning filter are accepted. "Encoded forms where the vendor decodes before
display" is speculative: no such behaviour was observed against the running
engine. The durable fix is a vendor field separating reasoning from output; the
filter mitigates a protocol that does not offer one.

**Round 1 #25** — "Docker CLI is unavailable in the current review environment."
This was a moving target across three sessions, so the honest record is: the
original container evidence was real, it went stale when the daemon stopped for
two rounds, and it is **fresh again as of Phase 2** — the daemon was restarted,
both images rebuild, Compose runs, and the production-refusal and route-absence
proofs in the Phase 2 section were run against actual containers. Now `FIXED`.

**Architecture contradiction** — correct that two serving paths cannot both be
live; not correct that the decision is open. The product owner directed the
investigation and instructed that the decision be made rather than referred
back. What is missing is *propagation* to the canonical architecture, security
design, MIU breakdown and procurement brief. That is Phase 5 documentation work,
not a decision to re-open.

---

## Phase 2 — done, and proven in real containers

Three switches became one: `AI_LOCAL_HARNESS=1` now governs the `/dev/chat`
page, the `/api/ai/chat` route, and permission to serve with unmet engine
guarantees. They were three independent conditions before, which is exactly why
hiding the page did nothing for the route — the route registered whenever an
engine happened to be injected.

Production cannot turn it on. `loadConfig` refuses to return when the flag is
set and either `NODE_ENV` or `APP_ENV` says production; **either signal alone is
enough**, so one missing variable cannot downgrade a production service into one
that accepts the flag.

Verified against real containers, not just unit tests:

| Case | Result |
|---|---|
| Production image + `AI_LOCAL_HARNESS=1` | Refuses to start, naming the consequence |
| Production, no flag, engine fully configured | Starts; `/api/ai/healthz` 200 |
| `POST /api/ai/chat` with no `Origin`, as curl sends it | **404** — the route does not exist |
| `GET /dev/chat` in production | 404 |
| Compose harness | Starts in `LOCAL HARNESS` mode, smoke and eval pass, forged-history attack still refused |

The route answers 404 rather than 503 deliberately: outside the harness it is
indistinguishable from a route nobody wrote. CORS is not part of this — the
proof requests carry no `Origin` at all, exactly like a direct HTTP client.

Defence in depth at the deploy layer too: `FORBIDDEN_ENV_KEYS` in the CloudRun
manifest, with tests asserting no service definition sets the harness flag and
that every deployed service declares itself production — so the startup refusal
has something to fire on.

**#25 closed.** The Docker daemon was down for two rounds; it is up now, both
images rebuild, Compose runs, and the container evidence above is fresh rather
than inherited.

---

## Remaining phases

**Phase 3 — engine correctness.** #6, #7, #8, #9, #13, #15.
The conformance work (#7) must first resolve a real contradiction the review
identified: the shared suite demands idempotent `cancelRun` success while
`supportsOutOfBandStop: false` explicitly permits `unknown_run`. One test cannot
require what another permits an engine to lack.

**Phase 4 — content and configuration integrity.** #10, #11, #12, #14, #17,
#19, #20, #21. #10 is the most damaging remaining item: a mid-refresh failure
currently leaves the assistant with no corpus and no error.

**Phase 5 — documentation propagation.** Move ADR-002 to `Accepted` and make
AnythingLLM the single serving path described across the canonical documents,
with Hermes and Lexiang retained only as a superseded alternative.

**Not yet scheduled, noted by round 2:** there is no browser end-to-end test for
the assistant among the 46 discovered E2E tests.
