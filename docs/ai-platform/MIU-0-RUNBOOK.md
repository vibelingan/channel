# MIU 0 — What has to exist before the AI assistant can be built

**Short version: production still needs five external resources or decisions,
but local implementation does not wait for a long-term database purchase.
Develop against PostgreSQL 16 in Docker and CI; buy bounded cloud integration
time only when the real network path must be proven.**

This page is the shopping list. The technical steps are further down; read them
only if you want to.

---

## The five things

### 1. A database — PostgreSQL retained, purchase timing revised 2026-08-17

**Do NOT buy anything for this until you have read the fork below.**

CloudBase offers PostgreSQL, but two facts from Tencent's own documentation rule
out the obvious route:

1. *"PG mode is selected when creating a new CloudBase environment with
   PostgreSQL."*
2. *"Legacy environments cannot be upgraded in place to PG mode."*

Your current environment is the NoSQL kind. It cannot be converted. So the
"just switch on PostgreSQL" option does not exist.

CloudBase documents two valid ways to perform a multi-statement transaction:
encapsulate it in a database RPC function, or use a server-side PostgreSQL
protocol connection. The target environment must prove which path it exposes.
An HTTP-only path does not implement this LLD by changing a connection string;
it moves the transaction boundary into database functions and needs a reviewed
store implementation.

**Option A — a second CloudBase environment, in PostgreSQL mode**
- A new environment (your existing one keeps running untouched).
- This Tencent account may be eligible for one free-experience environment with
  3,000 resource points/month, but eligibility and renewal are account-specific
  and must be confirmed. It is not a promised second free environment.
- If a normal server-side PostgreSQL connection exists and `S0-S11` passes, the
  current store and SQL remain reusable. If only HTTP/RPC is available, the
  handover transaction must be implemented as database functions and reviewed.
- Useful as an optional no-real-PII development sandbox. It does not prove the
  final CloudRun-to-TencentDB VPC path.

**Option B — a normal Tencent Cloud PostgreSQL database, plus CloudRun — RECOMMENDED**
- 云数据库 PostgreSQL is a separate Tencent product from CloudBase. It gives you
  an ordinary database connection.
- The design works exactly as written. No redesign.
- My checking script runs against it unchanged, so you get a PASS/FAIL in
  seconds rather than a guess.
- Your existing CloudBase environment is untouched.
- Supports pay-as-you-go for a bounded cloud integration window and a long-term
  plan when the customer pilot begins.

Buy page: https://buy.cloud.tencent.com/price/pgsql. Quote the entry and next
practical configurations; traffic, connections, retention, storage, RPO and RTO
have not yet proved that the smallest SKU is sufficient.

**What to return once it exists:** non-secret instance id, private host, port,
database name, VPC id, subnet id and secret names. Put credentials directly in
the approved secret manager; do not send passwords or connection strings in
chat, email or command-line arguments. Use a disposable probe role and a
separate least-privilege runtime role.

**Why this fork was foreseeable:** ADR-001 already recorded that CloudBase's
PostgreSQL SDK exposes no full transaction API, and that the server would
therefore need either a direct database connection or in-database functions —
"具体路径必须在目标环境 live-verify". This is that verification, done.

### 2. A place to run the assistant's own server — platform proof done 2026-08-16

**Status:** CloudRun activated and proven. A throwaway service deployed, served
HTTP 200, and streamed server-sent events correctly through the gateway. See
`evidence/P3-runtime-and-routing.md`.

**Selected service:** CloudRun in ap-shanghai.
**Why:** the assistant needs services of its own, separate from the
existing website functions. It holds the conversation, decides what the AI is
allowed to say, and manages the handover to a salesperson.

**Closed runtime choice.** CloudRun is the production runtime for the full BFF +
worker design. The live gateway is SSE-proven and the container/VPC/scale
boundaries match the LLD. Local Docker Compose is the development substitute;
future agents do not reopen runtime selection inside an MIU. Any replacement
requires a new ADR with equivalent evidence.

**Local parity target:** MIU 2a will add Docker Compose for the BFF and workers
as ordinary containers with PostgreSQL 16. Once built, it reproduces process
lifecycle, ports, health checks, environment variables, SSE and graceful
shutdown. It does not reproduce
CloudRun's managed gateway, CORS edge, scale-to-zero cold start, VPC attachment,
resource limits or billing; those remain deployed integration tests.

**CloudRun cost:** published rates are `0.055 yuan/core-hour`, `0.032
yuan/GiB-hour`, and `0.8 yuan/GB` internet egress. One continuously warm
`0.25 core + 0.5 GiB` instance is about `21.72 yuan/month` compute-only; one
`1 core + 2 GiB` instance is about `86.87 yuan/month`. `minNum=0` can scale to
zero for low-traffic development, reducing compute at the cost of cold starts.
The existing Standard-plan resource-point deduction, logs and traffic must be
confirmed on the actual bill. Therefore CloudRun is not automatically "hundreds
per month", but neither is activation proof a zero-cost production approval.

### 3. A brand-new Lexiang (腾讯乐享) knowledge space

**What to get:** a **separate, new** space in Lexiang, containing only material
you would be happy for any stranger on the internet to read. Plus a token for
it that can read that space and nothing else.
**Where:** the Lexiang console.

**This is not your existing space, and not a folder inside it.** It has to be
genuinely separate, because the whole safety of this feature rests on it. A
stranger typing into the chat box causes a search against your company
knowledge. If that search can reach internal material — supplier contracts,
costs, customer projects — it eventually will.

**What to return:** the space identifier, the non-secret AppKey identity, the
Secret Manager reference for AppSecret/access-token minting, and the id of one
real *internal* document for the scheduled negative-access proof. Never send the
AppSecret or access token through chat or email.

**Serving credential correction:** the proven Hermes configuration uses a
Lexiang MCP URL plus an `lxmcp_...` bearer credential. A REST AppKey/access token
does not automatically establish the scope of that MCP credential. Return the
non-secret MCP credential id, MCP URL, MCP preset/tool schema, space id and its
Secret Manager reference. Keep REST AppKey evidence only for administration and
documented API probes.

**No local Lexiang installation.** For ordinary development:

- The existing `FakeEngine` supplies deterministic successful streams,
  citations, transport failures, timeout and overlong-output cases.
- MIU 5a/integration work adds grounded-policy, empty-knowledge and unavailable
  fixtures; they are not implemented yet.
- MIU 4 creates the local stub Hermes HTTP server and sanitized recorded frames;
  that artifact is not implemented yet.
- Running local Hermes against a test-only public MCP credential is optional
  manual integration, not a prerequisite for every developer.
- Real Lexiang is required in shared staging for K1-K5, the golden-set
  evaluation, and the production pre-traffic gate.

**Production configuration:** the pinned Hermes profile contains exactly one
approved Lexiang MCP server. Its URL, bearer secret reference, timeouts and
read-only `tools.include` list are versioned with the profile. The profile's
non-secret attestation identifies the serving credential/space/rotation. A
missing MCP credential fails startup readiness. If the serving credential
cannot pass K1-K5, gate 2 remains blocked; do not switch transport during
implementation.

### 4. A running Hermes server with a fixed version

**What to get:** Hermes deployed somewhere I can reach, pinned to one exact
version (not "latest").
**Why pinned:** Hermes ships new abilities frequently. Some of them — running
commands, reading files, browsing — would be dangerous on a service an
anonymous visitor can talk to. We check the exact list once and freeze it.
**What to return:** the private URL, pinned version and digest, profile id, and
the Secret Manager reference for the API key. Never send the API key through
chat or email.

**Note:** your original prototype ran Hermes locally. That proved the idea
works; it is not a server customers can use.

### 5. A model provider account, with the paperwork done

**What to get:** a key on **zenmux**, the OpenAI-compatible provider the existing
Hermes bot already uses (per `HERMES_OPS_SOP.md`), a monthly spending cap, and the data-processing
terms agreed by whoever handles legal for you.
**Why the paperwork:** visitor messages will be sent to this provider. Someone
has to have agreed to that in writing before it happens.

---

## Things only a person can decide

No test settles these, and the work stalls on them just as hard as on a missing
account. Each needs a name against it.

| Decision | Who decides |
|---|---|
| Where salespeople actually work the chat queue | Sales lead |
| Which channel notifies them of a waiting customer | Sales lead |
| Monthly spending cap for the AI | You |
| Which languages the assistant supports (site is English-only today) | You |
| The list of questions and answers it is allowed to use | You |
| Consent wording, and how long chat transcripts are kept | You + legal |
| Which country the data is stored in | You + legal |

---

## Where things stand right now

| | Status |
|---|---|
| The engine boundary (MIU 1) | **Built, tested, pushed.** 43 tests pass |
| Local/CI database | PostgreSQL 16 is the required development baseline; no long-term cloud purchase required |
| Target database check | **Script written and proven** — run again through the real CloudRun-to-target path before pilot |
| External credentials and policy gates | Outstanding; they block public traffic, not every local MIU |

The engine port and local operational core can proceed. Public integration and
release remain blocked by the external accounts, network and human decisions.

---

## What I would do first, if it were me

Have MIU 2a create the named Docker Compose stack and CI PostgreSQL service,
then bring them up, apply the real migrations, and run the full race suite. When the BFF is ready for cloud
integration, open a pay-as-you-go TencentDB instance for a bounded test window,
attach CloudRun to its VPC/subnet, run `S0-S11` and end-to-end tests, then release
it. Buy a long-term instance only at the customer-pilot gate after sizing.

---

---

## How to read this

Each item states **who can do it**. That matters more than the order:

| Marker | Meaning |
|---|---|
| 🤖 | An agent can run it unattended once credentials exist |
| 🔑 | Needs a credential or console access only you have |
| 🧑 | A **decision**. No probe closes it; a named human must choose |

**Run P0 first locally and in CI, then repeat it against every cloud candidate
and finally through the deployed production-shaped path.** A local PASS proves
the code and reference PostgreSQL semantics; it does not prove VPC, TLS, pooling
or the managed target.

---

# P0 — The store probe (do this before anything else)

## Why this one is first

LLD-001's entire takeover design rests on a single database behaviour: a
conditional `UPDATE … WHERE <predicate> RETURNING …` that, having waited on a
row lock, returns **zero rows** when the predicate has since become false —
rather than raising, or succeeding against stale data. That is what makes a
salesperson's takeover beat an in-flight AI token deterministically.

If the target store cannot do it, the design does not survive contact. 14 of 17
MIUs change, and ADR-001 reopens. Finding that out now costs an afternoon;
finding it out in week nine costs the plan.

## The tool

`scripts/probe-ai-store.mjs`, in this repo. **It has been verified against real
PostgreSQL 16**, and verified to go red against a non-conforming store (a server
pinned to `REPEATABLE READ`) — so a PASS from it means something.

### Step 1 — 🤖 Establish the baseline (2 minutes, no credentials)

Prove the probe works on a store you already trust before pointing it at the one
you are judging. Otherwise a FAIL is ambiguous between "bad store" and "bad
probe".

```bash
docker run -d --name miu0-pg --rm \
  -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=probe -p 55432:5432 postgres:16
sleep 5
node scripts/probe-ai-store.mjs --url postgres://postgres:probe@localhost:55432/probe
```

**Expected:** `VERDICT: PASS`, all of S0–S11 green.
If this fails, the probe or your Node/docker setup is wrong — fix that first.

### Step 2 — 🤖 Prove the probe can fail (1 minute)

```bash
docker exec miu0-pg psql -U postgres -d probe \
  -c "alter database probe set default_transaction_isolation='repeatable read';"
node scripts/probe-ai-store.mjs --url postgres://postgres:probe@localhost:55432/probe
# expected: VERDICT: FAIL, naming S1 and S4
docker exec miu0-pg psql -U postgres -d probe \
  -c "alter database probe reset default_transaction_isolation;"
docker stop miu0-pg
```

A probe nobody has watched fail is a probe nobody has verified. Record both
outputs in the evidence file — the PASS *and* the deliberate FAIL.

### Step 3 — 🔑 Point it at the real candidate

You need a PostgreSQL connection string for whichever runtime you intend. The
architecture names three candidates; probe whichever you can obtain first, and
record which you probed:

```bash
# CloudBase PostgreSQL, or CloudRun + managed PG, or a self-managed instance
PGURL="$AI_PROBE_DATABASE_URL" node scripts/probe-ai-store.mjs --json \
  > docs/ai-platform/evidence/store-probe-$(date +%Y%m%d).json
```

Provision the connection secret directly in the execution environment. Do not
place it in shell history or process arguments. It must be the
**environment you intend to serve from**, not a local stand-in — pooling and
isolation defaults are exactly what differ.

### Step 4 — Read the verdict

| Result | What it means | Next |
|---|---|---|
| `PASS` | Every behaviour LLD-001 needs is present | MIU 2a may proceed. Record the JSON |
| `FAIL` on **S1 only** | Isolation defaults to something other than READ COMMITTED | Usually fixable: pin `READ COMMITTED` at connection setup, re-probe. If it cannot be pinned, treat as S4 |
| `FAIL` on **S4** | A blocked conditional update raises instead of returning zero rows | **STOP.** This is the design-invalidating case |
| `FAIL` on S5 | Rollback does not restore the counter | The gapless-sequence invariant (I1) needs redesign |
| `FAIL` on S7/S8/S9 | Missing partial indexes / `ON CONFLICT … WHERE` / composite FKs | Each has a fallback, but each costs a redesign of the unit that used it |
| exit 2 | Could not connect | Not a verdict. Fix connectivity and re-run |

### If S4 fails — the escalation, written now so nobody improvises later

1. Do **not** write MIU 2c schema. Do not "work around it in the application" —
   an application-side check between a read and a write is the exact
   anti-pattern LLD-001 §4.2 rejects.
2. Reopen ADR-001. The decision to reconsider is the operational store, not the
   takeover design — the takeover design is downstream of it.
3. Options to evaluate, in the ADR: a different managed PostgreSQL; the `pg`
   protocol directly rather than an SDK that wraps it; database-side RPCs that
   encapsulate the conditional write; or a fundamentally different concurrency
   primitive with its own LLD.
4. Named decision owner and re-plan budget. MIU 1 and the widget survive; the
   operational core, public API, and sales surface all need re-design.

---

# P1 — Engine contract probes 🔑

**Blocks:** MIU 4 (adapter), and gate 7. Needs a running pinned Hermes you can
reach. No script is provided for these because they are plain HTTP and a
hand-run `curl` you can read beats a script you have to trust.

## E1 — Pin the release and digest

```bash
docker pull <hermes-image>:<tag>
docker inspect --format='{{index .RepoDigests 0}}' <hermes-image>:<tag>
```

**Record:** the exact tag *and* the `sha256:` digest.
**Rule:** never deploy `latest` or `main`. The digest is what the deploy gate
pins against, and what every run row records for incident scoping.

## E2 — Capture the actual tool surface

```bash
curl -sS -H "Authorization: Bearer $HERMES_KEY" \
  "$HERMES_URL/v1/toolsets" | tee evidence/toolsets-raw.json | jq .
```

**Record:** the complete response, verbatim, under the **restricted
customer-service profile** — not the default profile. If the response is not
scoped to a profile, record that fact: it means SECURITY.md §5's assertion has
no subject and the gate needs re-designing.

**Read it for:** anything in the denied list — terminal, process execution, file
read/write, patching, browser control, code execution, delegation, cron, memory
management, skill management, messaging. Each one present on a profile an
anonymous visitor can reach is a remote-code-execution path with extra steps.

**Also capture the MCP server list**, which is a second tool surface the
toolsets endpoint may not cover.

## E3 — Runs create replay semantics (gate 7)

The question: does creating twice with one operation id yield **one** run?

```bash
OP=$(uuidgen)
curl -sS -X POST "$HERMES_URL/v1/runs" -H "Authorization: Bearer $HERMES_KEY" \
  -H 'content-type: application/json' \
  -d "{\"operation_id\":\"$OP\", ...}" | tee run-1.json
curl -sS -X POST "$HERMES_URL/v1/runs" -H "Authorization: Bearer $HERMES_KEY" \
  -H 'content-type: application/json' \
  -d "{\"operation_id\":\"$OP\", ...}" | tee run-2.json
diff <(jq -r .id run-1.json) <(jq -r .id run-2.json) && echo "SAME RUN (replay-safe)"
```

Try the same with an `Idempotency-Key` header if the release supports one.

**Record:** whether the ids match, and *which mechanism* produced that
(`operation_id` field, header, or neither).

**Consequence:** if not replay-safe, `supportsIdempotentCreate: false`, and the
operation-id mapping layer of LLD-001 §7 becomes mandatory — it moves from
"maybe" to a required part of MIU 5c, and MIU 2c must create the
`engine_operations` table.

## E4 — Run metadata and listing

Can a run carry a metadata tag, and can runs be listed?

```bash
# create with metadata, then:
curl -sS -H "Authorization: Bearer $HERMES_KEY" "$HERMES_URL/v1/runs" | jq '.[0]'
```

**Why it matters:** this decides whether an orphaned run — created just before a
crash, its id never recorded — can be found and stopped. If listing is
unavailable, `supportsRunLookupByOperationId: false`, and per LLD-002 §7 the BFF
refuses to start unless another recovery route exists. Record what that route
would be, or accept a bounded orphan window in writing with a named owner.

## E5 — Stop semantics

```bash
curl -sS -X POST "$HERMES_URL/v1/runs/$RUN_ID/stop" -H "Authorization: Bearer $HERMES_KEY" -i
curl -sS -X POST "$HERMES_URL/v1/runs/$RUN_ID/stop" -H "Authorization: Bearer $HERMES_KEY" -i   # twice
curl -sS -X POST "$HERMES_URL/v1/runs/does-not-exist/stop" -H "Authorization: Bearer $HERMES_KEY" -i
# and once against a run that has already completed naturally
```

**Record:** status code and body for all four.
**Maps to:** `EngineCancelResult` — `stopped` / `already_finished` /
`unknown_run`. The port requires all three to be *success*, never a thrown
error, so record exactly how each is signalled.

---

# P2 — Knowledge isolation 🔑

**Blocks:** gate 2 — the single highest-consequence control in the design.

## K1 — The space exists and is separate

Confirm in the Lexiang console that the public customer-service space is a
**separate space**, not a folder, tag, or permission subset inside the internal
space. Record its public identifier.

## K2 — The credential is scoped and read-only

Issue a token for that space alone. Record its non-secret identity (key id or
hash) — this is what `attestKnowledgeCredential()` will report and what the BFF
asserts at startup.

## K3 — The three-assertion probe 🔑

Per SECURITY.md §4, on **one** credential. A bare not-found is a FAIL, because a
revoked token produces exactly the same answer:

1. **Positive control** — read a known *public* document. Must succeed.
   *Without this, every negative result below is vacuous.*
2. **Explicit denial** — request a known *internal* document id. Must return a
   permission error. Not-found is a failure unless the service provably cannot
   distinguish; record that limitation if so.
3. **Write refusal** — attempt a write against the known-good *public* id, so
   refusal means "read-only" rather than "target does not exist".

## K4 — Every retrieval surface, not just get-by-id

Enumerate what the configured MCP knowledge tool actually exposes — search,
query, list spaces, list documents, get, attachment download — from the MCP
server's own tool schema. Run K3's three assertions **per surface**, asserting
on returned *content* (a term unique to an internal document returns zero hits),
not on status codes.

Rationale: a document ACL can correctly block get-by-id while a search API
happily indexes across spaces and returns internal titles and snippets.

## K5 — The sensitivity run

Once, with a deliberately over-scoped token, confirm the probe goes **red**.
Record it. This is the step that distinguishes "the boundary holds" from "the
test never checks".

---

# P3 — Runtime and topology 🔑

## R1 — Where does the BFF run

Use the selected CloudRun service and record region, service type, resources,
`minNum`, VPC/subnet, public origin and billing evidence. Runtime replacement is
outside MIU 0 and requires a new ADR.

The topology is already decided and reported by Tencent support on 2026-08-17:

1. Bind BFF and worker CloudRun services to a dedicated subnet in the Shanghai
  VPC through `VpcConf`.
2. Create TencentDB in the same VPC; a separate database subnet is acceptable.
3. Connect to the private endpoint with explicit port `5432` and TLS.
4. Permit the CloudRun subnet/approved network boundary in database access
  controls; do not use a fixed instance-IP allowlist.
5. Keep public egress enabled for Hermes, Lexiang MCP and model calls. If policy
  later closes it, provision NAT and routes first.
6. Re-read deployed `VpcConf` and run the connectivity/pool/`S0-S11` tests from
  both BFF and worker. Record evidence; configuration alone is not the test.

## R2 — The selected CloudRun worker and its trigger 🧑

LLD-001's start-run handler streams engine events and appends per event — a
long-lived process. This repo's only scheduling primitive is CloudBase timer
triggers, and prior work established the test environment has none.

**Decide and record:** the selected CloudRun worker service/process and whether
an internal signed request, queue adapter, or bounded poll wakes it. The runtime
is not open; only the trigger mechanism is. MIU 5b and 5c cannot be built without
this answer.

## R3 — Verify the selected separate-origin route 🔑

The gateway collision and resolution were measured in
`evidence/P3-runtime-and-routing.md`: `/api/ai/*` reaches the existing
`public-api`, while CloudRun receives its own hostname. The selected topology is
therefore the CloudRun origin; do not register a competing gateway prefix.

Record and verify:

1. The exact deployed CloudRun hostname and public health/smoke route.
2. CORS allows only the approved website origins and methods.
3. The short-lived conversation credential works cross-origin and is never
  confused with the site's existing session token.
4. The widget's compiled API origin matches the deployed CloudRun hostname.
5. A request to the old environment-domain `/api/ai/*` path is not treated as a
  successful assistant request.

**Record:** which option, the evidence, the frontend API origin the widget will
compile against, and the deployed smoke URL.

---

# P4 — Decisions no probe can close 🧑

Each needs a named person and a date. They are listed here because the plan
stalls on them just as hard as on a failed probe, and they have no owner by
default.

| # | Decision | Who | Blocks | Notes |
|---|---|---|---|---|
| D1 | Context assembly + redaction rule | Product + security | MIU 5a, 5c | How many prior turns go to the engine; whether a returned-to-AI conversation replays the salesperson's messages; what is redacted. Human turns routinely carry contact details the visitor gave a person — this is a privacy decision, and leaving it to whoever writes MIU 5c means it gets made silently |
| D2 | Supported languages | Product | Gate 9, MIU 13b | The site is English-only today, but the golden set includes multilingual queries. Either scope a locale MIU or record "English-only pilot" and strip multilingual from the golden set |
| D3 | Model provider + data-processing terms | Legal | Gate 5 | Architecture lists this unproven and no later MIU produces it |
| D4 | Production data region | Product + legal | Gate 4 | |
| D5 | Monthly budget cap + alert thresholds | Product owner | Gate 5, MIU 14b | Needed before the public API ships, not after — an anonymous stranger with no cap is an unbounded bill |
| D6 | Sales takeover workplace | Sales lead | Gate 3, MIU 10 | Where does a salesperson actually work this queue |
| D7 | Notification channel | Sales lead | Gate 3, MIU 5e | `WECOM_WEBHOOK_URL` already exists in this repo — confirm whether it is the approved target |
| D8 | Consent text + transcript retention period | Product + legal | Gate 4, MIU 8 | |
| D9 | Approved public FAQ corpus | Product owner | Gate 9, MIU 13a | |
| D10 | Grounding + refusal thresholds | Product owner | Gate 9, MIU 5a | |

---

# P5 — Repo baseline 🤖

Cheap, and it makes every later "did we break something" question answerable.

```bash
git rev-parse HEAD
corepack pnpm -r test 2>&1 | grep -E "^ℹ (tests|pass|fail)" | tail -20
corepack pnpm -r --filter "./packages/**" --filter "./apps/**" typecheck
npx biome check . 2>&1 | tail -3
```

**Record:** commit sha, test counts per package, and that lint/typecheck are
clean at the starting point.

Also record the patterns worth reusing rather than reinventing:
- `apps/functions/alibaba-catalog-sync/src/rate-limit.ts` — the reserve-first
  `rateLimitHits` ledger, which MIU 6f should follow
- `packages/db/src/alibaba-lease.test.ts` — the existing lease/fencing test shape

---

# Definition of done

MIU 0 is complete when `docs/ai-platform/MIU-0-EVIDENCE.md` exists and:

- Every item above has a date, the command run, and the actual output.
- P0 records both the PASS and the deliberate FAIL from the sensitivity run.
- Every 🧑 decision has a named person and a date, or is explicitly deferred
  with a named owner, a compensating control, and an expiry.
- Anything that could not be observed is listed as deferred **with the MIU that
  will close it** — not silently omitted.

An item recorded as "confirmed" with no command and no output is not evidence.
That is the failure mode this whole file exists to prevent.
