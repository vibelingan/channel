# Handoff — Alibaba linked catalog sync

Written 2026-08-07 so another agent or engineer can pick this up cold.
Read this first, then `ARCHITECTURE.md` (including amendments §10.1 and
§14.1), then `EXECUTION_LOG.md` if you want the reasoning history.

## What the feature does

Pulls product data from the company's Alibaba.com supplier account — prices,
stock, which SKUs still exist — and writes it onto our own catalog products,
so the storefront shows current supplier pricing instead of hand-typed numbers.

Additive by design: `unitPrice`, `wholesalePrice`, `vipPrice`,
`clearancePrice`, the existing `PriceBlock`, VIP gating, and Overstock are
untouched. A product only shows Alibaba pricing once it is explicitly linked.

## State right now

| | |
|---|---|
| Branch | `feature/alibaba-linked-catalog-sync`, merged with `test`, pushed |
| Deployed? | **No.** GitHub Actions Major Outage on 2026-08-06 blocked it |
| Local gates | All green — 9/9 suites, 0 type errors, biome, 55 SDK probes, 3 artifact smokes, site build |
| Secrets | 4/5 set. `WECOM_WEBHOOK_URL` still missing (optional — without it alerts become log lines) |
| Alibaba console | **Callback URL not yet registered** — the hard blocker for the first Connect |

### Resume the deploy

The push already landed on `test` (`647da13`). Once GitHub Actions recovers:

```bash
gh run list --branch test --limit 3
gh run rerun <deploy-run-id>          # or push an empty commit to re-trigger
```

Then verify the function is actually live before anyone clicks Connect:

```bash
curl -s https://supplychainsai.com/api/alibaba-catalog-sync/health
```

**Do not deploy from a laptop.** The deploy sets function environment
variables from `process.env`, and a local run would push blank values over the
working `admin` and `public-api` functions and break the live site. The GitHub
`test` environment is the only place with the full secret set.

## The three things most likely to trip you up

### 1. There is ONE environment and it is live (§14.1)

`diversity-123-d9grnqfux221323bb` serves `supplychainsai.com`. The GitHub
environment is *named* `test`, which is why the original design assumed a
separate production environment. It does not exist.

**Sync therefore never runs on its own.** `assertNoTimerTriggers` hard-fails
the deploy if the function has any trigger, so the 15-minute timer cannot be
added without also changing that assertion. Deliberate for the first rollout;
see §14.1 for how to enable it properly when the time comes.

### 2. The callback URL is on the BRANDED domain

```
https://supplychainsai.com/api/alibaba-catalog-sync/oauth/callback
```

Not the `*.tcloudbase.com` host. Both apex and `www` are bound to the gateway,
which carries wildcard `*` `/api` routes that beat the site's static route —
verified by `curl https://supplychainsai.com/api/admin` returning the
function's JSON, not the site. This must match what is registered with
Alibaba character-for-character.

### 3. Connect cannot be tested locally

Alibaba redirects a browser to a public HTTPS address on its allowlist.
`localhost` is unreachable from their servers and the console will not accept
it. The sync logic runs locally against a fake supplier; the authorization
round trip only ever works deployed.

## Review history — and what it should teach you

Nine review rounds. The counts went 12 → 6 → 2 → 4 → 5 findings, then three
blessing-gate passes at 20 → 13 → 10. **Almost every round's findings were
defects introduced by the previous round's fixes.**

The root cause is recorded in `EXECUTION_LOG.md`: the implementation-time
checklist at `~/.claude/skills/engineering-craft/checklists/impl-time-gates.md`
was used only as a review filter, never while writing code. Its section 1 is
"Sibling twins — did you join a family?", and the single worst defect was
exactly that — the apply phase missing a lease renewal that its sibling phase,
a hundred lines up the same file, already had.

**If you change anything here, read that checklist first, not after.**

Two more specific traps, both of which cost a round:

- **Check a review finding against the frozen contract before acting on it.**
  One round "fixed" a reviewer's complaint that a manual run invalidates a
  pending quarantine. §12 says that supersession is the intended behaviour.
  The fix contradicted the design and could have deadlocked the only way to
  run sync. Reverted.
- **A crashed reviewer is not a pass.** Two rounds reported clean while an
  agent had died mid-run; the lens it was checking had found a P1 both times.

## Known-broken, deliberately (details in `BACKLOG.md`)

- **B1** Sync only runs when an operator clicks "Run now" (see §14.1).
- **B2** The apply phase walks the whole catalog in one pass — fine at current
  scale, a real limit near 5,000 products. Needs a saved position. A previous
  attempt was reverted for adding a resume exit *without* one, which made the
  phase restart forever. Do the position first.
- **B3** A batch flagged by a failed removal-confirmation records no
  fingerprint, so it can never be approved. Pre-existing; spun off as its own
  task.
- **B4/B6** Log lines carry no run id; the token exchange is the least
  instrumented step.

## Where to look when something goes wrong

1. **Admin → Alibaba Sync → run table** — status, items processed, parse
   failures, one-line error summary per run.
2. **`alibabaSourcePayloads` collection** — every raw supplier response, keyed
   by a hash of its bytes. The best debugging asset here: any "this price is
   wrong" question is answered by reading exactly what Alibaba sent.
3. **Tencent CloudBase console → function logs** — `console.error` output.
4. **Connect failures** come back as a reason code in the URL
   (`?alibaba=error-...`), which the admin page maps to a sentence.

## Key files

| Path | What it is |
|---|---|
| `packages/alibaba-catalog-sync/` | Pure domain logic — money parsing, signing, response contracts, scheduler math |
| `apps/functions/alibaba-catalog-sync/` | The cloud function: OAuth, ingest, linking, promotion, the runner |
| `apps/functions/alibaba-catalog-sync/src/runner.ts` | The state machine. Highest-risk file in the change |
| `packages/db/src/cloudbase-adapter.ts` | Fenced lease + the nested-object write fix |
| `scripts/cloudbase-function-manifest.mjs` | Single source of truth for names, routes, timeouts, env, triggers |
| `docs/alibaba-linked-catalog-sync/SETUP.md` | One-time setup: secrets, Alibaba registration, first run |
