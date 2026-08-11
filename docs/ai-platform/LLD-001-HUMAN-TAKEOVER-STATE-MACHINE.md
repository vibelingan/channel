# LLD-001: Human Takeover State Machine and Ordered Event Fence

**Status:** Proposed; specifies §8 of [CHANNEL_AI_ASSISTANT_ARCHITECTURE.md](./CHANNEL_AI_ASSISTANT_ARCHITECTURE.md)
**Owning architecture:** Channel public AI assistant
**Depends on:** [ADR-001](./ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md) "Human Handoff Consistency Decision"
**Diagrams:** `.claude/diagrams/lld-state-conversation-control.excalidraw`, `.claude/diagrams/lld-sequence-human-takeover.excalidraw`
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

The two mechanisms that deliver this:

1. **Control version** — a counter on the conversation that changes every time
   control moves between the assistant and a human. Every AI write carries the
   version it was authorized under, and a write whose version is stale is
   rejected by the database, not by the application's good intentions.
2. **Ordered event log** — the visitor's stream is fed only from committed,
   sequentially numbered rows. Nothing reaches the browser that did not first
   survive the version check.

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
| `conversations.mode_version` | integer, starts at 1 | Incremented on **every** transfer of control between AI and human |
| `conversations.next_event_seq` | bigint, starts at 1 | Next sequence number to hand out; allocated only under the row lock |
| `conversations.assigned_to` | user id, nullable | Current human owner |
| `ai_runs.expected_mode_version` | integer | The version this run was authorized under |

`HANDOFF_REQUESTED` does **not** increment `mode_version`, because control has
not moved yet. It changes one thing: **no new AI run may be reserved.** A run
that is already in flight is allowed to finish, so a visitor who clicks *talk to
a human* mid-answer sees that answer complete rather than stop mid-sentence.
A further visitor message in this state is stored and shown to the salesperson,
but starts no run.

Control moves, and the version increments, only on `HUMAN_ACTIVE` and on an
authorized return to `BOT_ACTIVE`.

### 2.3 Transition table

| # | From | To | Actor | Guard | Same-transaction effects |
|---|---|---|---|---|---|
| T1 | `BOT_ACTIVE` | `HANDOFF_REQUESTED` | visitor | status is `BOT_ACTIVE` | append `handoff.requested`; enqueue sales notification; **no new run may be reserved from here on**, in-flight run may finish |
| T2 | `BOT_ACTIVE`, `HANDOFF_REQUESTED` | `HUMAN_ACTIVE` | sales | status in set **and** `mode_version = expected` | `mode_version += 1`; set `assigned_to`, `taken_over_at`; append `handoff.started`; mark all live runs `CANCEL_REQUESTED`; enqueue one cancel-run outbox item per live run |
| T3 | `HUMAN_ACTIVE` | `BOT_ACTIVE` | sales (explicit) | status is `HUMAN_ACTIVE` **and** caller is assignee or admin | `mode_version += 1`; clear `assigned_to`; append `handoff.returned` |
| T4 | `HUMAN_ACTIVE` | `HUMAN_ACTIVE` | sales (reassign) | caller is assignee or admin | change `assigned_to`; append `assignment.changed`; **no** version change |
| T5 | any non-terminal | `CLOSED` | visitor, sales, or retention job | status ≠ `CLOSED` | `mode_version += 1`; append `conversation.closed`; mark live runs `CANCEL_REQUESTED`; enqueue cancels; start retention clock |

T4 does not change the version because control did not move between AI and
human — one salesperson handed to another, and no AI run's authorization
changed. T5 increments because closing revokes the assistant's authorization to
write, and the same fence must reject a late-arriving token.

## 3. Run model

```text
CREATING ──► RUNNING ──► COMPLETED
   │            │
   │            ├──────► FAILED
   │            │
   └────────────┴──────► CANCELLED
```

| `ai_runs` field | Purpose |
|---|---|
| `id` | Internal run id (the only id the public API exposes) |
| `operation_id` | Stable, deterministic id sent to the engine so a replayed create returns the same run |
| `engine_run_id` | The vendor's run id; `NULL` until registration succeeds |
| `expected_mode_version` | The control version this run was authorized under |
| `status` | `CREATING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| `cancel_requested_at` | Set by takeover/close even if `engine_run_id` is still `NULL` |
| `error_category` | Normalized category from the engine port (see [LLD-002](./LLD-002-CONVERSATION-ENGINE-INTERFACE.md) §6) |

`operation_id` is derived deterministically from the run row (`uuidv5` of the run
id under a fixed namespace), so a retried outbox delivery computes the same value
without storing extra state.

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

Every visitor-visible byte goes through this, inside one transaction:

```sql
-- 1. take the conversation row lock; this is the linearization point
SELECT status, mode_version, next_event_seq
  FROM conversations
 WHERE id = $conversation
   FOR UPDATE;

-- 2. the fence: abort unless the writer's authorization is still current
--    (application-side check on the row just locked)
--    AI writer   : require mode_version = run.expected_mode_version
--                  AND status IN ('BOT_ACTIVE', 'HANDOFF_REQUESTED')
--                  -- HANDOFF_REQUESTED is included so an in-flight answer can
--                  -- finish; it blocks new runs, not the current one, and the
--                  -- version is unchanged so no control has moved
--    human writer: require status = 'HUMAN_ACTIVE' AND assigned_to = actor

-- 3. allocate the sequence and append
UPDATE conversations
   SET next_event_seq = next_event_seq + 1
 WHERE id = $conversation;

INSERT INTO conversation_events
       (conversation_id, sequence, type, mode_version, payload, created_at)
VALUES ($conversation, $allocated_seq, $type, $mode_version, $payload, now());
```

Because both Primitive A and Primitive B take the same row lock, a takeover and a
token append can never overlap — one of them is second, and if the second is the
AI writer, its fence check fails and its transaction aborts. This is the whole
design. Everything else is bookkeeping around it.

**Forbidden shapes.** Read status, then `res.write()`. Read status, then a
non-conditional `UPDATE`. Filter old events in the browser only. Ask the model to
stop in a prompt. Each of these has a window where a token escapes.

## 5. Required sequence for one visitor message

```text
Visitor POST /messages
  └─ TX1 ─────────────────────────────────────────────────────────────┐
     │ lock conversation; reject if CLOSED                             │
     │ insert conversation_messages (unique on conversation +          │
     │   idempotency_key — a retried POST is a no-op, not a second run)│
     │ append visitor message event via Primitive B                    │
     │ if status = BOT_ACTIVE:                                         │
     │     insert ai_runs (CREATING, operation_id, expected_mode_ver.) │
     │     insert outbox 'start-run'                                   │
     │ if status = HANDOFF_REQUESTED or HUMAN_ACTIVE:                  │
     │     store the message only — a human will answer it             │
     └─────────────────────────────────────────────────────────────────┘
        The public request ends here. It never calls the engine.

Worker picks up 'start-run'
  ├─ claim the run row conditionally (CREATING -> CREATING, claimed_by, lease)
  ├─ re-read conversation: still BOT_ACTIVE and mode_version unchanged?
  │     no  -> mark run CANCELLED, drop the outbox item, done
  ├─ engine.createRun({ operationId, ... })          [external, replay-safe]
  ├─ TX2: register engine_run_id CONDITIONALLY on the same mode_version
  │     success -> status RUNNING
  │     fence lost -> leave CANCEL_REQUESTED, enqueue cancel-run, stop streaming
  └─ stream engine events; append each one via Primitive B (TX per event or
     per small batch). First failed fence aborts the stream and requests cancel.

Sales POST /takeover
  └─ TX3: Primitive A; append handoff.started; mark live runs CANCEL_REQUESTED;
          enqueue cancel-run per run. One transaction, one linearization point.

Cancel worker
  └─ engine.cancelRun(handle) — idempotent; unknown/finished runs are success.
     Runs with engine_run_id NULL are reconciled by operation_id first.
```

## 6. The four race windows

The architecture names four points where takeover can land. Each is closed by a
specific mechanism, and each has a named test in
[TEST_STRATEGY.md](./TEST_STRATEGY.md) §4.

### R1 — Takeover before the run is created

The worker's re-read (step 2 of the start-run handler) sees `HUMAN_ACTIVE` or a
bumped version and abandons the run before any external call. **No engine run
exists.** Cost of the race: one wasted worker cycle.

### R2 — Takeover between external creation and registration

The run exists at the vendor but the BFF has not recorded its id. Registration is
conditional on the version, so it fails. The run row keeps
`cancel_requested_at`, and a cancel-run item is enqueued carrying the
`operation_id`. The cancel worker resolves `operation_id → engine_run_id`
(§7) and stops it.

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

**If it does not** — interpose a persistent operation-id mapping adapter, and the
port's capability descriptor must report `supportsIdempotentCreate: false` so the
BFF refuses to run without the adapter present. The adapter owns one table:

```sql
CREATE TABLE engine_operations (
  operation_id   uuid PRIMARY KEY,
  engine_run_id  text,
  state          text NOT NULL,      -- INTENT | CREATED | FAILED
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

Order of operations, and why: write `INTENT` **before** the external call
(`ON CONFLICT DO NOTHING`; a row that already has `engine_run_id` short-circuits
and returns it), then create the run tagging it with the operation id in vendor
metadata, then update to `CREATED`. A crash between the call and the update
leaves an `INTENT` row and a possibly-orphaned vendor run; a startup reconciler
lists vendor runs, matches the metadata tag, and completes or stops them.

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
- Sequence allocation happens only under the row lock, so the log is gapless.
  A gap means a transaction committed the sequence bump without the insert, which
  is impossible in one transaction and is therefore an integrity alarm.

## 9. Invariants

These are the statements tests assert. Each is falsifiable and each has a test in
TEST_STRATEGY.md §4.

- **I1** For one conversation, `sequence` values are unique, strictly increasing,
  and gapless.
- **I2** If `handoff.started` commits at sequence *N* with version *V+1*, no event
  written by a run whose `expected_mode_version ≤ V` exists at a sequence > *N*.
- **I3** Under concurrent takeover attempts, exactly one succeeds; every other
  caller receives a conflict naming the current owner.
- **I4** Every run that reaches `CREATING` ends in `COMPLETED`, `FAILED`, or
  `CANCELLED` — never indefinitely `CREATING` — and produces at most one vendor
  run.
- **I5** A run whose registration lost the fence has a cancel request recorded in
  the same transaction that rejected it.
- **I6** No assistant-authored event is visible to the visitor at a sequence
  after a committed `handoff.started` of a later version.
- **I7** A failed vendor stop call never allows a visitor-visible byte; it raises
  a cost and observability alarm only.
- **I8** A replayed visitor POST with the same idempotency key produces zero
  additional runs and zero additional messages.

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| Vendor stop endpoint fails | Fence still blocks all output (I7). Retry with backoff; alert on repeated failure; the visitor is unaffected. |
| Worker crashes mid-stream | Lease expires; run is reclaimed or marked `FAILED`; the visitor sees an error event and a retry affordance. |
| Database unavailable | Fail closed. No streaming, no run creation; widget falls back to the inquiry form. |
| Engine unavailable | Run is `FAILED` with a normalized category; the visitor is offered a human or the inquiry form. |
| Takeover arrives for a `CLOSED` conversation | Primitive A returns zero rows; the API returns a conflict. |
| Clock skew between BFF and workers | No logic depends on wall-clock ordering; ordering comes from the sequence, and leases use database time. |

## 11. Open questions this design does not settle

1. Whether the pinned engine release supports replay-safe create, run metadata
   tagging, and run listing (gate 7; determines whether §7's adapter is needed).
2. Whether the operational store is CloudBase PostgreSQL over the `pg` protocol
   or database-side RPCs — ADR-001 §"Human Handoff Consistency Decision" requires
   live verification in the target environment, and **the repository has no
   PostgreSQL dependency today**. Every `SELECT … FOR UPDATE` above assumes a
   transactional store; a NoSQL fallback would need a different primitive and a
   new ADR.
3. Whether a returned-to-AI conversation replays prior human messages to the
   model as context, and under what redaction rule.
4. The retention rule for events belonging to cancelled runs.
