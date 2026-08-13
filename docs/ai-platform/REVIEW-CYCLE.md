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

_Findings below this line._
