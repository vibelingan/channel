# LLD-001: Human Takeover State Machine and Ordered Event Fence

**Status:** Proposed; specifies §8 of [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
**Owning architecture:** Channel public AI assistant
**Depends on:** [ADR-001](./ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md) "Human Handoff Consistency Decision"
**Diagrams:** `.claude/diagrams/lld-state-conversation-control.excalidraw`, `.claude/diagrams/lld-sequence-human-takeover.excalidraw` — both predate this document. Where they differ, this document wins: the sequence diagram still shows the run id being registered *conditionally* (now split into an unconditional record plus a fenced authorization, §5) and labels a discarded run `DISCARDED`, which is not a status in §3. Redraw them before they are used to brief anyone.
**Last reviewed:** 2026-08-11

## 1. What this document specifies

The architecture states the requirement in one line: *stop all old AI output after
a human takes control*. That line is a concurrency problem, not a feature. This
document specifies the exact states, the exact conditional writes, the ordering
rule that makes "old output" unrepresentable, and the behaviour at each point
where a takeover can interleave with an in-flight AI run.

Plain statement of the goal: when a salesperson clicks **Take over**, the visitor
must never see another word from the assistant — not a token already in flight,
not a final message that was half-written when the click landed, and not a
message from a run that was created a millisecond earlier. The visitor sees the
salesperson's reply and nothing else.

The three mechanisms that deliver this:

1. **Authorization epoch** — a counter on the conversation that changes whenever
   the assistant's authority to write is transferred or revoked. Every AI write
   carries the epoch it was authorized under, and a write whose epoch is stale is
   rejected by the database, not by the application's good intentions.
2. **Run-level cancellation** — the epoch covers control changes, but the visitor
   pressing **Stop** is not a control change. A separate term in the same
   conditional write covers it, so a stopped answer stops even if the vendor's
   stop call never lands.
3. **Ordered event log** — the visitor's stream is fed only from committed,
   sequentially numbered rows. Nothing reaches the browser that did not first
   survive both checks.

Nothing here relies on the model obeying an instruction, on the vendor's stop
endpoint succeeding, or on the browser filtering what it renders. Those are all
present, and all three are defence in depth.

## 2. State model

### 2.1 Conversation states

```text
                   visitor asks for a human
    BOT_ACTIVE ──────────────────────────────► HANDOFF_REQUESTED
        │                                              │
        │  sales claims directly                       │  sales claims
        └──────────────────┬───────────────────────────┘
                           ▼
                     HUMAN_ACTIVE
                           │
                           │  authorized explicit return
                           ▼
                     BOT_ACTIVE
                           │
   any state ─────────────►│
   (visitor close,         ▼
    sales close,        CLOSED  (terminal)
    retention job)
```

`CLOSED` is terminal. There is no transition out of it; a returning visitor gets
a new conversation.

### 2.2 Fields that carry control

| Field | Type | Meaning |
|---|---|---|
| `conversations.status` | enum | `BOT_ACTIVE`, `HANDOFF_REQUESTED`, `HUMAN_ACTIVE`, `CLOSED` |
| `conversations.mode_version` | integer, starts at 1 | **Authorization epoch.** Incremented whenever the assistant's authority to write is transferred or revoked |
| `conversations.next_event_seq` | bigint, starts at 1 | Next sequence number to hand out; allocated only by the conditional update in §4.2 |
| `conversations.assigned_to` | user id, nullable | Current human owner |
| `ai_runs.expected_mode_version` | integer | The epoch this run was authorized under |
| `ai_runs.claim_epoch` | integer | Incremented on every worker claim; fences a zombie holder (§4.3) |

Read `mode_version` as *the epoch in which the assistant may write*, not as a
count of human takeovers. Three events end an epoch: a human takes control, a
human hands control back, and the conversation closes. Closing counts because it
revokes the assistant's authority just as surely as a takeover does — the fence
then rejects a late token for the same reason, without needing a second
mechanism. Reassignment between two salespeople (T4) is not an epoch change: the
assistant's authority did not change, and no run's authorization moved.

`HANDOFF_REQUESTED` does **not** increment `mode_version`, because control has
not moved yet. It changes one thing: **no new AI run may be reserved.** A run
that is already in flight is allowed to finish, so a visitor who clicks *talk to
a human* mid-answer sees that answer complete rather than stop mid-sentence.
A further visitor message in this state is stored and shown to the salesperson,
but starts no run.

The epoch advances on `HUMAN_ACTIVE` (T2), on an authorized return to
`BOT_ACTIVE` (T3), and on close (T5) — see §2.2's reading of `mode_version`.

### 2.3 Transition table

| # | From | To | Actor | Guard | Same-transaction effects |
|---|---|---|---|---|---|
| T1 | `BOT_ACTIVE` | `HANDOFF_REQUESTED` | visitor | status is `BOT_ACTIVE` | append `handoff.requested`; enqueue sales notification; **no new run may be reserved from here on**, in-flight run may finish |
| T2 | `BOT_ACTIVE`, `HANDOFF_REQUESTED` | `HUMAN_ACTIVE` | sales | status in set **and** `mode_version = expected` | `mode_version += 1`; set `assigned_to`, `taken_over_at`; append `handoff.started`; set `cancel_requested_at` on all live runs; enqueue one cancel-run outbox item per live run |
| T3 | `HUMAN_ACTIVE` | `BOT_ACTIVE` | sales (explicit) | status is `HUMAN_ACTIVE` **and** caller is assignee or admin | `mode_version += 1`; clear `assigned_to`; append `handoff.returned` |
| T4 | `HUMAN_ACTIVE` | `HUMAN_ACTIVE` | sales (reassign) | status **is** `HUMAN_ACTIVE` **and** `assigned_to = $current` **and** caller is assignee or admin | change `assigned_to`; append `assignment.changed`; **no** epoch change |
| T5 | `BOT_ACTIVE`, `HANDOFF_REQUESTED`, `HUMAN_ACTIVE` | `CLOSED` | visitor, sales, or retention job | status in that explicit set **and** `mode_version = expected` | `mode_version += 1`; append `conversation.closed`; set `cancel_requested_at` on live runs; enqueue cancels; start retention clock |
| T6 | — | — | visitor (Stop) or sales | run belongs to this conversation **and** run status in (`CREATING`, `RUNNING`) | lock the conversation first (§4.4 order), then set `ai_runs.cancel_requested_at`; append `run.stopped`; enqueue cancel-run. **Run-level only** — no status or epoch change |

T4 carries a status predicate and the expected current assignee, so a reassign
cannot fire on a closed conversation, cannot fire while the assistant is still
answering, and cannot silently overwrite a colleague who claimed it first. It
does not change the epoch because the assistant's authority did not change.

T5's guard is an explicit **allow-list of source states**, not `status ≠ CLOSED`.
A denylist silently admits every status added later, which is how a future
`PAUSED` or `ESCALATED` becomes closable by accident.

T6 is the visitor's Stop button (`POST /api/ai/runs/:id/cancel`) and the
architecture's widget Stop control. It is a **run-level** transition — the
conversation stays `BOT_ACTIVE` and the epoch does not move, because the visitor
stopping one answer is not a transfer of control. That is precisely why the
epoch alone cannot enforce it, and why §4.2's fence carries a separate
run-level term.

## 3. Run model

```text
CREATING ──► RUNNING ──► COMPLETED
   │  │         │
   │  └─────────┼──────► FAILED      (crash, dead-letter, or CREATING age limit)
   │            │
   └────────────┴──────► CANCELLED
```

| `ai_runs` field | Purpose |
|---|---|
| `id` | Internal run id (the only id the public API exposes) |
| `operation_id` | Stable, deterministic id sent to the engine so a replayed create returns the same run |
| `engine_run_id` | The vendor's run id; recorded unconditionally as soon as it is known (§5) |
| `expected_mode_version` | The epoch this run was authorized under |
| `claim_epoch` | Incremented on every worker claim; the fencing token for §4.3 |
| `claimed_by`, `lease_expires_at` | Current worker and its lease |
| `last_append_at` | Set by every append (§4.2 step 2). Doubles as the liveness signal the stall reaper reads — a `RUNNING` run whose last append is older than the stall limit is dead, whatever its lease says |
| `status` | `CREATING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `cancel_requested_at` | Set by takeover, close, or the visitor's Stop, even while `engine_run_id` is `NULL` |
| `attempts` | Bounded; exhaustion is a terminal `FAILED`, never an endless retry |
| `error_category` | Normalized category from the engine port (see [LLD-002](./LLD-002-CONVERSATION-ENGINE-INTERFACE.md) §6) |

`operation_id` is derived deterministically from the run row (`uuidv5` of the run
id under a fixed namespace), so a retried outbox delivery computes the same value
without storing extra state.

**At most one live run per conversation**, enforced in the schema rather than by
policy:

```sql
CREATE UNIQUE INDEX one_live_run_per_conversation
    ON ai_runs (conversation_id)
 WHERE status IN ('CREATING', 'RUNNING');
```

Without it an impatient visitor sending two messages gets two concurrent runs,
both passing the fence, and their tokens interleave into one sequence stream that
the widget cannot separate. `conversation_events.run_id` exists so that a stream
can always be attributed even if this constraint is ever relaxed.

The index constrains the writer, so the writer must check before it inserts:
TX1 (§5) starts no run when a live one exists, rather than letting the violation
roll back the visitor's message. And a run leaves the index only when it reaches
a terminal status — marking it `cancel_requested_at` is not enough, so the cancel
handler must terminalize it promptly or the next message is stuck behind a run
nobody is streaming.

**Both live statuses are bounded.** A run older than the `CREATING` age limit, or
whose outbox item dead-letters, or whose attempts are exhausted, transitions to
`FAILED` and appends a terminal event. A `RUNNING` run whose `last_append_at` is
older than the stall limit is reaped the same way — and that reaper is not
optional, because a live run is what the §3 index counts: one wedged `RUNNING`
run would otherwise block every further answer in that conversation forever.
The reaper is exempt from the `attempts < $max` predicate; exhausted attempts
must still be terminalizable.

## 4. The two primitives

Everything below is built from exactly two database operations. Reviewers should
be able to check any code path by asking which of the two it uses.

### 4.1 Primitive A — compare-and-set on control

```sql
UPDATE conversations
   SET status       = 'HUMAN_ACTIVE',
       mode_version = mode_version + 1,
       assigned_to  = $actor,
       taken_over_at = now()
 WHERE id = $conversation
   AND status IN ('BOT_ACTIVE', 'HANDOFF_REQUESTED')
   AND mode_version = $expected_version
RETURNING mode_version, next_event_seq;
```

Zero rows returned means someone else moved first. The caller does **not**
retry blindly; it re-reads and reports the current owner. Two salespeople
clicking **Take over** at the same instant produce exactly one winner and one
"already taken over by …" response.

### 4.2 Primitive B — fenced, sequenced event append

Every visitor-visible byte goes through this, inside one explicit transaction at
`READ COMMITTED` (§4.4):

```sql
BEGIN;

-- 1. Conversation gate + sequence allocation, in one write.
--    Zero rows = authorization lost; roll back and append nothing.
UPDATE conversations
   SET next_event_seq = next_event_seq + 1
 WHERE id           = $conversation
   AND mode_version = $expected_epoch
   AND status       = ANY($allowed_statuses)   -- per writer class, §4.3
RETURNING next_event_seq - 1 AS allocated_seq, mode_version;

-- 2. AI writers only: the run gate. A separate conditional write, because these
--    terms live on ai_runs and a joined read in step 1 would be evaluated from
--    the statement snapshot rather than re-checked under contention — which
--    would leave the visitor's Stop and lease expiry unfenced.
--    This statement takes the ai_runs row lock, and the same write renews the
--    lease and records liveness, so a healthy long answer never loses its claim
--    mid-stream and a stalled one is visible to the reaper. Zero rows = abort.
UPDATE ai_runs
   SET last_append_at   = now(),
       lease_expires_at = now() + $lease
 WHERE id                  = $run
   AND claim_epoch         = $my_claim_epoch
   AND cancel_requested_at IS NULL
   AND status              = 'RUNNING'
RETURNING id;

INSERT INTO conversation_events
       (conversation_id, sequence, run_id, type, mode_version, payload, created_at)
VALUES ($conversation, $allocated_seq, $run, $type, $mode_version, $payload, now());

COMMIT;
```

Both gates are conditional writes, both take row locks held to commit, and they
are taken in the order §4.4 fixes. Either returning zero rows aborts the
transaction and appends nothing.

**Why each gate is a conditional write.** An earlier draft of this document did
the obvious thing — `SELECT … FOR UPDATE`, check the fence in application code, then
allocate and insert. That is correct *only* if the transaction is explicit, the
lock is held to commit, and the sequence comes from the locked read. Written as
prose, it also permits the implementation where the fence is checked, the lock is
released, a takeover commits, and the append then lands at a sequence **above**
`handoff.started` — the exact byte this whole document exists to prevent. The
form above cannot be refactored into that shape: in step 1 the predicate and the
allocation are the same write, and step 2's predicate is likewise inseparable
from the write that takes the run's lock.

This is the storage-layer gate the project's own concurrency rules require. An
application-side `if` between a read and a write is advisory; a `WHERE` clause is
not.

**Forbidden shapes.** Read status, then `res.write()`. Read status, then a
non-conditional `UPDATE`. Allocate the sequence from a separate statement or a
Postgres `SEQUENCE` object (see §8 on why gaplessness depends on the counter
being a column that rolls back). Filter old events in the browser only. Ask the
model to stop in a prompt. Each of these has a window where a token escapes.

### 4.3 Writer classes

`$allowed_statuses` and the fence terms are defined once, per writer class, and
referenced everywhere. Four spellings of the same question is how a status added
later gets admitted by one path and rejected by another.

| Writer | `$allowed_statuses` (step 1) | Additional step-1 terms | Step 2 | Event types it may write |
|---|---|---|---|---|
| AI (run output) | `BOT_ACTIVE`, `HANDOFF_REQUESTED` | — | required — the run gate | `ai.token`, `ai.citation`, `ai.final`, `ai.error` |
| Human | `HUMAN_ACTIVE` | `assigned_to = $actor` | — | `human.message` |
| Visitor | `BOT_ACTIVE`, `HANDOFF_REQUESTED`, `HUMAN_ACTIVE` | — | — | `visitor.message`, `handoff.requested` |
| System | all four, `CLOSED` included | **`$expected_epoch` is the epoch this transaction just wrote**, not the one it read on entry | — | `handoff.started`, `handoff.returned`, `assignment.changed`, `conversation.closed`, `run.stopped`, `run.abandoned`, `run.failed` |

`HANDOFF_REQUESTED` appears in the AI row so an in-flight answer can finish; it
blocks new runs, not the current one, and the epoch is unchanged so no control
has moved.

The two run-level terms in the AI row are what make the visitor's Stop button
(T6) and worker fencing real. `cancel_requested_at` is not decoration — without
it in the fence, a visitor presses Stop and the assistant keeps typing until a
cancel worker happens to catch up, which may be never if the vendor's stop call
fails. `claim_epoch` stops a worker whose lease expired while it was still alive
from interleaving its tokens into the stream of the worker that replaced it.

The **system** row carries the control and lifecycle events that belong to no
participant: the transitions themselves, and the terminal run events that stop
the widget waiting forever. Its status set is all four, `CLOSED` included, for
two reasons that both bite in practice:

- T5 sets the status **and** appends `conversation.closed` in one transaction, so
  a class restricted to non-terminal statuses would see its own write and reject
  it — every closed conversation would end with no closing event.
- A run can outlive its conversation. When a run ages out or dead-letters after
  the conversation is already closed, its terminal event still has to land, or
  the reaper has nowhere to record what it did.

The epoch rule in the third column is equally load-bearing and easy to miss:
T2, T3 and T5 bump `mode_version` before appending, so a system writer passing
the epoch it read on entry would get zero rows and abort the entire takeover.
It passes the epoch it just wrote.

The system class is also the most likely future route to a leak, since it is the
one class whose status set is wide. Two rules keep it safe, and both belong in a
check constraint on event type rather than in a code-review habit: the allowed
event types are exactly the list above, and **none of them may carry
assistant-authored text**. Assistant output has one writer class and one gate.

### 4.4 Isolation, lock order, and retries

- **`READ COMMITTED`.** The design needs no more, and needs the specific
  behaviour that a conditional `UPDATE` re-reads the latest committed row and
  returns zero rows on a lost fence. Under `REPEATABLE READ` or `SERIALIZABLE`
  the same statement raises a serialization failure instead, which turns "someone
  else took over first" into a 500. Assert the level at connection setup rather
  than inheriting a pooler default, and probe it in MIU 0.
- **Lock order is always `conversations` before `ai_runs`.** Takeover marks runs
  after updating the conversation; the worker must not do the reverse. Without a
  stated order the two paths deadlock exactly when tokens are streaming.
- **Retry `40001` and `40P01`** with bounded backoff on both paths, and map an
  exhausted retry to a conflict response, never to a success.

## 5. Required sequence for one visitor message

```text
Visitor POST /messages
  └─ TX1 ─────────────────────────────────────────────────────────────┐
     │ lock conversation; reject if CLOSED                             │
     │ insert conversation_messages (unique on conversation +          │
     │   idempotency_key — a retried POST is a no-op, not a second run)│
     │ append visitor message event via Primitive B                    │
     │ if status = BOT_ACTIVE and no live run exists:                  │
     │     insert ai_runs (CREATING, operation_id, expected_mode_ver.) │
     │     insert outbox 'start-run'                                   │
     │ if status = BOT_ACTIVE and a live run exists:                   │
     │     store the message with answered_by_run = NULL, start NO     │
     │     run, return "still answering".                              │
     │     The one-live-run index (§3) would otherwise raise a unique  │
     │     violation and roll back the whole transaction, losing the   │
     │     visitor's message — a failed POST instead of a queued one.  │
     │     Because TX1 holds the conversation lock and TX1 is the only │
     │     writer of ai_runs rows, this check is race-free rather than │
     │     merely narrow.                                              │
     │ if status = HANDOFF_REQUESTED or HUMAN_ACTIVE:                  │
     │     store the message only — a human will answer it             │
     └─────────────────────────────────────────────────────────────────┘
        The public request ends here. It never calls the engine.

Worker picks up 'start-run'
  ├─ claim the run and take a fencing token:
  │     UPDATE ai_runs
  │        SET claim_epoch = claim_epoch + 1,
  │            claimed_by = $worker, lease_expires_at = now() + $lease,
  │            attempts = attempts + 1
  │      WHERE id = $run
  │        AND status IN ('CREATING', 'RUNNING')   -- RUNNING is required:
  │            -- reclaiming a stalled streamer is the case claim_epoch exists
  │            -- for, and that run is RUNNING, not CREATING
  │        AND (claimed_by IS NULL OR lease_expires_at < now())
  │        AND attempts < $max
  │     RETURNING claim_epoch, status;    -- zero rows = not ours; stop
  │     Only a CREATING claim proceeds to the create call below.
  │     A claim that finds status RUNNING is a RECLAIM of an abandoned run:
  │     terminalize it as FAILED, append a terminal event, enqueue cancel-run.
  │     It does NOT resume streaming — streamRun takes a handle and no offset
  │     (LLD-002 §4), so "resuming" would replay the answer from token zero and
  │     append the whole thing again at new sequences. The visitor sees an
  │     interrupted answer and a retry affordance, which is honest and cheap;
  │     a resume protocol would need an engine capability nobody has proven.
  │     Every later write by this worker carries the returned claim_epoch.
  ├─ re-read conversation: status = BOT_ACTIVE and epoch unchanged?
  │     (BOT_ACTIVE only — HANDOFF_REQUESTED lets an in-flight answer finish
  │      but starts no new run, §2.2)
  │     no  -> mark run CANCELLED, append a terminal run event so the widget
  │            never dead-ends, drop the outbox item, done
  ├─ engine.createRun({ operationId, ... })          [external, replay-safe]
  ├─ TX2a: record engine_run_id UNCONDITIONALLY the moment it is known.
  │        A pointer to a resource that already exists at the vendor is never
  │        thrown away — otherwise the only way to stop it is run-listing,
  │        which the pinned release may not support.
  ├─ TX2b: authorize CREATING -> RUNNING, conditional on the epoch AND
  │        claim_epoch AND cancel_requested_at IS NULL
  │     fence lost -> enqueue cancel-run (engine_run_id is already recorded),
  │                   do not stream
  └─ stream engine events; append each via Primitive B (TX per event or small
     batch). The first zero-row append aborts the stream and requests cancel.

Sales POST /takeover
  └─ TX3: Primitive A; append handoff.started; set cancel_requested_at on live runs;
          enqueue cancel-run per run. One transaction, one linearization point.

Cancel worker
  └─ engine.cancelRun(handle) — idempotent; unknown/finished runs are success.
     Runs with engine_run_id NULL are reconciled by operation_id first.

Run terminalization (every path: completed, failed, cancelled, reaped)
  └─ TX: set the terminal status, append the terminal event, and THEN drain —
     if the conversation is BOT_ACTIVE and an unanswered visitor message
     exists (answered_by_run IS NULL), reserve a new run for it and enqueue
     'start-run'. Without this drain the message TX1 queued above is stored
     and never answered: the visitor typed a follow-up mid-answer and gets
     silence. The one-live-run index is satisfied because the old run has
     just left the live set in this same transaction.
```

## 6. The race windows

The architecture names four points where takeover can land, described below. They
are a starting point, not the whole set — TEST_STRATEGY.md §4 covers one race per
transition pair, including close, return-to-AI, reassignment, the visitor's Stop,
lease expiry, and the window inside the append itself.

### R1 — Takeover before the run is created

The worker's re-read (step 2 of the start-run handler) sees `HUMAN_ACTIVE` or a
bumped version and abandons the run before any external call. **No engine run
exists.** Cost of the race: one wasted worker cycle.

### R2 — Takeover between external creation and authorization

The run exists at the vendor. TX2a records its id **unconditionally**, so the
BFF always holds the pointer needed to stop it; only the `CREATING → RUNNING`
authorization in TX2b is fenced, and it fails. A cancel-run item is enqueued
carrying the recorded `engine_run_id`.

Splitting the write this way is what removes R2's dependence on vendor
run-listing. An earlier draft fenced the id-recording itself, which threw away
the pointer at exactly the moment it was needed and left `operation_id →
engine_run_id` resolution as the only route — a capability the pinned release may
not have.

Meanwhile the run may already be emitting tokens. **None of them can reach the
visitor**, because every append goes through Primitive B and the fence rejects
them. The vendor is producing output into a stream that has no committed
destination.

### R3 — Takeover after tokens have been appended

Tokens already committed at sequences below `handoff.started` stay visible —
correctly, because the visitor already saw them and erasing them would rewrite
history. Every subsequent append from the old run fails the fence. The visitor's
stream shows: partial assistant text, then `handoff.started`, then the human.

The UI must render an interrupted assistant message as interrupted rather than
pretending it completed. This is a widget requirement, not a data requirement.

### R4 — Takeover before the final message commits

The final message is not special. It is one more Primitive B append and it fails
the same fence. A run can therefore reach the vendor's notion of "completed"
while the BFF records it as `CANCELLED` with no final message committed. That
divergence is intended: the vendor's completion is not a business fact.

## 7. Replay-safe run creation

The architecture's gate 7 requires proving that creating a run twice with the
same operation id yields one run. Two outcomes:

**If the pinned engine release provides it natively** — the adapter passes
`operationId` through and declares `supportsIdempotentCreate: true`.

**If it does not** — interpose a persistent operation-id mapping layer, and the
port's capability descriptor must report `supportsIdempotentCreate: false` so the
BFF refuses to run without it. It lives in the BFF, as a component that *wraps*
the engine port rather than an adapter that implements it: LLD-002 forbids any
database access inside an adapter, and this layer owns a table.

```sql
CREATE TABLE engine_operations (
  operation_id    uuid PRIMARY KEY,
  engine_run_id   text,
  state           text NOT NULL,     -- CLAIMED | CALL_IN_FLIGHT | CREATED | FAILED
  claimed_by      text,
  lease_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

The state that matters is **`CALL_IN_FLIGHT`: called, outcome unknown.** An
earlier draft had a single `INTENT` marker and short-circuited only on a row that
already carried `engine_run_id`. That is not enough. Walk it: worker 1 writes
`INTENT`, calls the vendor, the vendor creates run X, and the response is lost.
Worker 2 retries the same outbox item, finds `INTENT` with a null
`engine_run_id`, and — having no rule that stops it — creates run Y. Two vendor
runs for one operation, which is the exact thing this layer exists to prevent.

The corrected order:

```sql
-- Claim, or fall through to the three-way branch below.
INSERT INTO engine_operations (operation_id, state, claimed_by, lease_expires_at)
VALUES ($op, 'CLAIMED', $worker, now() + $lease)
ON CONFLICT (operation_id) DO UPDATE
   SET state            = 'CLAIMED',
       claimed_by       = $worker,
       lease_expires_at = now() + $lease
 WHERE engine_operations.engine_run_id IS NULL
   AND engine_operations.state <> 'CALL_IN_FLIGHT'
   AND engine_operations.lease_expires_at < now()
RETURNING operation_id, state, engine_run_id;
```

**Zero rows does not mean "refuse".** It means the claim predicate did not
match, and three different situations produce it — so the caller must then
`SELECT state, engine_run_id` and branch:

| Row state | Meaning | Action |
|---|---|---|
| `engine_run_id` present (`CREATED`) | The run already exists; this is the replay case | **Return the existing handle.** This is the whole point of the layer |
| `CALL_IN_FLIGHT` | Called, outcome unknown | Refuse and alert. Never create |
| Live lease held by another worker | Contention | Back off and retry |

Getting this wrong is subtle and total: an earlier draft returned zero rows for a
completed operation and read it as "someone else owns this", so a retried outbox
delivery after a *successful* create refused instead of resuming — the exact
replay this layer exists to serve.

`DO UPDATE` resets `state` to `CLAIMED` so a reclaimed `FAILED` row does not stay
marked failed.

Then set `CALL_IN_FLIGHT` immediately before the external call — **conditionally
on still holding the claim**:

```sql
UPDATE engine_operations
   SET state = 'CALL_IN_FLIGHT'
 WHERE operation_id     = $op
   AND claimed_by       = $worker
   AND lease_expires_at > now()
RETURNING operation_id;     -- zero rows = superseded; do not call the vendor
```

Without that predicate the whole layer leaks: a worker that stalls past its
lease, gets superseded, and then wakes up would write `CALL_IN_FLIGHT` and call
the vendor anyway, producing the second run this layer exists to prevent.

Then create the run tagged with the operation id in vendor metadata, and record
`engine_run_id` with state `CREATED`.

`CALL_IN_FLIGHT` is a **terminal refusal for every other worker**, including
after its lease expires. An operation stuck there is resolved by lookup or
escalated by alert — never by creating a second run. Trading a stalled answer for
a possible duplicate is the right trade: the visitor sees an error and can retry,
whereas a duplicate run is unstoppable output and double billing.

This narrows but does not eliminate the hole — it depends on the engine
supporting (a) attaching metadata to a run and (b) listing runs. **Both are
unproven against the pinned release.** They are probes, not assumptions; see
TEST_STRATEGY.md §5. If listing is unavailable, the fallback is a bounded orphan
window with an alert, and that must be an explicit, time-bounded risk acceptance
with a named owner.

## 8. Delivery to the browser

The SSE dispatcher is a reader. It selects committed events with
`sequence > $last_seen` in sequence order and emits them; it never receives
anything from the engine directly.

- The SSE id is the event sequence. Reconnect sends `Last-Event-ID`, and the
  dispatcher resumes from the next sequence — no duplicates, no gaps.
- Events carry `mode_version` so the client can label the transition, and the
  client drops any AI event whose version is below the last `handoff.started` it
  saw. **This filter is defence in depth.** If it is ever the thing preventing a
  leak, the fence has already failed and that is the bug to fix.
- The sequence counter is a **column on the conversation row that rolls back**,
  which is the only reason the log is gapless: an aborted transaction un-does the
  bump and the insert together. Replacing it with a Postgres `SEQUENCE` object —
  the obvious optimization when the row becomes a hot spot — produces a gap on
  every rollback and turns the alarm below into a false alarm on each one. Do not
  make that change without replacing the gapless invariant first.
- A gap is therefore an integrity alarm, not a normal event.

## 9. Invariants

These are the statements tests assert. Each is falsifiable and each has a test in
TEST_STRATEGY.md §4.

- **I1** For one conversation, `sequence` values are unique, strictly increasing,
  and gapless.
- **I2** If `handoff.started` commits at sequence *N* in epoch *V+1*, no event
  written by a run whose `expected_mode_version ≤ V` exists at a sequence > *N*.
- **I3** Under concurrent takeover attempts, exactly one succeeds; every other
  caller receives a conflict. Where an owner exists it is named; a caller that
  lost on a stale epoch while the conversation is still `BOT_ACTIVE` is told the
  epoch moved, because there is no owner to name.
- **I4** Every run that reaches `CREATING` ends in `COMPLETED`, `FAILED`, or
  `CANCELLED` within the `CREATING` age limit, and produces at most one vendor
  run.
- **I5** A run that fails its authorization fence has a cancel request enqueued
  in the same transaction that rejected it, and its `engine_run_id` was already
  recorded.
- **I6** No assistant-authored event is visible to the visitor at a sequence
  after a committed `handoff.started` of a later epoch.
- **I7** After a cancellation is recorded — by takeover, by close, or by the
  visitor's Stop — no further assistant-authored event is committed, regardless
  of whether the vendor stop call succeeds. A failed stop raises a cost and
  observability alarm only.
- **I8** A replayed visitor POST with the same idempotency key produces zero
  additional runs and zero additional messages.
- **I9** At most one run per conversation is in `CREATING` or `RUNNING`.
- **I10** A worker whose lease expired and was reclaimed cannot commit an event:
  its `claim_epoch` no longer matches.

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| Vendor stop endpoint fails | The fence still blocks all output (I7) — `cancel_requested_at` is a fence term, not just a work item. Retry with backoff; alert on repeated failure; the visitor is unaffected. |
| Worker crashes mid-stream | Lease expires; the run is reclaimed with a new `claim_epoch`, or aged out to `FAILED`. The zombie cannot commit (I10). The visitor sees an error event and a retry affordance. |
| Worker stalls but stays alive past its lease | Same as above. This is the case a lease alone does not cover and `claim_epoch` does. |
| Database unavailable | Fail closed. No streaming, no run creation; widget falls back to the inquiry form. |
| Engine unavailable | Run is `FAILED` with a normalized category; the visitor is offered a human or the inquiry form. |
| Takeover arrives for a `CLOSED` conversation | Primitive A returns zero rows; the API returns a conflict. |
| Deadlock or serialization failure | Bounded retry (§4.4); an exhausted retry returns a conflict, never a success. |
| Outbox item dead-letters | The run transitions to `FAILED` and a terminal event is appended, so the widget never waits forever on a run nobody will run. |
| Clock skew between BFF and workers | No logic depends on wall-clock ordering; ordering comes from the sequence, and leases use database time. |

## 11. Open questions this design does not settle

1. Whether the pinned engine release supports replay-safe create, run metadata
   tagging, and run listing (gate 7; determines whether §7's mapping layer is
   needed).
2. Whether the operational store is CloudBase PostgreSQL over the `pg` protocol
   or database-side RPCs — ADR-001 §"Human Handoff Consistency Decision" requires
   live verification in the target environment, and **the repository has no
   PostgreSQL dependency today**. Every conditional `UPDATE … RETURNING` above
   assumes a transactional store with that return contract; a NoSQL fallback
   would need a different primitive and a new ADR. This probe runs **first** in
   MIU 0 — if it fails, most of the plan that follows does not survive.
3. Whether a returned-to-AI conversation replays prior human messages to the
   model as context, and under what redaction rule.
4. The retention rule for events belonging to cancelled runs.
