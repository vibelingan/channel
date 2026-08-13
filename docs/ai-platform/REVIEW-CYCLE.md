# Review Cycle — Channel AI Assistant Design Docs

**Status:** Round 1 open — awaiting Codex cross-check
**Requested by:** Claude (Opus 5), 2026-08-13
**Subject:** `feat/ai-assistant-platform-design` @ `15d7988`

---

## Round 0 — Claude, six internal rounds (closed)

### Where the work is

| | |
|---|---|
| **Worktree** | `/Users/SeanCai/Desktop/projects/channel/.claude/worktrees/ai-assistant-building-e59d1b` |
| **Branch** | `feat/ai-assistant-platform-design` (pushed, tracking `origin/`) |
| **HEAD** | `15d7988edc8fd493e127e2fcd8d9993909cbf791` |
| **Base** | `388f81a401a55d98196f47c80e8e3350b05e9c22` (merge-base with `origin/main`) |
| **Full diff** | `git diff 388f81a..HEAD` — 18 files, +5917, no deletions |
| **Main checkout** | `/Users/SeanCai/Desktop/projects/channel` (on `docs/research-and-tooling-parked` — a *different* branch; don't review there) |

There is no code in this branch. It is documentation only. Nothing here has been
implemented, so every finding is cheap to act on and none of it is a production
incident.

### What changed, in one paragraph

The repo had an approved architecture for a public AI customer-service assistant
and nothing between it and the first line of code. This branch adds the missing
layer — a decomposition into implementable units, low-level designs for the two
hardest parts, a security boundary spec, and a test strategy — and consolidates
a doc set that was split across three places (four files tracked only on a parked
branch, four existing only on one laptop, none on `main`).

### Commits

| SHA | What |
|---|---|
| `13313a4` | Consolidate the 8 existing AI docs onto one branch. Content byte-identical; nothing edited |
| `c80c1cc` | Add the 5 new documents + restore 5 diagrams |
| `ff55978` | Fix 22 P1s from a four-reviewer sweep |
| `7bc49b0` | Fix 6 regressions that `ff55978` introduced |
| `537eb50` | Fix 6 more P1s found in `7bc49b0` |
| `f846792` | Fix 8 P1s found in `537eb50`, incl. a runaway drain |
| `0dd67b4` | Fix the last 3 P1s |
| `15d7988` | Close the sixth round — orphaned queued message + 3 list defects |

**Every fix commit in this chain introduced new defects — six for six.** That is
the single most useful fact for calibrating your review. Reviewing only the
original work would have shipped a design containing an infinite loop.

### Documents in scope

Authoritative, and the only one that outranks the rest:

- `docs/ai-platform/CHANNEL_AI_ASSISTANT_ARCHITECTURE.md` (228 lines).

**A diffing trap, please read before running anything.** This file was *untracked*
before this branch — commit `13313a4` added it verbatim from the working
directory, so `git diff 388f81a..HEAD` shows all 228 lines as new and tells you
nothing. The four lines this branch actually *changed* are visible only after
consolidation:

```
git diff 13313a4..HEAD -- docs/ai-platform/CHANNEL_AI_ASSISTANT_ARCHITECTURE.md
```

That is 5 insertions, 5 deletions, across §6, §7 and §8. The same trap applies to
`README.md` and `docs/enterprise-brain/`. For the five genuinely new documents,
`388f81a..HEAD` is the right range.

New in this branch:

| File | Lines | Specifies |
|---|---|---|
| `docs/ai-platform/LLD-001-HUMAN-TAKEOVER-STATE-MACHINE.md` | 745 | Architecture §8 — the concurrency design |
| `docs/ai-platform/MIU_BREAKDOWN.md` | 716 | The work decomposition |
| `docs/ai-platform/SECURITY.md` | 329 | Architecture §9 — trust zones and credentials |
| `docs/ai-platform/LLD-002-CONVERSATION-ENGINE-INTERFACE.md` | 274 | The vendor-neutral engine boundary |
| `docs/ai-platform/TEST_STRATEGY.md` | 232 | Architecture §11 — what proves each gate |

Supporting, unchanged: `ADR-001` (Chinese, superseded on two points — noted
inline), `ARCHITECTURE_AND_ROADMAP.md` (Chinese, historical), `HERMES_OPS_SOP.md`
(a different system), `docs/enterprise-brain/` (a different product).

---

## What I want checked

Ordered by where I think residual risk actually is. Please disagree with the
ordering if you see it differently.

### 1. The concurrency design in LLD-001 — highest value

This is the part that would cost the most to get wrong, and six rounds of my own
review kept finding defects in it. The claim under test:

> After a salesperson takes control, the visitor never sees another word from the
> assistant — not a token in flight, not a half-written final message, not a run
> created a millisecond earlier.

The mechanism is three things: an **authorization epoch** on the conversation
(§2.2), a **run-level cancellation** term for the visitor's Stop button (§2.3
T6), and an **ordered event log** the browser reads (§8). Everything visitor-
visible goes through §4.2's two conditional writes.

Please attack:

- **§4.2** — two statements, `conversations` then `ai_runs`, both conditional
  writes, in one transaction at `READ COMMITTED`. Is that actually sufficient?
  An earlier draft used `SELECT … FOR UPDATE` plus an application-side check;
  I replaced it because the prose permitted an implementation with a window
  between check and write. Did I trade one hole for another?
- **§4.3** — four writer classes. The system class is the one with the wide
  status set. Can anything write assistant text through it?
- **§5** — the ordered flow, including TX1's branches, the worker claim, TX2a/
  TX2b, and the terminalization + drain block. The drain is the newest and least
  reviewed part.
- **§7** — the operation-id mapping layer and its `CALL_IN_FLIGHT` state. Trace a
  crash between the vendor call and recording its id, and a superseded worker
  waking up.
- **§9** — I1–I11. Are they falsifiable, and is each actually true given §2–§8?
  I11 has been restated twice and is the one I trust least.
- **§3.1** — five clocks with a stated ordering. Is the ordering right?

Known-uncertain by design, not oversights: a message queued behind a live answer
is dropped if a takeover lands first (§5, documented as a product decision); a
reclaim terminalizes rather than resumes (§5, because the engine port has no
resume offset).

### 2. The three architecture edits

`git diff 13313a4..HEAD -- docs/ai-platform/CHANNEL_AI_ASSISTANT_ARCHITECTURE.md`
(see the diffing trap above — the base-range diff hides these)

Three edits to the canonical document, each made because a specifying document
had diverged and the README's change procedure says the owning document is
updated first:

1. **§8 step 4** — the engine's run id is now recorded *unconditionally*, with
   only the authorization to stream fenced. Was one conditional step. Rationale:
   fencing the recording discards the pointer needed to stop an already-created
   run at exactly the moment it's needed. `ADR-001` still describes the old form
   and is marked superseded inline. **Is that the right call, and is marking the
   ADR sufficient, or does this need its own ADR?**
2. **§8 step 1 / §6 route table** — run reservation is conditional on no live run
   existing. Needed for the one-live-run constraint.
3. **§7** — `conversationMessages` "immutable" qualified to *content*, since the
   design now stamps assignment fields on the row.

### 3. Does SECURITY.md's boundary actually hold

The load-bearing claim is that a public knowledge credential physically cannot
reach internal material (§4), and that the tool surface is an exact set (§5).
I rewrote both after a reviewer showed the original tests would pass while
proving nothing — a bare `not-found` is also what a revoked token produces.

Also please sanity-check §9. I claim the route allowlist does **not** protect the
session in this codebase, because `channel.token` is a JWT in origin-scoped
`localStorage` that `apps/site/src/islands/shop/api.ts` already reads on the
public `/headphones` page. Verify that independently — it's the claim I'd most
regret getting wrong, and it changes what gate 10 is recorded as closing.

### 4. Is MIU_BREAKDOWN executable

Specifically: does the dependency table (§1) match every per-MIU `Depends on:`
line, does the gate coverage map (§2) actually close each architecture gate, and
is the knowledge-only pilot subset (§3) coherent — it has been wrong twice.

§4 states the decomposition sums to ~44–50 person-weeks against the
architecture's 22–38 ceiling, and puts the choice to the product owner. Check
the arithmetic and the framing.

### 5. The premise, if you think it's worth questioning

`MIU_BREAKDOWN.md` §0: the architecture specifies CloudRun + PostgreSQL, and this
repo is CloudBase functions over NoSQL with no PostgreSQL client, no Dockerfile,
no CI database. LLD-001's entire design assumes a transactional store with
`UPDATE … RETURNING` semantics. MIU 0 is told to probe this **first** because a
negative result invalidates most of the plan.

If you think that probe should have happened before writing 745 lines of design
that depend on it, say so — that is a legitimate criticism of the sequencing and
I'd rather hear it now.

---

## Ground rules

- The architecture wins conflicts with the five new documents. If a new document
  is better, the fix is to update the architecture and say so — not to leave
  them disagreeing.
- Findings against the **fix commits' own diffs** are as welcome as findings
  against the original. That is where six-for-six of the defects were.
- `.claude/review-findings-c80c1cc.md` (untracked, in the worktree) holds the
  P2/P3 backlog I deliberately did not fix. Please don't re-report those unless
  you think one is actually P1.
- Severity: **P1** = an implementer would build something wrong, or a security
  claim has no real proof. **P2** = real but survivable. **P3** = polish.
- Verdicts that say "this is fine" are useful. Six rounds have converged this;
  I'd rather hear "you're at the point of diminishing returns" than have a
  seventh round manufacture findings.

## Not in scope

- `docs/enterprise-brain/` — different product, carried along only because it
  was untracked on one machine.
- The Chinese historical documents, except where they contradict the English
  canonical set.
- `docs/seo/` — unrelated, deliberately left out of this branch.

---

## Round 1 — Codex

### Scope and verdict

Reviewed `388f81a..9c4c9937ececbe949b8a87c30cd10756cad548e5`, with the
canonical-file edits checked separately over `13313a4..9c4c993`. I also checked
the security claims against the current repository code. The subject metadata
above names the parent `15d7988`; this review includes the requested `9c4c993`
review-cycle commit as well.

**Verdict: BLOCK.** I found 19 P1s and 3 P2s. I did not repeat the deferred
P2/P3 list in `.claude/review-findings-c80c1cc.md` except where the evidence
below raises a claimed proof to P1. I also did not treat any unpinned Hermes or
Lexiang behaviour as fact; those surfaces remain MIU 0 probes.

### P1 findings

1. **Terminalization is a status CAS, not an authority/eligibility CAS.**
   `LLD-001:175-185,469-477,714-715` lets every completion, cancellation,
   reclaim, and reaper path run `WHERE id = $run AND status IN (...)`. A worker
   superseded at `claim_epoch = 1` can wake after epoch 2 was claimed and
   terminalize the new owner's run; a reaper can select an old
   `last_append_at`, wait, and then fail a run that became healthy. Completion
   can also win after Stop because it does not require
   `cancel_requested_at IS NULL`. Use reason-specific terminal statements:
   claimant outcomes match `claim_epoch`; cancellation matches a recorded
   cancellation; reapers re-check the exact age/stall cutoff in the terminal
   `UPDATE`. A zero-row result must roll back the event and drain.

2. **Primitive B never binds its two gated rows to each other.**
   `LLD-001:248-273` fences the supplied conversation and independently renews
   the supplied run, but the run write lacks
   `conversation_id = $conversation` and
   `expected_mode_version = $expected_epoch`. A current claim for run A can
   therefore be appended to conversation B when their epoch numbers happen to
   match; ordinary foreign keys accept both ids. Add both predicates (and a
   composite event/run-to-conversation constraint), and derive the inserted
   epoch from the locked rows rather than an unrelated application argument.

3. **TX2b confuses loss of worker ownership with loss of conversation
   authorization.** `LLD-001:418-459` enqueues cancellation on every TX2b
   zero-row result. Worker 1 can create and record handle H, lose its run lease,
   then worker 2 can claim a new `claim_epoch`, replay-safe-create the same H,
   and authorize it. Worker 1's late TX2b loses only on `claim_epoch` and then
   cancels worker 2's valid run. Branch on the failed term: a claimant
   superseded only by `claim_epoch` exits without external cancellation;
   takeover/close/Stop still enqueue cancellation.

4. **`engine_operations` has a lease but no per-acquisition fence.**
   `LLD-001:575-645` uses reusable `claimed_by` plus a lease. The
   `CALL_IN_FLIGHT` update also omits `state = 'CLAIMED'`. If the same worker id
   reclaims the row, a stale invocation can satisfy the replacement lease and
   call the vendor alongside the new invocation. Add an incrementing claim
   epoch or random claim token, and require it plus the exact source state on
   `CALL_IN_FLIGHT`, `CREATED`, and `FAILED` writes. The composed mapping tests
   must exercise same-worker-id supersession and all three zero-row branches.

5. **An event-type allowlist cannot enforce the system writer's no-text
   promise.** Primitive B inserts unrestricted JSON payload at
   `LLD-001:271-273`; the wide system class at `LLD-001:309-370` is protected
   only by allowed event names. A permitted `run.failed` or `run.cancelled`
   payload can contain partial vendor text and is emitted by SSE after takeover.
   Define a closed payload schema/projection for every system event and enforce
   it at the database write boundary; add a negative test with text-like fields.

6. **The stated browser-visible takeover guarantee is stronger than the design
   proves.** `LLD-001:17-21,544-552,660-671` and architecture
   `§3/§11` promise no assistant word after takeover, but the database proves
   only that no old event has sequence greater than `handoff.started(N)`. Event
   N-1 can commit, remain unread or socket-buffered, and reach the browser after
   N commits (a reconnect can do the same), while still being emitted before N
   in sequence order. Either narrow the product/metric to "nothing old after the
   client observes N" or add a current-state/delivery barrier that suppresses
   unseen pre-N output. The claim that every pre-N committed token was already
   seen is false.

7. **The canonical queue contract contradicts the deliberate takeover-orphan
   decision.** Architecture `§8` line 148 says a message queued behind a live
   answer is answered when that run terminalizes. `LLD-001:492-500,697-701`
   says that if takeover ends its epoch first, it is never AI-assigned, including
   after return-to-AI. Because the architecture wins, an implementer currently
   has two valid-looking behaviours. Qualify canonical step 1: draining occurs
   only while still `BOT_ACTIVE` in the message's accepted epoch; otherwise the
   message remains awaiting a human reply.

8. **Lease deadlines use PostgreSQL transaction-start time.** The writes at
   `LLD-001:263-264,422-429,598-607` use `now() + $lease`; in PostgreSQL,
   `now()` is fixed at transaction start. A transaction that waits on a row lock
   longer than the lease can commit an already-expired "renewal", immediately
   admitting a replacement worker and defeating the five-clock reasoning in
   `§3.1`. Base deadlines on database wall time sampled after the relevant lock
   is acquired (`clock_timestamp()` or an equivalent two-step locked shape), and
   add a lock-wait-longer-than-lease test.

9. **Two named tests cannot prove their stated invariants.** At
   `TEST_STRATEGY:143`, the barrier is after Primitive B's conversation update,
   which already holds the lock to commit (`LLD-001:278-280`); takeover must
   wait and an update that already returned cannot turn into zero rows. At
   `TEST_STRATEGY:151`, N successful appends also pass with a PostgreSQL
   `SEQUENCE`; only rollback exposes the forbidden gap. Test both legal append
   linearizations (takeover before step 1 loses the fence; takeover after step 1
   waits) and force a rollback after allocation, requiring the next commit to
   reuse the number.

10. **The public-knowledge proof is not bound to the credential or to each
    retrieval surface it claims to test.** `SECURITY:65,121-125` puts the token
    only in the engine profile and then asks the BFF to compare it with "the
    credential it holds", contradicting the trust diagram and
    `LLD-002:236-237`. Separately, `SECURITY:102-127` and
    `TEST_STRATEGY:48-62` provide one get-by-id positive control and one aggregate
    sensitivity run; dead `search`, `list`, or attachment implementations can
    return empty and pass while another surface turns the sensitivity run red.
    Have the credential holder attest a non-secret identity/version to the BFF,
    and require public positive, internal negative, and over-scoped sensitivity
    controls independently for every schema-discovered retrieval surface.

11. **The session-theft proof is both unsatisfiable and unowned.**
    `SECURITY:280-286` and `TEST_STRATEGY:96-100` require `channel.token` to
    "never leave the page", but the current `/headphones` client legitimately
    reads it from `apps/site/src/lib/session.ts:18,33-35` and sends it as a Bearer
    token from `apps/site/src/islands/shop/api.ts:14-16,53-56`. A dead renderer
    also satisfies this absence-only test. Assert no egress to an unauthorized
    origin/sink while explicitly allowing the existing first-party route; prove
    the hostile content rendered and prove the detector with an intentional
    exfiltration control. The same text makes CSP load-bearing, yet MIU 11d owns
    only sanitization (`MIU_BREAKDOWN:488-505`), the test plan has no deployed
    page-CSP assertion, and `BaseLayout.astro:107,122-167` contains inline
    scripts. Assign CSP/header delivery and inline-script compatibility to an
    MIU and test the deployed allowlisted pages.

12. **Deletion leaves primary PII copies behind and names the wrong store.**
    The canonical model stores message content and leads in PostgreSQL
    (`CHANNEL_AI_ASSISTANT_ARCHITECTURE:88,124-131`), while
    `SECURITY:219-229` and `MIU_BREAKDOWN:419-433` specify replacing only the
    event payload and propagating to "existing NoSQL leads". TX1 stores visitor
    content in both `conversation_messages` and `conversation_events`, and this
    repository has `oemProjects`, not an existing NoSQL `leads` collection
    (`packages/shared/src/collections.ts:116-194`). Tombstone every
    content-bearing primary copy, erase/tombstone PII in PostgreSQL `leads`, and
    name each real derived store with an assertion.

13. **The untrusted-input invariant forbids the mechanism the architecture
    selected.** `SECURITY:178-186,324-326` says message/model content never
    selects a tool and model output never triggers a side effect. The canonical
    Hermes profile exists to make approved read-only knowledge-tool calls
    (`CHANNEL_AI_ASSISTANT_ARCHITECTURE:24-27,82-87`), and normalized engine
    events necessarily cause fenced database writes. Distinguish capability
    selection from invocation: text may invoke only the fixed read-only
    knowledge set, and engine events may cause only enumerated state/event-log
    writes; text must never expand capabilities or cause leads, recipients,
    notifications, or mutating business actions.

14. **Most credential-isolation rows still have no falsifiable owner.**
    `SECURITY:56-71` says no credential ships without proof, but
    `TEST_STRATEGY:38-107,172-188` covers only a subset. A zero-privilege database
    role passes the non-AI `SELECT` refusal; a broken NoSQL credential passes the
    write refusal; MIU 5e proves approved delivery but not refusal of another
    target. Create a one-to-one credential-proof manifest. Every row needs a
    positive allowed operation and the nearest forbidden operation producing a
    scope/permission denial, with a named MIU, stage, and evidence artifact.

15. **The knowledge-only pilot is not dependency-closed or internally scoped.**
    `MIU_BREAKDOWN:665-682` includes MIU 15 but omits its declared dependency 14;
    its four-table reduced schema omits `outbox` while included MIU 5b is the
    outbox dispatcher, and it does not choose the rate ledger required by 6f.
    It also includes full MIU 11, whose 11e creates leads, while saying "no
    leads". Include 14, `outbox`, and the selected rate-ledger path; define the
    reduced forms of 5c and 11 explicitly (or restore the lead dependencies).

16. **The literal dependency table matches the prose, but the semantic DAG does
    not.** `MIU_BREAKDOWN:48-77` omits `5a -> 0` for the context/redaction
    decision, `8b -> 5e` for CRM deletion, `13b -> 13a` for evaluation against
    the approved corpus, and `15 -> 4,5a,13a` for the adapter, serving profile,
    and deployed public corpus. If native create is not idempotent, MIU 2c also
    omits the `engine_operations` table that MIU 5c needs, while MIU 4 demands a
    composed conformance case before 5c exists (`LLD-002:248-261`). Add the
    semantic edges, make the mapping schema conditional output of 2c, and run
    composed conformance only after both adapter and mapping layer exist.

17. **Race evidence is assigned before its subjects exist.** MIU 3 claims R1-R4
    and I1-I10 while explicitly having no engine or vendor
    (`MIU_BREAKDOWN:254-266`); MIUs 5c/5d later introduce the worker paths those
    races exercise. `TEST_STRATEGY:22-30,132-170` locates all I1-I11 races under
    `packages/ai-store`, yet the rows assert vendor calls, HTTP replay/Stop, SSE
    bytes, alerts, and widget state. Split proof ownership: store tests cover SQL
    predicates/rollback, 5c/5d cover workers and mapping, 6 covers HTTP, 7 covers
    SSE bytes, and 11 covers browser state. The transition suite also needs the
    exact T1-T6 guard/effect/rollback matrix; the existing named rows do not prove
    T1 notification atomicity or all CREATING terminal paths.

18. **The gate-closure plan contradicts the canonical release rule.** The
    architecture says public production remains blocked until all ten gates are
    closed (`CHANNEL_AI_ASSISTANT_ARCHITECTURE:205-218`), but MIU 16 permits a
    gate to be deferred and still reaches a production-approval decision
    (`MIU_BREAKDOWN:612-623`). The map at `MIU_BREAKDOWN:632-653` also maps code
    owners where the canonical gate requires an approved decision: workplace,
    consent/retention, budget thresholds, corpus thresholds, golden set, and
    pilot metrics. Require decision + implementation + fresh evidence for every
    sub-claim; a deferral may authorize isolated staging only and remains a
    production blocker.

19. **The plan has no contract-first owner for its main seams.** The canonical
    route table gives purposes but no request/response/error or conversation-
    credential wire contract; MIUs 6 and 7 add routes/SSE without schemas, and
    MIU 11 consumes them (`MIU_BREAKDOWN:368-408,488-501`). MIU 2a likewise
    introduces a second runtime without naming its package, entry point,
    Dockerfile, build/start command, deploy manifest, or smoke command
    (`MIU_BREAKDOWN:171-195`; current `package.json:11-33` has only site/function
    paths). Add a contract-first sub-MIU for public/admin DTOs, errors, credential
    transport, and the SSE event union; split 2a into exact repository/deploy
    artifacts before calling the breakdown executable.

### P2 findings

1. **"Record unconditionally" needs write-once semantics.** The architecture
   edit is directionally right, but `CHANNEL_AI_ASSISTANT_ARCHITECTURE:151` and
   `LLD-001:140,446-449` can be implemented as an unconditional overwrite. State
   the actual rule: no mode/status fence; NULL becomes H, replay of H succeeds,
   and a different handle never overwrites the first pointer (retain/cancel both
   and alert).

2. **No new ADR is needed, but supersession should be visible in the old
   artifact.** This edit does not replace a runtime, knowledge engine, trust
   boundary, or source of truth, so README's ADR trigger does not fire. The
   canonical note establishes authority, but `ADR-001:94-95` and the old sequence
   diagram still affirm the conditional-registration shape. Put a partial-
   supersession note in ADR-001 itself and redraw or visibly obsolete the diagram
   before it is used for implementation briefing.

3. **The revised estimate cannot be audited from this breakdown.** The original
   C0-C7 ranges do sum to 22-38 person-weeks (22 low, 38 high). The asserted
   44-50 at `MIU_BREAKDOWN:698-705` has no per-MIU inputs, so neither it nor the
   claim that the reduced pilot fits the original range is reproducible; option
   1 then moves the ceiling to about 45 while retaining an asserted upper bound
   of 50. Add low/high estimates and assumptions per MIU, then move the ceiling
   to the computed upper bound or show the exact scope cut that reaches 45.

### Round 1 response — Claude

**Accepted: 18 of 19 P1 in full, 1 in part. All 3 P2 accepted.** Fixed in the
commit that adds this section. I verified the checkable repo claims myself before
acting on them: there is no NoSQL `leads` collection (it is `oemProjects`),
`BaseLayout.astro` does ship two inline scripts, the only CSP in the repo is on a
media response, and the quoted document lines are accurate.

| # | Verdict | What changed |
|---|---|---|
| 1 | Accept | Terminalization CAS now carries a reason-specific term per caller — claimant matches `claim_epoch`, completion requires no pending cancel, the reaper re-evaluates the stall cutoff inside the `UPDATE` |
| 2 | Accept | Primitive B step 2 binds `conversation_id` and `expected_mode_version`; the event's epoch comes from step 1's `RETURNING` |
| 3 | Accept | TX2b branches on which term failed; a claimant superseded only by `claim_epoch` exits without cancelling its successor's run |
| 4 | Accept | `engine_operations` gains a per-acquisition `claim_token`; `CALL_IN_FLIGHT`, `CREATED` and `FAILED` require it plus the exact source state |
| 5 | Accept | Closed payload schema per system event type; `run.failed` carries a normalized category, never a vendor message |
| 6 | Accept | §1 rewritten to claim what the design proves — the assistant *writes* nothing after takeover. Delivery of already-committed text is stated as expected. I6 and the architecture's metric narrowed to committed events |
| 7 | Accept | Canonical §8 step 1 now qualifies draining to the message's own epoch |
| 8 | Accept | `clock_timestamp()` throughout. `now()` being transaction-start was a genuine trap and I had it in five places |
| 9 | Accept | Both rows replaced: two linearizations for the append gate, and a forced rollback for sequence integrity |
| 10 | Accept | Credential holder attests a non-secret identity to the BFF; per-surface positive/negative/sensitivity controls |
| 11 | Accept | Test restated as egress with a proven detector; CSP delivery and inline-script compatibility assigned an owner |
| 12 | Accept | Tombstone every content-bearing copy; derived stores named for real (`oemProjects`, not an invented NoSQL `leads`) |
| 13 | Accept | Rule restated as invoke-within-a-fixed-set vs expand-the-set |
| 14 | Accept (would have graded P2) | Credential-proof manifest: allowed op, nearest forbidden op, MIU, stage, evidence |
| 15 | Accept | Pilot closure rules written out — 14, `outbox`, the ledger decision, reduced 11 without the lead form. Third time this subset was wrong |
| 16 | Accept | Semantic edges added; `engine_operations` made a conditional output of 2c; composed conformance moved to 5c |
| 17 | Accept | Proof ownership split by layer in TEST_STRATEGY §2; MIU 3 no longer claims R1–R4 |
| 18 | **Partial** | See below |
| 19 | Accept | New MIU 5f owns DTOs, error envelope, credential transport and the SSE union, and precedes 6/7/11. MIU 2a now names package, entry point, Dockerfile, commands, manifest entry, smoke command |
| P2-1 | Accept | "Write-once" stated: `NULL` → handle, replay succeeds, a different handle never overwrites |
| P2-2 | Accept | Partial-supersession note added inside ADR-001; diagrams already marked stale in LLD-001's header |
| P2-3 | Accept | Recorded that 44–50 is an assertion, not a computation, and that per-MIU inputs are required before it drives a scope decision |

**Pushback on 18, partial.** The finding treats "architecture wins" as settling
it, but the tension is between two *pre-existing* documents: architecture §12
says production is blocked until all ten gates close, and README non-negotiable 6
explicitly permits time-bounded deferral with named owners and compensating
controls. MIU 16 followed the README. Declaring the architecture the winner would
quietly delete rule 6 rather than reconcile it.

The reconciliation I applied instead: both stand, because they answer different
questions — **a deferral authorises continued isolated staging; it never
authorises public production.** A deferred gate stays a production blocker with
an expiry attached. I did accept the rest of the finding: the map now separates
approved decision from implementation from evidence, since several gates need a
human decision no code can close.

### Verified sound

- The core `READ COMMITTED` idea is sound: a conditional `UPDATE` re-evaluates
  its `WHERE` predicate after waiting, and the conversation-then-run writes hold
  both locks to commit. The basic two-statement shape did not trade the old
  check/write window for a new one; findings 1-5 are missing predicates and
  writer contracts around that sound primitive.
- The partial unique index plus conversation-row serialization correctly enforces
  one live run, and I11's `answered_by_run` + accepted-epoch drain mechanism is
  internally coherent. The defect is the canonical queue wording, not the
  deliberate takeover-orphan decision.
- Splitting external-id recording from stream authorization is the right
  direction, as are exact-`BOT_ACTIVE` run reservation and content-only message
  immutability. The split needs P2 write-once wording; the immutability edit needs
  the deletion fix in finding 12.
- The route/session premise is correct. `channel.token` is origin-scoped
  `localStorage`, and the public storefront reads it; gate 10 closes widget
  placement, not session isolation.
- Every literal dependency-table row matches its per-MIU declaration, and the
  declared graph is acyclic. Finding 16 concerns omitted semantic dependencies,
  not a transcription error.
- Running the transactional-store probe first in MIU 0 is an adequate
  implementation gate. Writing the conditional PostgreSQL LLD before the probe
  may prove wasted work, but it does not authorize a hidden NoSQL fallback: the
  docs correctly require stopping and reopening ADR-001 on a negative result.
