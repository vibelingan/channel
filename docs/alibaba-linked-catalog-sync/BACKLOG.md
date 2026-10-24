# Backlog — known gaps, deliberately deferred

Recorded rather than patched. Each entry says what breaks, when it starts
mattering, and roughly what the fix is. Nothing here blocks the test
deployment or the first Connect.

## Blocks production, not test

### B1 — Sync never runs automatically (single live environment)
**Re-scoped 2026-08-07 — see ARCHITECTURE §14.1.** The original entry assumed a
missing *production* deploy. There is no separate production environment: the
one environment, `diversity-123-d9grnqfux221323bb`, serves the live site.

Because the deploy hard-fails on any function trigger, sync runs ONLY when an
operator clicks "Run now". That is a deliberate choice for the first rollout,
not an oversight — but it must be an explicit decision to change, and it needs
both halves at once: apply the desired timer in the deploy AND flip the
assertion from "no triggers" to "exactly the desired trigger".

<details><summary>Original framing (superseded)</summary>

#### There was no production deployment at all
The 15-minute timer that drives sync in production is written down
(`PRODUCTION_DESIRED_TIMER_TRIGGERS` in `scripts/cloudbase-function-manifest.mjs`)
but **nothing applies it** — that constant is referenced only by a test, and
there is no production deploy workflow in `.github/workflows/`.

Test deliberately has no timer: the deploy fails if it finds one, so "Run now"
is the only driver there. That is by design and fine for now.

*Needed before production:* a deploy workflow that applies the timer trigger
and asserts it afterwards, mirroring how the test deploy asserts its absence.

</details>

### B2 — The apply phase walks the whole catalog in one pass
The phase that writes supplier prices onto your products reads every mirrored
product in one run, with no saved position. It renews its lease as it goes, so
it does not get cut off, but nothing splits it across runs.

Fine at test scale. At the ~5,000 products the design targets, one pass is
thousands of database round-trips and will approach the function's 900-second
ceiling.

*Fix:* give the phase a saved position (the walk is already ordered by id, so
storing the last id processed is enough) and let it resume on the next run.
This was attempted once and reverted — a resume exit without a saved position
made the phase restart forever. Do the position first, then the exit.

## Correctness, low frequency

### B3 — One kind of flagged batch can never be approved
When a run cannot confirm that a product really disappeared from the supplier
(a network blip during the removal-confirmation step), it flags the batch for
review — but that path does not record the fingerprint the approval screen
compares against. Approval therefore always answers "superseded" and the batch
sits forever.

Pre-existing since the runner was written. Harmless today: it does not block
anything else, and a later run supersedes it. It only means the operator sees
a stuck row.

*Fix:* record the fingerprint on that branch the way the other flagging branch
already does, **or** treat a failed confirmation as retryable rather than
immediately flagging the batch.

## Observability

### B4 — Log lines do not carry the run id
Function logs go to the Tencent console, but nothing ties one run's lines
together, so reading the story of a single run means eyeballing timestamps.

*Fix:* a small logging helper that prefixes the active run id.

### B5 — No dashboard, error tracker, or log search
Beyond the Tencent console and the run table in the admin page, there is
nothing. Acceptable while the catalog is small and runs are manual.

*What exists and is genuinely useful:* every run writes a row (status,
counters, one-line error summary), and **every raw supplier response is stored
keyed by a hash of its bytes** — so any "this price looks wrong" question can
be answered by reading exactly what Alibaba sent.

### B6 — The token exchange is the least instrumented step
Token responses are deliberately never stored — storing them would mean
storing credentials. So when Alibaba rejects the exchange, the evidence is the
redirect reason code plus whatever reached the logs.

*Fix, without ever logging token material:* log the HTTP status and the
gateway's error code (not the body) on that path.

## Admin UX

### B7 — The mirror is not browsable from the dashboard
The ops page asks the operator to link a product by its source key, but there
is no screen listing source keys. Adding the two mirror tables to the nav was
tried and reverted: they are marked hide-from-nav by contract, and the generic
table screen renders New/Edit/Delete buttons that can only fail on a read-only
table.

*Fix:* a read-only picker on the ops page itself, not a nav entry.
