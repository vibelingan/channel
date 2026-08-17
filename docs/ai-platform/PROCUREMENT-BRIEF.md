# AI Assistant — What to buy, and why

**For:** the architect / whoever approves spend
**Last updated:** 2026-08-16 (second revision — CloudRun now activated and tested)
**Environment inspected:** `diversity-123-d9grnqfux221323bb` (ap-shanghai), plan
标准版 `baas_pf_standard`, prepaid to 2027-07-31

Everything below was read from or measured against the live environment, not
assumed.

## Status at a glance

| # | Item | Status | Spend |
|---|---|---|---|
| 1 | CloudRun (云托管) | ✅ **Activated and proven working** | Included / TBC — see note |
| 2 | Database | **Decided: Option B** — standalone 云数据库 PostgreSQL | Monthly, to price |
| 3 | Lexiang space + read-only token | Outstanding | Likely ¥0 |
| 4 | Hermes HTTP API, restricted + pinned | Outstanding | Small server if separate |
| 5 | zenmux key + spend cap | Outstanding | Usage-based |

**Only item 2 requires a purchase decision now.**

---

## What we already have and pay for

| Thing | State |
|---|---|
| CloudBase environment | 标准版, paid, prepaid to 2027-07-31, credits deduction, QPS quota 500 |
| Cloud functions | 3 live: `admin`, `public-api`, `alibaba-catalog-sync` |
| Databases enabled | NoSQL ✅ · PostgreSQL ❌ · MySQL ❌ |
| CloudRun (云托管) | ✅ **Activated 2026-08-16 and proven** (was off until then) |
| Storage + static hosting | Active |

---

## Item 1 — Somewhere to run the assistant's server

**Status: ✅ DONE.** Activated by the owner on 2026-08-16, and verified by
deploying a throwaway service end to end.

**Why it is needed at all.** The website's existing cloud functions answer a
request and finish. The assistant cannot work that way: when a visitor asks a
question the reply streams back word by word over a connection held open for
tens of seconds, and a background worker feeds it. Functions time out and are
not built to hold a connection open.

### What was measured, not assumed

A throwaway service (`ai-probe`) was deployed to the real environment and tested:

| Check | Result |
|---|---|
| Deploy succeeds | ✅ Service live at `https://ai-probe-298020-11-1443560658.sh.run.tcloudbase.com` |
| Time to first response | ~120s (the service object exists before its first version builds; a 404 in that window is normal) |
| Plain HTTP | ✅ `HTTP 200` |
| **Streaming (server-sent events)** | ✅ **Works.** `content-type: text/event-stream`, `transfer-encoding: chunked`, `cache-control: no-cache`; events arrived incrementally with multi-line frames and UTF-8 intact |

**Why the streaming result matters most.** It was the riskiest unproven
assumption in the entire design — streaming that dies quietly behind a proxy
looks fine in development and fails in production. It is now settled by
measurement rather than hope.

**Cost:** still worth confirming on your bill. It is a resource on an existing
paid plan. **Ask Tencent: how is 云托管 billed on 标准版 — resource points or
separately?**

---

## Item 2 — The database · **DECIDED: Option B**

The assistant must make several writes happen as **one indivisible step** —
mark the chat human-controlled, revoke the AI's permission to write, record the
event. If those can happen separately, a stray AI sentence reaches the customer
after a salesperson has taken over. That is the single hardest requirement in
the system and it drives this choice.

### Option A — Use the CloudBase NoSQL database we already have · **¥0 new spend**

The existing `@cloudbase/node-sdk` supports `runTransaction`, which
**re-executes its callback on write conflict**. This codebase already uses that
to build a fenced lease for the Alibaba catalogue sync
(`packages/db/src/cloudbase-adapter.ts`, tested in
`packages/db/src/alibaba-lease.test.ts`). The same pattern can carry the
takeover fence.

- **Cost:** nothing. Same environment, same plan.
- **Work:** the low-level design is currently written entirely in PostgreSQL
  terms — conditional `UPDATE … RETURNING`, partial unique indexes, and so on.
  It would need rewriting for a document database and re-reviewing. That is
  design effort, not purchase.
- **Risk:** the team has done this exact kind of fencing here before, and it
  survived review. That is meaningful evidence.
- **Unknown:** query patterns the assistant needs — a sales queue, replaying a
  conversation's events in order — are natural in SQL and need deliberate index
  design in a document store.

### Option B — A standalone 云数据库 PostgreSQL instance · **new monthly cost**

A normal PostgreSQL server, in ap-shanghai so it sits beside the CloudRun
service on the internal network.

- **Cost:** a monthly instance charge. Price it at
  <https://buy.cloud.tencent.com/price/pgsql> — smallest instance is ample for a
  pilot.
- **Work:** none beyond what is designed. The low-level design already targets
  this exactly.
- **Risk:** lowest. We have a 30-second script that answers PASS/FAIL on whether
  a given database supports the required behaviour, and it has been verified to
  give the right answer on both a good database and a deliberately broken one.
  We can prove it before committing.

### Option C — A second CloudBase environment in PostgreSQL mode · **new environment cost**

CloudBase does offer PostgreSQL, but Tencent's documentation states PG mode is
chosen **when an environment is created** and *"legacy environments cannot be
upgraded in place"*. Our environment reports `postgresql: false`. So this means
a second environment.

- **Cost:** another environment plan.
- **Work:** see the section below — the critical logic moves into the database
  and is written in a different language.
- **Risk:** highest. Our verification script cannot connect to it at all, so the
  hardest requirement stays unproven until late.

### Decision — taken 2026-08-16 by the product owner

**Option B.** Buy a standalone 云数据库 PostgreSQL instance in **ap-shanghai**
(same region as CloudRun, so the two talk over the internal network — lower
latency, no egress charge).

Rationale on record: the design is already written and reviewed against a normal
PostgreSQL, and the 30-second verification script can prove the database
supports the required behaviour *before* any code is committed to it. Option A
was viable and free but required rewriting the most safety-critical design for a
document store; Option C was rejected for adding cost and risk together.

**This is the only outstanding purchase.**

**What to buy:** smallest instance, ap-shanghai. Price at
<https://buy.cloud.tencent.com/price/pgsql>.
**What to send back:** host, port, database name, user, password.

---

## Where the assistant will actually live (measured, and it changes the design)

The original architecture put the assistant at `/api/ai/*` on the website's API
domain. **That path is already taken, and CloudRun does not use that domain
anyway.** Both facts were measured, not assumed.

### Why `/api/ai/*` is taken

The deploy manifest maps three prefixes, and the gateway matches the longest one:

| Prefix | Function |
|---|---|
| `/api/admin` | `admin` |
| `/api/alibaba-catalog-sync` | `alibaba-catalog-sync` |
| `/api` | `public-api` |

`/api/ai/healthz` matches no specific prefix, so it falls through to `/api` and
lands in **`public-api`**, which walks its own routes, matches none, and returns
its own error envelope from `apps/functions/public-api/src/http-adapter.ts:280`.

Measured:

| Request | Result |
|---|---|
| `GET /api/products?pageSize=1` | `HTTP 200` — `public-api` |
| `POST /api/admin` | `HTTP 401` — `admin`, auth required, correct |
| `GET /api/ai/healthz` | `{"ok":false,"error":{"code":"NOT_FOUND","message":"Route not found"}}` — **`public-api` answering** |
| `GET /ai-probe/` on the same domain | `HTTP 404` — CloudRun is not mounted there |

**Nothing was changed to fix this, and nothing needs to be.**

### Because CloudRun gives the service its own hostname

A CloudRun service is reachable at `<service>-<id>.sh.run.tcloudbase.com`, not as
a path under the environment's API domain. So the assistant never touches `/api`
and the collision cannot occur.

### The consequence the architect should know

The widget will call a **different origin** from the website. That makes two
things real requirements rather than formalities:

1. **CORS** — the assistant's service must allow the website's origin explicitly.
2. **The short-lived conversation credential travels cross-origin**, which
   affects how it is carried and stored.

Three design documents are being updated to match: the architecture's route
table, the deployment unit (MIU 2a), and the security trust-zone diagram.

---

## Item 3 — A new Lexiang (腾讯乐享) knowledge space + read-only token

**Buy/create:** a new, separate space in Lexiang, plus a token scoped to read
only that space.

**Why separate.** Lexiang's anonymous `system-bot` identity can read anything
visible to all staff. That is internal company knowledge. A stranger typing into
a chat box on the public website causes a search against whatever that token can
reach. If it can reach supplier contracts, costs, or customer projects, one day
it will surface them.

Making it a folder or a permission subset inside the existing space is not
sufficient — the token must be incapable of reaching internal material, not
merely trusted not to.

**Cost:** likely nothing if Lexiang is already licensed; a space is a container.
**Confirm with whoever administers Lexiang.**

---

## Item 4 — Hermes with its HTTP API enabled

**Not a new purchase — a configuration change**, plus a decision about where it
runs.

The existing 智能小助手 is a message-channel bot (WeCom / 元宝 / LightClaw) run
by `hermes-gateway.service`. Per our own operations manual it has **no HTTP API
server**; serving a website widget requires explicitly setting
`API_SERVER_HOST` and `API_SERVER_KEY`.

Two things matter:

1. **A separate restricted profile.** Hermes ships tools that can run commands,
   read files and browse the web. Those are acceptable for an internal bot and
   are a remote-code-execution path on a service anonymous visitors can reach.
   The website profile must expose only read-only knowledge lookup.
2. **Pin the version.** Not `latest`. We check the exact tool list once and
   freeze it, so a routine upgrade cannot quietly add a dangerous capability.

**Decision for the architect:** run the website's Hermes as a second instance,
or as a second profile on the existing host? A second instance is safer — the
internal bot and the public one then cannot share configuration by accident.

**Cost:** a small server if it is a separate instance.

---

## Item 5 — A zenmux key and spend cap for the website

The existing bot already uses zenmux. Reuse the account, but issue a
**separate key** for the website with its own monthly cap, so public traffic
cannot exhaust the internal bot's budget and so spend is attributable.

**Cost:** usage-based, and genuinely unknown until we size it — see the gap
below.

---

## What we cannot tell you yet, honestly

**No traffic or cost sizing exists.** Nobody has written down expected
conversations per day, peak concurrency, tokens per conversation, or storage
growth. That is why we cannot tell you which database instance size to buy or
what the monthly model spend will be. It is a real gap in the design documents
and we should close it before the purchase conversation, not after.

**We do not have Tencent's prices.** The console shows them at the point of
activation. The two questions worth asking directly:

1. Does activating 云托管 on 标准版 cost extra, and how is it billed?
2. What is the monthly price of the smallest 云数据库 PostgreSQL instance in
   ap-shanghai?

---

## Summary for the purchase conversation

| # | Item | Status | Spend |
|---|---|---|---|
| 1 | CloudRun | ✅ Done — activated and proven working, including streaming | Confirm billing on 标准版 |
| 2 | **云数据库 PostgreSQL, smallest instance, ap-shanghai** | ⬅ **The one thing to buy** | Monthly — price at the link above |
| 3 | New Lexiang space + read-only token | Outstanding | Likely ¥0 — confirm with the Lexiang admin |
| 4 | Hermes: enable HTTP API, restricted profile, pinned version | Outstanding | Small server if run separately |
| 5 | zenmux key + monthly cap for the website | Outstanding | Usage-based |

**One purchase: item 2.** Items 3, 4 and 5 are configuration and policy, and
item 1 is finished.

Once item 2 exists, send the connection details and the verification script
gives a PASS/FAIL the same day — that result is what unblocks the database work.
