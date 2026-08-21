# External review triage — AI assistant local phase

Two review rounds by Codex 5.6. Every finding appears **exactly once** in the
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

---

## Canonical table — 32 findings

| # | Finding | Status | Phase |
|---|---|---|---|
| 1 | Exposed key handling and secret-printing guidance | `PARTIAL` | done / see note |
| 2 | No root `.dockerignore` | `FIXED` | 1 |
| 3 | Unsafe engine bypass works regardless of `NODE_ENV` | `FIXED` | 2 |
| 4 | `/api/ai/chat` registers whenever an engine is injected | `FIXED` | 2 |
| 5 | Client-supplied assistant history | `FIXED` | 1 |
| 6 | Cancellation bound to `req.close`, not the response socket | `PHASE_3` | 3 |
| 7 | Adapter does not run the shared conformance suite | `PHASE_3` | 3 |
| 8 | `maxOutputTokens` / `maxToolCalls` declared but unenforced | `PHASE_3` | 3 |
| 9 | Corrupt or truncated SSE treated as success | `PHASE_3` | 3 |
| 10 | Corpus refresh deletes before it uploads | `PHASE_4` | 4 |
| 11 | Workspace policy applied without read-back | `PHASE_4` | 4 |
| 12 | Readiness ignores the engine; version defaults to `unpinned` | `PHASE_4` | 4 |
| 13 | Reasoning filter is case-sensitive and tag-exact | `PHASE_3` | 3 |
| 14 | Citation URLs relative and unvalidated | `PHASE_4` | 4 |
| 15 | Two timers for one deadline | `PHASE_3` | 3 |
| 16 | Ordinary CI job runs database tests without a database | `FIXED` | 1 |
| 17 | `mintplexlabs/anythingllm:latest` is a mutable tag | `PHASE_4` | 4 |
| 18 | Docker build-context safety | `WITHDRAWN` | — |
| 19 | Worker `EXPOSE 8080` vs actual 8081 | `PHASE_4` | 4 |
| 20 | Shutdown does not drain | `PHASE_4` | 4 |
| 21 | Routing URL built from the `Host` header | `PHASE_4` | 4 |
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

### Totals, computed from the table

| Status | Count | IDs |
|---|---|---|
| `FIXED` | 13 | 2, 3, 4, 5, 16, 25, R1, R2, R3, R4, R5, R6, R7 |
| `PARTIAL` | 1 | 1 |
| `WITHDRAWN` | 1 | 18 |
| `PHASE_3` | 6 | 6, 7, 8, 9, 13, 15 |
| `PHASE_4` | 8 | 10, 11, 12, 14, 17, 19, 20, 21 |
| `GATE_PENDING` | 3 | 22, 23, 24 |
| **Total** | **32** | 25 from round 1 + 7 from round 2 |

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
