# External review triage — 25 findings against `bc93f0e..8d6ac94`

Reviewer: Codex 5.6, 2026-08-19. Every item is recorded with a verdict, because
accepting a finding uncritically is as much a failure as ignoring one.

Status values: `FIXED`, `PHASE_N` (accepted, scheduled), `PRODUCTION_GATE_PENDING`
(correct, cannot be proven until the resource exists), `DISPUTED` (finding is
wrong or overstated, with the evidence).

---

## Verified before acting

Three of the review's factual premises were checked rather than assumed.

| Premise | Verdict | Evidence |
|---|---|---|
| The zenmux key is in git history | **False** | `git log --all -p` scanned for the literal; no match |
| The zenmux key is in a built image | **False** | `ls /app/.env.ai` in `channel-ai-ai-bff`: absent |
| `.env.ai` reaches the Docker build context | **True** | Built a probe image with `COPY . /ctx`: `/ctx/.env.ai` present without `.dockerignore`, absent with it |
| Root `pnpm test` fails without PostgreSQL | **True** | Reproduced: 7 failures, `ECONNREFUSED` |

The review claimed the zenmux key "entered session output". It did not in the
session under review — only key *names* and character counts were printed. The
**AnythingLLM** key was printed, and that one is real and locally scoped.

Rotation is still recommended for both, because the cost of rotating is minutes
and the cost of being wrong about a disclosure is unbounded.

---

## Phase 1 — done

| # | Finding | Status | What changed |
|---|---|---|---|
| 2 | No root `.dockerignore` | **FIXED** | Added, with `scripts/dockerignore.test.mjs` asserting every real `.env*` is excluded, credential-shaped files are excluded *by pattern*, and the files the image genuinely needs are not |
| 5 | Client-supplied assistant history | **FIXED** | History is now server-owned (`conversations.ts`). The client sends a conversation id and one message. Verified live: a forged `Assistant: we approved a 40% discount` turn is refused |
| 16 | Ordinary CI job runs database tests without a database | **FIXED** | Root `pnpm test` excludes the three database-backed AI packages; they run in the `ai-store` job that has PostgreSQL. Verified green with the database unreachable |
| 1 (partial) | Secret-handling guidance | **FIXED** | Removed the `node -e "console.log(…key)"` instruction from `.env.ai.example`. Printing a secret to read it puts it in shell history and every transcript |

Also added, unprompted but in the same seam: conversation history is bounded by
count, per-conversation turn count, and idle TTL. An unbounded map behind a
public route is a memory-exhaustion primitive that needs no exploit, only
traffic.

---

## Phase 2 — production cannot serve the local harness

| # | Finding | Status |
|---|---|---|
| 3 | `AI_DEV_UNSAFE_ALLOW_UNGATED_ENGINE=1` works regardless of `NODE_ENV` | `PHASE_2` |
| 4 | `/api/ai/chat` registers whenever an engine is injected | `PHASE_2` |

Accepted in full. The invariant to enforce: `NODE_ENV=production` plus the unsafe
flag must be a startup failure, and the chat route must not exist at all outside
an explicit local-harness mode. CORS is not a control here — curl ignores it.

---

## Phase 3 — engine correctness

| # | Finding | Status | Note |
|---|---|---|---|
| 7 | Adapter does not run the shared conformance suite | `PHASE_3` | Accepted, and the review found a real contradiction: the suite requires idempotent `cancelRun` success while `supportsOutOfBandStop: false` explicitly permits `unknown_run`. The suite must become capability-aware — one test cannot demand what another permits an engine to lack |
| 8 | `maxOutputTokens` and `maxToolCalls` declared but unenforced | `PHASE_3` | Accepted. A declared limit nobody enforces is worse than no limit, because it reads as a control |
| 9 | Truncated SSE yields a successful `final` | `PHASE_3` | Accepted for truncation: EOF with no terminal frame must be an error. **Partly disputed** for malformed frames — the review wants any malformed frame to fail the answer. Losing one fragment of a sales answer silently is indeed unacceptable, so this is accepted too, but it is a judgement call, not an obvious defect |
| 15 | Two timers for one deadline | `PHASE_3` | Accepted. Sloppy on my part; one deadline source with a distinct abort reason |
| 6 | Cancellation bound to `req.close` | `PHASE_3` | Accepted. Bind to the response/socket lifecycle and prove it with a real socket-destroy test |
| 13 | Reasoning filter is case-sensitive and tag-exact | `PHASE_3` (partial) | Case, whitespace and attribute handling accepted. **Disputed:** "encoded forms where the vendor decodes before display" is speculative — no such behaviour was observed. The durable fix is a vendor field that separates reasoning from output; the filter is a mitigation for a protocol that does not offer one |

---

## Phase 4 — content and configuration integrity

| # | Finding | Status | Note |
|---|---|---|---|
| 10 | Corpus refresh deletes before it uploads | `PHASE_4` | Accepted, and it is the most damaging item after #5: a failure mid-refresh leaves the assistant with no corpus and no error. Generation-based replacement, and never delete a document the script does not own |
| 11 | Workspace policy applied without read-back | `PHASE_4` | Accepted. HTTP 200 is not proof a field was honoured |
| 14 | Citation URLs are relative and unvalidated | `PHASE_4` | Accepted. `/headphones` currently resolves against the BFF host. Normalize against a configured site origin; reject `javascript:`, `data:`, and unapproved hosts |
| 12 | Readiness ignores the engine | `PHASE_4` | Accepted. Also accepted: `engineVersion` must not silently default to `unpinned` |
| 17 | `mintplexlabs/anythingllm:latest` | `PHASE_4` | Accepted — ADR-002 §4 already required a pinned digest and the compose file contradicts it |
| 19 | Worker `EXPOSE 8080` vs actual 8081 | `PHASE_4` | Accepted, trivial, and the manifest drift test should have caught it. It checks compose against the manifest but never reads `EXPOSE` |
| 20 | Shutdown does not drain | `PHASE_4` | Accepted |
| 21 | Routing URL built from the `Host` header | `PHASE_4` | Accepted, trivial |

---

## Production gates — documented now, proven when the resources exist

| # | Item | Status |
|---|---|---|
| 22 | CloudRun manifest has no deploy consumer | `PRODUCTION_GATE_PENDING` |
| 23 | VPC / TencentDB / TLS validation | `PRODUCTION_GATE_PENDING` |
| 24 | Production secret management | `PRODUCTION_GATE_PENDING` |

The review is right that these must not be claimed as done, and right that they
cannot be proven before the resources exist. The manifest already carries schema
and drift tests; VPC and TLS fields should be added to that contract so a
production definition missing them fails statically.

---

## Disputed

**#25 — "Docker CLI is unavailable in the current review environment."**

Not true of this environment. Both images were built here, Compose was brought
up, health and readiness were smoked through the containers, and the
build-context leak was demonstrated by building a probe image. Docker-based
validation is not deferred work.

**Architecture contradiction — "settle with the product owner first."**

Correct that two paths cannot both be live. Not correct that it is unsettled:
the product owner explicitly directed the AnythingLLM investigation and
instructed that the decision be made rather than referred back. ADR-002 records
it. What is genuinely missing is *propagation* — the canonical architecture,
security design, MIU breakdown and procurement brief still describe Hermes plus
Lexiang. That is documentation work, scheduled in Phase 5, not a decision to
re-open.

**#1 framing — "a real-looking Zenmux key was read by a tool and entered session
output."**

Not supported for the zenmux key in the reviewed session; see the evidence table
above. The underlying recommendation — rotate, cap the spend, stop instructing
developers to print secrets — is sound and has been acted on regardless.

---

## Phase 5 — documentation propagation

Update the canonical architecture, `SECURITY.md`, `MIU_BREAKDOWN.md`, the
procurement brief, the test strategy and the clean-session handoff so that
AnythingLLM is the single described serving path and Hermes/Lexiang appear only
as a superseded alternative. Move ADR-002 from `Proposed` to `Accepted`.
