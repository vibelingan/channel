# Retro: catalog single source of truth (2026-10-02 → 2026-10-09)

What went well, what didn't, and where each lesson should live so the next
feature starts from it. Facts come from [TIMELINE.md](TIMELINE.md),
[PROBLEMS_AND_FIXES.md](PROBLEMS_AND_FIXES.md) and the execution log. The
"Where it should live" section only proposes; nothing has been changed yet.

## The week in numbers

| Measure | Value |
|---|---|
| Calendar time | 8 days (10-02 → 10-09); 4 days from the owner's price report (10-06) |
| Commits on the branch since 10-06 | 117 (38 fixes, 24 docs-only) |
| Production deploys since 10-08 | 17 runs: 12 succeeded (42–78 min, average 52), 4 cancelled (1 on purpose for the P0, 1 replaced, 2 stuck CI), 1 running |
| Independent reviews before deploying | one per batch and per late fix; 4 P1 findings and many P2s caught before production |
| Wrong prices on the live site | 21 at the start; 0 mismatches at every audit after the second rollout stage ("stage B"; 137 → 141 products) |
| Owner-visible incidents after release | 3: classification "Save and publish" refused every Alibaba draft (the "P0"), admin thumbnails broken, photos needing manual import |
| Times the conversation was summarized to fit (compactions) | at least 4; the tracked docs carried the work across each one |

## Business and product flow

**Went well**
- The owner's principle, one approved version read by list, page and quote,
  was turned into a design in one day. It fixed the cause for every product,
  not only the 21 rows, and has held through every audit since.
- Owner decisions were recorded as numbered decisions (DEC-1…DEC-20,
  OWN-1/2) with status and date. Reversals (DEC-18) were visible and traceable.
- Supplier changes are reviewed side by side (DEC-19), shaped by the owner's
  own edge cases: keep admin edits, never apply supplier text or photos
  silently, flagged products skipped in batch.

**Didn't go well**
- **Gates were tightened before the everyday path was made easy.** Approval
  became mandatory everywhere, but the most common item, an Alibaba draft
  with no copied photos, could not be published from the owner's main tool
  (classification). Result: the P0, then manual photo imports, then PT-G
  (copying Alibaba photos into our storage before a draft appears).
  The owner's rule that came out of it, "publish is approval", should have
  been the design starting point.
- **DEC-18 was built, then reversed the same evening.** The rule about whose
  text and photos win was decided from an abstract question, then rejected
  once the owner pictured real cases.
- **The owner found three problems before we did:** the P0 refusal,
  photos needing manual import, broken thumbnails. Each was visible on the
  admin page, but our checks after deploys counted data instead of using the
  page.
- **The backlog is large and manual.** 955 drafts flagged "New", 56 without a
  category, 9 "Changed" products waiting for review (R7). The tools exist
  (batch classify and publish); the time cost lands on the owner.

## Workflow and collaboration

**Went well**
- Owner feedback became durable rules within the session and in memory:
  plain language first, answer quoted comments as one reply, no PR into
  `test`, keep working during long waits, publish is approval.
- Production work was done from the owner's signed-in admin tab, never
  typing credentials, with read-only checks before and after each write.
- Runbook with checks after every step (R1–R10), and stop rules for risky
  data steps.

**Didn't go well**
- **Waiting silently on an hour-long deploy** (10-08). The owner: "you
  still have to keep working". Fixed by a rule and by background watchers,
  but it cost trust.
- **Internal questions passed to the owner** ("can fix X apply on Y") and
  jargon-heavy answers. The owner had to ask for plain language several
  times, although the global instructions already require it.
- **Repeated doubt about the `test` branch** in earlier sessions, now a
  memory rule.
- **Permission friction** (refused merges and admin writes) left nothing
  live for hours until the owner switched modes. We reported it rather than
  working around it, which was right; but asking for the exact permission
  earlier would have saved the hours.
- **Long session, many compactions.** The tracked docs (README status,
  EXECUTION_LOG, DESIGN) made recovery possible. Each recovery still re-read
  thousands of lines.

## Technical design and code

**Went well**
- Root causes came from measurement, not guesses. Card vs page price diff on
  the live API (the 21). Gateway timing headers proved publishing was slow
  because of 8–9 serial requests through a gateway outside China, not the
  SDK ("I don't quite buy it", the owner, rightly). Fetching the failing
  photo addresses showed 404, 403 and GIFs.
- One shared rule (`resolvePublicVersion`) behind list, page and quote, so
  they cannot drift again.
- Optimistic writes with revision guards everywhere the sync, the photo job
  and admins can race; approval writes do not change `updatedAt`, and every
  guard was written with that in mind.
- Tests written first and checked by removing the fix (mutation checks) on
  every late fix.

**Didn't go well**
- **"Add a gate, miss an entry point" happened four times:** classification
  publish (P0), create-as-published (MIU-37), the Dianxiaomi importer's
  `makePublic`, and contributor edits to fields the public site reads from
  the row. Each was found later by a review or by the owner.
- **The photo pipeline needed five passes in one day:** PT-G → one product,
  one unit → review fixes (stuck-hidden P1) → 403 → GIF and thumbnails.
  Several were findable up front: what the public image address serves,
  which formats Alibaba sends, which status codes it returns.
- **Display paths assumed old data shapes.** Admin thumbnails assumed a
  draft has no stored photos; the public image address only serves published
  photos. One sentence in the PT-G design ("what does every screen that shows
  a draft photo read?") would have caught it.
- **Registry vs infrastructure drift:** three collections were registered in
  code but never created in the database; `abandonUpload` crashed, for how
  long is unknown, unnoticed because nothing called it and its smoke test
  hid errors.

## Delivery, CI/CD and operations

**Went well**
- Fast-forwarding `test` (no PR) with health endpoints that report the
  release id gave a clear "is it live" signal; background watchers turned
  waits into notifications.
- Staged rollout (stage A, then data steps, then stage B) with read-only
  audits before and after; no buyer saw a wrong price after stage B.

**Didn't go well**
- **Deploys take about an hour** and run the full test suite twice (CI, then
  inside the deploy job). Fixes were batched to fit, and "one more fix" often
  meant one more hour.
- **Two deploys died on infrastructure:** a browser install hung for 31
  minutes; a post-deploy browser step hit the 45-minute job limit. Both
  looked like failures of our change until inspected.
- **Shared concurrency group:** the manual E2E workflow and deploys share
  one queue; a newer push cancels a pending run, which nearly cancelled a
  smoke run.
- **Environment branch policy surprise:** the E2E workflow cannot run from a
  feature branch; found only when a run was rejected.
- **Flaky tests** (three seen this week) cost reruns and doubt.

## Testing and quality

**Went well**
- The independent review before deploying caught real P1s in most rounds:
  stuck-hidden drafts, a missing fingerprint that would have stopped
  "Changed" flags, a batch confirmation that published unticked products,
  an endless retry loop.
- Two browser lanes (approval on and off) plus a real local server
  (`JsonFileAdapter`) let us test end to end without production.

**Didn't go well**
- **Test fixtures used the easy product type.** Browser tests for
  classification publish used products created in the admin, never an
  Alibaba draft, the most common real item.
- **Smoke tests that only run on manual dispatch went stale silently** and
  swallowed cleanup errors, which hid a production bug.
- **First drafts kept needing a P1 fix** from review. The review is a good
  safety net, but the same blind spots recur: who else writes this state,
  what if it changes in between, what does each screen read.

## What we would do differently

1. Before adding a gate, list every path that writes the gated state (UI
   buttons, batch, importers, scripts, create) and test the most common real
   item through each.
2. Before a data job that every row will see, ask what each screen showing
   that data reads, then open those screens after the job, not just count rows.
3. For an external source (Alibaba photos), probe its failure modes first:
   status codes, formats, sizes, a sample of real URLs.
4. Show the owner a concrete before/after case when a rule decides whose
   data wins, before building it.
5. Say how long a wait is and what happens meanwhile, every time.
6. Turn on the cheap deploy fixes early: one test run per deploy, cached
   browsers, job time limits that match reality.

## Where it should live (proposals, not done)

### Engineering craft (via the lessons journal and `/dev-pipeline:consolidate-lessons`)

| Lesson | Trigger words for the skill |
|---|---|
| A new gate must cover every entry point that writes the gated state; enumerate callers and test the most common real item through each | gate, publish, approval, entry point, importer, batch |
| After a data migration or backfill, check every screen that renders the changed data in a browser, not only counts | backfill, migration, catch-up, thumbnail |
| Public delivery gated by publication means admin views of drafts need another path | refcount, publishedRefCount, preview, draft image |
| Every registered collection/table must be provisioned by the deploy; add a parity test between the registry and the provisioning list | collection, schema registry, provisioning, createCollection |
| Smoke/cleanup code must log failures, never swallow them | finally, cleanup, catch(() => {}) |
| A retry that ignores failure records must fix its cutoff on the server clock at run start | retry, resume, cursor, failure note |
| Treat 403 from a CDN for a stored object like 404 when it does not change on retry; probe before deciding | CDN, 403, retry policy |
| Measure end-to-end latency before blaming the SDK; count serial requests | slow, latency, gateway, batch |

### dev-pipeline

- **`verify-blast-radius` / `verify-traceability`:** add a "writers of
  gated state" check: when a change adds or tightens a guard on a field
  (`published`, a status), list every code path that writes it and require a
  test or an explicit "not applicable" for each.
- **`deploy`:** a waiting protocol (report the expected duration, start a
  background watcher on the release id, keep doing useful work, report
  status changes), and a post-deploy "open the screens this change touches"
  step for UI-affecting data jobs.
- **`fix` / `implement`:** require fixtures with the most common real item
  type when the change gates or transforms catalog items.
- **Owner communication:** a short decision-brief template (the choice, a
  concrete example, the recommendation, what happens if no answer) for any
  question sent to the owner.

### New skills (candidates)

- **`cloudbase-ops` (project or shared):** the facts we re-derived several
  times. Gateway latency outside China, release ids on health endpoints,
  collections must be provisioned, `test` is production, deploy timing,
  admin API calls from the signed-in tab, the E2E branch policy.
- **`production-data-runbook` (shared):** plan → review → apply → re-plan to
  zero, receipts with mode 0600, stop rules, read-only audits before and
  after, batch-and-resume within time budgets, and parallel-worker lock
  contention.

### spec-forge (landmines and integrations)

| Landmine | Integration | Prevention |
|---|---|---|
| Deploy job runs the whole test suite again after CI | `github-actions-ci` | Deploy needs CI's success (`workflow_run`/`needs`) instead of re-running tests |
| Browser install hangs and eats the job time | `playwright-e2e`, `github-actions-ci` | Cache browsers; give the install step its own short timeout |
| Post-deploy tests hit the deploy job's time limit | `github-actions-ci` | Separate post-deploy job with its own limit; deploy success not tied to it |
| Manual E2E shares the deploy concurrency group, so a push cancels a pending run | `github-actions-ci` | Separate group for read-only E2E; document which runs may cancel which |
| Environment branch policy blocks dispatched runs from feature branches | `github-actions-ci` | Template documents allowed refs and fails early with a clear message |
| Schema registry and infrastructure drift (missing tables/collections) | data integrations | Generated parity test between the model registry and the provisioning list |
| Smoke tests swallow cleanup errors | `playwright-e2e` | Template cleanup helper that logs and counts failures |

## Open items carried forward

- R7: owner reviews the 9 "Changed" products.
- Client: the clock product's two photos are blocked by Alibaba (403); the
  supplier must re-upload them.
- Owner decision: automatic photo retries in the background need a deploy
  timer (deliberately off since August).
- Follow-ups: Supplier changes panel previews and loading time; the old
  notice overlapping the panel; faster tag-based deploys.
