# AI Assistant — What to buy, and why

**For:** the architect / whoever approves spend
**Date:** 2026-08-16
**Environment inspected:** `diversity-123-d9grnqfux221323bb` (ap-shanghai), plan
标准版 `baas_pf_standard`, prepaid to 2027-07-31

Everything below was read from the live environment, not assumed.

---

## What we already have and pay for

| Thing | State |
|---|---|
| CloudBase environment | 标准版, paid, prepaid to 2027-07-31, credits deduction, QPS quota 500 |
| Cloud functions | 3 live: `admin`, `public-api`, `alibaba-catalog-sync` |
| Databases enabled | NoSQL ✅ · PostgreSQL ❌ · MySQL ❌ |
| CloudRun (云托管) | **Not activated** |
| Storage + static hosting | Active |

---

## Item 1 — Somewhere to run the assistant's server

**Buy/activate:** CloudRun (云托管) on the existing environment.
**Console:** `https://tcb.cloud.tencent.com/dev?envId=diversity-123-d9grnqfux221323bb#/platform-run`

**Why it is needed at all.** The website's existing cloud functions answer a
request and finish. The assistant cannot work that way: when a visitor asks a
question the reply streams back word by word over a connection held open for
tens of seconds, and a background worker feeds it. Functions time out and are
not built to hold a connection open.

**Confirmed:** the CloudRun template ships a working server-sent-events example
(`context.sse()`), which is exactly the streaming mechanism required. So the
capability is right; it just is not switched on.

**Cost:** unknown to us. It is a resource on an existing paid plan, so it may be
included or may be metered by usage. **Ask Tencent: does activating 云托管 on
标准版 cost extra, and is it billed by resource points or separately?**

**This one is required in every option below.**

---

## Item 2 — The database. Three options, and this is the real decision

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

### Recommendation

**Option B if the budget allows it; Option A if it does not.** Option B costs
money and removes risk. Option A costs design time and keeps risk that the team
has previously managed successfully. Option C is the one to avoid: it adds cost
*and* risk together.

**A reasonable path:** price Option B first. If the smallest PostgreSQL instance
is acceptable, take it — the design is already written and reviewed against it.

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

| # | Item | Spend |
|---|---|---|
| 1 | Activate CloudRun on the existing environment | Unknown — ask |
| 2 | Database — **decide between Option A (¥0) and Option B (monthly)** | ¥0 or monthly |
| 3 | New Lexiang space + read-only token | Likely ¥0 |
| 4 | Hermes: enable HTTP API, restricted profile, pinned version | Small server if separate |
| 5 | zenmux key + spend cap for the website | Usage-based |

Only items 1, 2 and possibly 4 involve money. Items 3 and 5 are configuration
and policy.
