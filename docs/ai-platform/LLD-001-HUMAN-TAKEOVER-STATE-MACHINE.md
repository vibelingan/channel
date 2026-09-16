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

Plain statement of the goal, stated as precisely as the design can actually
deliver: **once a takeover commits, the assistant writes nothing further.** No
token, no final message, nothing from a run created a millisecond earlier. From
`handoff.started` onward the transcript contains only the salesperson.

What that does *not* claim, and cannot: that the visitor's screen freezes at the
instant of the click. Assistant text committed *before* the takeover is part of
the transcript and is still delivered — it may be in a socket buffer, or arrive
after a reconnect — so a visitor can watch a few more words land a moment after
the salesperson took over. Those words were authorised when they were written.
Erasing them would rewrite history, and a design that promised otherwise would be
promising something the browser cannot be held to.

The guarantee is therefore about **what is written, not about what has finished
painting**. If the product needs the stronger version — nothing new appears after
the visitor observes the handoff — that is a delivery barrier in the widget, and
it must be specified as such rather than assumed from this document.

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
| `conversation_messages.answered_by_run` | run id, nullable | The run reserved to answer this visitor message. `NULL` means nobody has been assigned to it. Every reserve path must stamp it, or the drain re-answers the same message forever |
| `conversation_messages.accepted_in_epoch` | integer, NOT NULL | The epoch in which the message arrived. Scopes the drain (§5) so it cannot answer a question a human already handled. `NOT NULL` matters: a nullable column with no default makes the drain's equality test silently never match |
| `conversation_messages.event_sequence` | bigint | The sequence of the `visitor.message` event appended for this message. Gives "oldest unanswered" a defined meaning without a second counter |

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
| `engine_run_id` | The **canonical** vendor run id — the first one recorded. Write-once (§3.4); every observed handle, including a conflicting second one, is recorded in `engine_run_handles` |
| `expected_mode_version` | The epoch this run was authorized under |
| `claim_epoch` | Incremented on every worker claim; the fencing token for §4.3 |
| `claimed_by`, `lease_expires_at` | Current worker and its lease |
| `last_append_at` | Set at authorization (TX2b) and by every append (§4.2 step 2). Never `NULL` for a `RUNNING` run — a run that is authorized and then emits nothing at all is the commonest wedge, and a `NULL` here would make it invisible to the reaper forever. Doubles as the liveness signal: a `RUNNING` run whose last append is older than the stall limit is dead, whatever its lease says |
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
**The reaper is not a worker.** It is a separate path with its own statement —
it terminalizes and drains (§5), and it must not bump `claim_epoch` or set
`claimed_by`, because it is not going to stream anything. It is also exempt from
`attempts < $max`: an exhausted run must still be closeable, and a reaper that
inherits the claim statement's predicates cannot close the runs that need it most.

### 3.1 The five clocks

Five timers bear on "is this run alive", and they must be ordered or they fight:

```text
CREATING age limit  ≥  stall limit  ≥  outbox item lease
                                    ≥  run lease
                                    >  max inter-token gap

engine-operation claim lease  ≥  vendor create timeout
```

The `CREATING` age limit is the longest for a reason: fail a run before its
outbox item's lease has run out and you strand the operation in
`CALL_IN_FLIGHT`, which §7 makes a terminal refusal resolvable only by alert.
The run lease must exceed the longest legitimate inter-token gap — a tool call
produces one routinely — or a healthy answer loses its claim and, since a
reclaim terminalizes rather than resumes, is destroyed rather than duplicated.

The two leases are different numbers and must not share a configured value: one
bounds a streaming worker, the other a single vendor call. `$lease` is a
placeholder in §4.2, §5 and §7 and means something different in each.

State all five together in configuration, not in five unrelated places. Five
numbers chosen independently in five files is how the ordering above stops
holding without anyone noticing.

### 3.2 Terminalization matrix — the total function

Every path that may write a terminal status, with the exact predicate it carries.
This table is normative and exhaustive: **a path not listed here may not
terminalize a run.** Earlier drafts specified four of these nine and left the
rest to judgement, which is how a stale observer ends a healthy run.

Every row additionally carries `conversation_id = $conversation` (the same
binding Primitive B requires, §4.2) and runs inside the terminalization
transaction of §5.

| # | Path | Source status | Caller fence | Terminal | Event |
|---|---|---|---|---|---|
| 1 | Claimant completes | `RUNNING` | `claim_epoch = $mine` **and** `cancel_requested_at IS NULL` **and** the `ai.final` event is appended in **this same transaction** (§3.3) | `COMPLETED` | `run.completed` |
| 2 | Claimant hits an engine error | `RUNNING` | `claim_epoch = $mine`; **cancellation takes precedence** (see below) | `FAILED` | `run.failed` |
| 3 | Worker abandons before creating (R1) | `CREATING` | `claim_epoch = $mine` | `CANCELLED` | `run.cancelled` |
| 4 | Conclusive create error — vendor rejected, no run exists | `CREATING` | `claim_epoch = $mine`; **only** when the mapping layer proves no vendor run was created. An ambiguous or timed-out create is *not* conclusive and stays in flight (§7) | `FAILED` | `run.failed` |
| 5 | Cancel worker acts on a recorded cancellation | `CREATING`, `RUNNING` | `cancel_requested_at IS NOT NULL` — **no** claim fence; cancellation is authorised by the record, not by ownership | `CANCELLED` | `run.cancelled` |
| 6 | `CREATING` age limit | `CREATING` | `created_at < clock_timestamp() - $creating_age` re-evaluated **inside this UPDATE** | `FAILED` | `run.failed` |
| 7 | `RUNNING` stall | `RUNNING` | `last_append_at < clock_timestamp() - $stall` re-evaluated **inside this UPDATE** | `FAILED` | `run.failed` |
| 8 | Attempts exhausted | `CREATING` | `attempts >= $max` re-evaluated inside the `UPDATE` | `FAILED` | `run.failed` |
| 9 | Start-run item dead-letters | `CREATING` | the dead-letter record for this run exists | `FAILED` | `run.failed` |

**Cancellation precedence, and why it is a rule rather than a preference.** Rows
2, 4, 6, 7, 8 and 9 all write `FAILED`. Each must first re-check
`cancel_requested_at` *in the same statement*: if a cancellation is recorded, the
run terminalizes as `CANCELLED` instead. Without this an engine error can land
after the visitor pressed Stop and the transcript reports a failure the visitor
never caused — and worse, the drain then reads a `FAILED` run as an ordinary
outcome and starts the next answer against a conversation the visitor was trying
to interrupt.

**Re-evaluate, never observe-then-write.** Rows 6, 7 and 8 are the reaper paths,
and each is a fresh predicate inside the terminal `UPDATE`. A reaper that
`SELECT`s a stale `last_append_at`, waits on the row lock, and then writes
unconditionally will fail a run that became healthy while it waited — the same
observe-then-act shape §4.2 rejects for appends.

Each row's contention counterpart is a named test in TEST_STRATEGY §4.

### 3.3 Completion is atomic with the final answer

Row 1 says the `ai.final` append and the `COMPLETED` write happen in **one**
transaction. They were two in an earlier draft, and the gap between them is
visible to the visitor: a crash after `ai.final` commits leaves a `RUNNING` run
holding a complete, displayed answer, which the stall reaper then terminalizes as
`FAILED` — so the transcript shows a finished answer followed by a failure
notice.

Reconciliation, if the two ever are separated: a run may only be reaped while a
committed `ai.final` for it does **not** exist; if one does, the correct repair is
`COMPLETED`, not `FAILED`. And `CREATING → COMPLETED` is not a legal transition
at all — a run that never streamed cannot have completed.

### 3.4 Write-once handles, and the conflicting-handle case

The architecture requires that a *different* handle never overwrites the first,
and that both are retained and cancelled. A single scalar column cannot express
"both" — it can only hold the winner — so the pair of scalar columns an earlier
draft specified made the rule unimplementable as written.

```sql
CREATE TABLE engine_run_handles (
  run_id        uuid NOT NULL REFERENCES ai_runs(id),
  engine_run_id text NOT NULL,
  is_canonical  boolean NOT NULL,
  observed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, engine_run_id)
);
```

Append-only. The first handle observed for a run is inserted with
`is_canonical = true` and is also written to `ai_runs.engine_run_id`; that column
is never updated afterwards. Re-observing the same handle is a no-op (the primary
key makes the replay idempotent). Observing a **second, different** handle
inserts it with `is_canonical = false`, raises an alert, and enqueues cancel-run
for *both* — because two vendor runs exist and the design's whole premise is that
at most one should.

A conflicting handle means replay safety failed somewhere upstream, so the
alert matters as much as the cancellation. Tests cover: same handle twice
(idempotent), H1 then H2 (both recorded, both cancelled, alert fired), and
`ai_runs.engine_run_id` still holding H1.

## 4. The two primitives

Everything below is built from exactly two database operations. Reviewers should
be able to check any code path by asking which of the two it uses.

### 4.1 Primitive A — compare-and-set on control

```sql
UPDATE conversations
   SET status       = 'HUMAN_ACTIVE',
       mode_version = mode_version + 1,
       assigned_to  = $actor,
       taken_over_at = clock_timestamp()
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
   SET last_append_at   = clock_timestamp(),
       lease_expires_at = clock_timestamp() + $run_lease
 WHERE id                    = $run
   AND conversation_id       = $conversation      -- binds the two gated rows
   AND expected_mode_version = $expected_epoch    -- …and to the same epoch
   AND claim_epoch           = $my_claim_epoch
   AND cancel_requested_at IS NULL
   AND status                = 'RUNNING'
RETURNING id;

-- The epoch written on the event is the one RETURNED by step 1, never an
-- application argument that was not re-read under the lock.
INSERT INTO conversation_events
       (conversation_id, sequence, run_id, type, mode_version, payload, created_at)
VALUES ($conversation, $allocated_seq, $run, $type, $returned_epoch, $payload, clock_timestamp());

COMMIT;
```

Both gates are conditional writes, both take row locks held to commit, and they
are taken in the order §4.4 fixes. Either returning zero rows aborts the
transaction and appends nothing.

Three details in step 2 are load-bearing and easy to drop:

- **`conversation_id = $conversation` binds the two gated rows to each other.**
  Without it the statement fences *some* conversation and renews *some* run, and
  nothing says they are related — a token from run A could be appended to
  conversation B whenever their epoch numbers happen to coincide. Foreign keys
  do not catch this; both ids are individually valid. Add the matching composite
  constraint on `conversation_events` so the database rejects it too.
- **`expected_mode_version = $expected_epoch`** ties the run's own authorization
  to the epoch just verified, rather than trusting the caller to pass a matching
  pair.
- **`clock_timestamp()`, not `now()`.** In PostgreSQL `now()` is the
  *transaction start* time. A transaction that waits on a contended row lock for
  longer than the lease would commit a "renewal" that is already expired,
  instantly admitting a replacement worker — which is exactly the state §3.1's
  clock ordering exists to prevent. Every deadline in this document is sampled
  after the relevant lock is taken.

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
| System, in an epoch-changing transaction (T2, T3, T5) | all four, `CLOSED` included | **`$expected_epoch` is the epoch this transaction just wrote**, not the one it read on entry | — | `handoff.started`, `handoff.returned`, `conversation.closed` |
| System, otherwise (T4, T6, run lifecycle) | all four, `CLOSED` included | `$expected_epoch` is the conversation's **current** epoch, read in this transaction | — | `assignment.changed`, `run.stopped`, `run.completed`, `run.cancelled`, `run.failed` |

Every run status has exactly one terminal event type, because §5 requires one on
every path and §4.3's list is meant to become a check constraint — a status with
no type would abort the terminalization and wedge the run:

| Terminal status | Event | Written when |
|---|---|---|
| `COMPLETED` | `run.completed` | the engine's final message committed |
| `CANCELLED` | `run.cancelled` | every cancellation path: takeover, close, the cancel worker acting on a Stop, **and R1** — the worker abandoning a run before it created anything |
| `FAILED` | `run.failed` | engine error, exhausted attempts, dead-letter, or the stall reaper |
| *no status change* | `run.stopped` | T6 only: the visitor's Stop is *recorded* the moment it is requested. `run.cancelled` follows when the run actually ends, so a Stop legitimately produces two events — one acknowledging the request, one reporting the outcome |

One status, one terminal event, no exceptions — that is what makes the event-type
list safe to encode as a check constraint. There is deliberately no separate
`run.abandoned`: R1 ends in `CANCELLED` like every other cancellation, and a
second event name for the same status is how a constraint gets violated on a path
nobody tested.

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

The epoch rule in the third column is equally load-bearing and easy to miss, and
it splits the system class in two. T2, T3 and T5 bump `mode_version` **before**
appending, so passing the epoch read on entry would return zero rows and abort
the entire takeover. Everything else the system writes — reassignment, the
visitor's Stop, and every terminal run event — changes no epoch, so it passes the
current one. Guessing `mode_version + 1` there aborts silently, and the symptoms
are the ones this class exists to prevent: Stop appears to do nothing, and
terminal run events never land, so the widget waits forever.

The system class is also the most likely future route to a leak, since it is the
one class whose status set is wide.

**An event-type allowlist does not by itself keep it safe.** Primitive B inserts
an unrestricted JSON `payload`, so a permitted `run.failed` or `run.cancelled`
could legitimately carry a vendor error string containing the partial answer —
and that event is emitted by SSE *after* the takeover, because it is a system
event written in the new epoch. The name is on the allowlist; the text still
reaches the visitor.

So each system event type gets a **closed payload schema**, enforced at the
database write boundary rather than by the code that happens to build it today:

| Event | Payload |
|---|---|
| `handoff.started`, `handoff.returned` | actor id, timestamp |
| `assignment.changed` | new assignee id |
| `conversation.closed` | reason code |
| `run.stopped`, `run.cancelled`, `run.completed` | run id only |
| `run.failed` | run id and a normalized `error_category` from LLD-002 §6 — **a category, never a vendor message** |

No system payload has a free-text field. Assistant output has exactly one writer
class and one gate, and the negative test feeds a vendor error containing
recognisable answer text and asserts it never reaches the event log.

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
     │ every branch: set accepted_in_epoch = the epoch read above      │
     │     ◄─ REQUIRED. Left NULL, the drain's equality test never     │
     │        matches and the drain becomes a silent no-op, which in   │
     │        production reads as "typed a follow-up, got silence".    │
     │ if status = BOT_ACTIVE and no live run exists:                  │
     │     insert ai_runs (CREATING, operation_id, expected_mode_ver.) │
     │     set this message's answered_by_run = that run  ◄─ REQUIRED  │
     │     insert outbox 'start-run'                                   │
     │ if status = BOT_ACTIVE and a live run exists:                   │
     │     store the message with answered_by_run = NULL, start NO     │
     │     run, return "still answering".                              │
     │     The one-live-run index (§3) would otherwise raise a unique  │
     │     violation and roll back the whole transaction, losing the   │
     │     visitor's message — a failed POST instead of a queued one.  │
     │     This check is race-free, not merely narrow: TX1 holds the   │
     │     conversation lock, and the only other path that reserves a  │
     │     run — the drain below — holds it too. Any reserver that     │
     │     skipped that lock would race TX1.                           │
     │ if status = HANDOFF_REQUESTED or HUMAN_ACTIVE:                  │
     │     store the message only — a human will answer it             │
     └─────────────────────────────────────────────────────────────────┘
        The public request ends here. It never calls the engine.

Worker picks up 'start-run'
  ├─ claim the run and take a fencing token:
  │     UPDATE ai_runs
  │        SET claim_epoch = claim_epoch + 1,
  │            claimed_by = $worker,
  │            lease_expires_at = clock_timestamp() + $run_lease,
  │            attempts = attempts + 1
  │      WHERE id = $run
  │        AND status IN ('CREATING', 'RUNNING')   -- RUNNING is required:
  │            -- reclaiming a stalled streamer is the case claim_epoch exists
  │            -- for, and that run is RUNNING, not CREATING
  │        AND (claimed_by IS NULL OR lease_expires_at < clock_timestamp())
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
  │        claim_epoch AND cancel_requested_at IS NULL.
  │        Set last_append_at = clock_timestamp() here too — a run authorized
  │        and then wedged before its first token would carry NULL, and
  │        `last_append_at < clock_timestamp() - $stall` is never true of NULL,
  │        reaper would never see the commonest wedge of all.
  │     zero rows -> apply §5.1. Do NOT blanket-cancel.
  └─ stream engine events; append each via Primitive B (TX per event or small
     batch). The first zero-row append aborts the stream, then applies the SAME
     three-way branch as TX2b (§5.1) — it does NOT unconditionally cancel.

Sales POST /takeover
  └─ TX3: Primitive A; append handoff.started; set cancel_requested_at on live runs;
          enqueue cancel-run per run. One transaction, one linearization point.

Cancel worker
  └─ engine.cancelRun(handle) — idempotent; unknown/finished runs are success.
     Runs with engine_run_id NULL are reconciled by operation_id first.

     WHAT THIS CAN AND CANNOT DO depends on the engine (LLD-002 §7.1):

     • supportsOutOfBandStop = true (e.g. a Runs API with a stop endpoint):
       the worker really does stop a run another worker is streaming.

     • supportsOutOfBandStop = false (every OpenAI-compatible engine — in that
       protocol cancellation IS closing the connection, which only the owner
       can do): cancelRun cannot reach the stream. It records the request and
       returns honestly rather than pretending. The run stops because THE
       OWNING WORKER stops it — see below.

Owning worker, between streamed events
  └─ re-reads cancel_requested_at as part of the §4.2 step-2 fence it already
     runs per event. Zero rows there means cancelled, closed, or taken over, so
     it aborts its own AbortSignal and terminalizes. This is the mechanism that
     actually stops the model when out-of-band stop is unavailable, and it is
     already in the design — the fence term was there for the visitor's Stop
     button, and it does this job too.

     The residual gap is a worker that has DIED holding a stream. Nothing can
     abort its connection. The vendor finishes the run at its own pace, bounded
     by vendorMaxOutputTokens. That waste is bounded and belongs in the budget model;
     the visitor is unaffected, because the fence means none of it can commit.

Run terminalization (every path: completed, failed, cancelled, reaped)
  └─ TX, in this order — the lock order of §4.4 applies here too:
     1. append the terminal run event via Primitive B  (locks conversations)
     2. UPDATE ai_runs SET status = $terminal WHERE id = $run
          AND status IN ('CREATING','RUNNING')
          AND <the reason-specific term below>          ◄─ REQUIRED
        Zero rows = not ours to terminalize: ROLL BACK the whole transaction,
        including the event appended in step 1. Committing lands two terminal
        events for one run.

        A status-only CAS is NOT sufficient. It proves the run is live; it does
        not prove the caller still has the authority to end it. §3.2 is the
        **total** list of paths that may terminalize a run — if a code path is
        not in that table it has no right to write a terminal status.
     3. drain: if the conversation is BOT_ACTIVE, take the oldest visitor
        message (by `event_sequence`) with answered_by_run IS NULL **and
        accepted_in_epoch = the conversation's current epoch**, reserve a run
        for it, stamp its answered_by_run, and enqueue 'start-run'. The new
        run's expected_mode_version is the epoch returned by step 1.

        The epoch scope is not optional. Messages stored while a human was
        handling the conversation are also left unstamped — "a human will
        answer it" — and without the scope the first run to finish after
        control returns to the assistant would pick the globally oldest
        unstamped message and answer a question the salesperson dealt with
        two turns ago, out of order. T2 and T3 both change the epoch, so a
        message taken under human control can never be drained.

        **The orphan case, stated because it is a product decision and not an
        oversight:** a message queued behind a live run in epoch 1, followed by
        a takeover before that run ends, is never drained — the epoch it was
        accepted in is gone. The salesperson sees it in the transcript and
        answers it, which is why this is acceptable; a human is in the
        conversation precisely because one was asked for. What is not
        acceptable is silence, so the widget must show a queued message as
        awaiting a reply rather than as sent-and-handled, and returning control
        to the assistant does not resurrect it.

     The drain is what answers the message TX1 queued above; without it the
     visitor typed a follow-up mid-answer and got silence. `answered_by_run`
     is what stops it running away: every reserve path stamps it, so a
     message is drained at most once. Leave it unstamped and an ordinary
     one-message conversation loops forever — run completes, finds the same
     message unanswered, starts another.

     The one-live-run index is satisfied because the old run left the live
     set in step 2 of this same transaction.
```

### 5.1 What a lost fenced write means

Every fenced write in this document can return zero rows: TX2b, each streaming
append, and each terminalization. **All of them resolve it the same way**, and
the rule lives here once rather than being restated — and drifting — at each
site. On zero rows, re-read the current run and conversation state and branch:

| Observed | Meaning | Action |
|---|---|---|
| Epoch moved, or `cancel_requested_at` is set | Authority was genuinely lost — takeover, close, or Stop | Enqueue cancel-run. The vendor run is unwanted |
| Only `claim_epoch` moved, run still live | A successor worker legitimately owns this run and may be streaming it now | **Exit quietly. Enqueue nothing.** |
| Run already terminal, handle recorded | Someone finished it | Exit quietly; the cancel path already ran if it was needed |

The middle row is the one that costs money if it is got wrong, and it is not
hypothetical: worker 1 creates and records handle H, loses its lease; worker 2
claims a new `claim_epoch`, replay-safe-creates the *same* H and authorizes it;
worker 1's late write then loses on `claim_epoch` alone. Cancelling there kills
the answer worker 2 is actively streaming to the visitor.

"Zero rows means cancel" is the intuitive rule and it is wrong. Zero rows means
*this writer is not the authority any more* — which says nothing about whether
anyone else is.

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
  operation_id     uuid PRIMARY KEY,
  engine_run_id    text,
  state            text NOT NULL,    -- CLAIMED | CALL_IN_FLIGHT | CREATED | FAILED
  claimed_by       text,
  claim_token      uuid,             -- fresh per acquisition; NOT the worker id
  lease_expires_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
```

`claim_token` is the same fix as `ai_runs.claim_epoch`, and it was missing here
for one round because the earlier fix was applied to the instance in front of me
rather than to the class. `claimed_by` is a *reusable* worker identity: if the
same worker id reclaims the row after its own stalled invocation, a stale
invocation still satisfies `claimed_by = $worker AND lease_expires_at > clock_timestamp()`
and calls the vendor alongside the new one. A token minted fresh on every
acquisition cannot be satisfied by the invocation it replaced.

Every subsequent write by an invocation carries its token **and** the exact
state it expects to be leaving:

The lease and the token do different jobs, and conflating them strands handles:

```sql
-- (a) TAKING the risky step: CLAIMED -> CALL_IN_FLIGHT.
--     Lease liveness matters here, because this authorises a vendor call.
UPDATE engine_operations SET state = 'CALL_IN_FLIGHT'
 WHERE operation_id = $op AND claim_token = $my_token
   AND state = 'CLAIMED' AND lease_expires_at > clock_timestamp()
RETURNING operation_id;    -- zero rows = superseded; DO NOT call the vendor

-- (b) RECORDING what the vendor already did: CALL_IN_FLIGHT -> CREATED/FAILED.
--     Token + exact source state only. NO lease liveness term.
UPDATE engine_operations SET state = $next, engine_run_id = $handle
 WHERE operation_id = $op AND claim_token = $my_token
   AND state = 'CALL_IN_FLIGHT'
RETURNING operation_id;
```

**Why (b) must not require a live lease.** The vendor response can arrive after
the call lease has elapsed — that is the normal case for a slow create. If
recording required liveness, the response would be unrecordable, and
`CALL_IN_FLIGHT` is deliberately non-reclaimable (§7's terminal refusal), so the
operation would be stranded forever with a real vendor run behind it that nothing
can find or stop. Recording a fact the vendor has already established is not a
privileged action; issuing a *new* call is.

**Unknown and timeout outcomes stay `CALL_IN_FLIGHT`.** Only an outcome that
proves no vendor run exists may move to `FAILED` — a rejection with no run id, or
a lookup that authoritatively reports none. A network timeout proves nothing, and
treating it as failure is how a late vendor create becomes a duplicate.

**Reconciliation is lookup-only.** The reconciler may resolve a stranded
`CALL_IN_FLIGHT` by *looking up* the operation and recording what it finds, via
(b). It may never issue a create. A reconciler that can create is a second
creator, which is precisely what this layer exists to prevent.

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
-- $my_token is minted fresh for THIS invocation, never reused.
INSERT INTO engine_operations (operation_id, state, claimed_by, claim_token, lease_expires_at)
VALUES ($op, 'CLAIMED', $worker, $my_token, clock_timestamp() + $op_lease)
ON CONFLICT (operation_id) DO UPDATE
   SET state            = 'CLAIMED',
       claimed_by       = $worker,
       claim_token      = $my_token,
       lease_expires_at = clock_timestamp() + $op_lease
 WHERE engine_operations.engine_run_id IS NULL
   AND engine_operations.state <> 'CALL_IN_FLIGHT'
   AND engine_operations.lease_expires_at < clock_timestamp()
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
   AND claim_token      = $my_token      -- this invocation, not merely this worker
   AND state            = 'CLAIMED'      -- exact source state
   AND lease_expires_at > clock_timestamp()
RETURNING operation_id;     -- zero rows = superseded; do not call the vendor
```

Without those predicates the whole layer leaks: a worker that stalls past its
lease, gets superseded, and then wakes up would write `CALL_IN_FLIGHT` and call
the vendor anyway, producing the second run this layer exists to prevent. Note
that `claimed_by` alone does not close it — the same worker id can hold the
replacement lease, so a stalled invocation would still match. The token is what
distinguishes the invocation from its replacement.

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
  `CANCELLED` — within the `CREATING` age limit if it never started, within the
  stall limit after its last append if it did — and produces at most one vendor
  run.
- **I11** A visitor message accepted in an epoch where the assistant may write is
  assigned to at most one run, whose outcome is an answer, a terminal error, or a
  cancellation — **unless control leaves that epoch first**, in which case it is
  never assigned to any run. No message is assigned twice, and no message
  accepted under human control is ever assigned to a run.
- **I5** A run that fails a fenced write has its `engine_run_id` already
  recorded, and the failing transaction resolves it by §5.1's branch: it enqueues
  cancellation **only** when authority was genuinely lost or a cancellation is
  already recorded. A write that lost only to a newer `claim_epoch` enqueues
  nothing, because a live successor is serving that run.
- **I6** No assistant-authored event is *committed* at a sequence after a
  committed `handoff.started` of a later epoch. This is a statement about the
  event log, not about pixels: events committed before the handoff are still
  delivered, and may render shortly after it (§1).
- **I7** After a cancellation is recorded — by takeover, by close, or by the
  visitor's Stop — no further assistant-authored event is committed, regardless
  of whether the vendor stop call succeeds, **and regardless of whether the
  engine has an out-of-band stop at all**. A failed or impossible stop raises a
  cost and observability alarm only. This invariant is carried by the §4.2
  fence, never by the engine's cooperation.
- **I8** A replayed visitor POST with the same idempotency key produces zero
  additional runs and zero additional messages.
- **I9** At most one run per conversation is in `CREATING` or `RUNNING`.
- **I10** A worker whose lease expired and was reclaimed cannot commit an event:
  its `claim_epoch` no longer matches.

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| Vendor stop endpoint fails, or the engine has no out-of-band stop at all | The fence still blocks all output (I7) — `cancel_requested_at` is a fence term, not just a work item. The owning worker aborts itself at its next append. Retry with backoff; alert on repeated failure; the visitor is unaffected. |
| Owning worker dies holding a stream, engine has no out-of-band stop | Nothing can abort that connection. The vendor completes the run and bills for it, bounded by `vendorMaxOutputTokens`. Correctness is untouched: the run's `claim_epoch` is stale, so not one byte of it can commit (I10). Record the bound in the budget model. |
| Worker crashes mid-stream | The lease expires and the run is terminalized as `FAILED` — by a reclaiming worker or by the stall reaper, whichever arrives first, and the CAS in §5 makes sure only one of them does it. The zombie cannot commit (I10). The visitor sees an interrupted answer and a retry affordance. |
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
