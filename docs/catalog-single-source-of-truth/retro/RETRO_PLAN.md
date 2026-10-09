# Retro plan: turning this week into reusable engineering knowledge

Replaces the "Where it should live" section of [RETRO.md](RETRO.md) after the
owner's review (2026-10-10): one-line lessons are too thin for a future agent
to match to a task or act on. Nothing below has been done yet.

## 1. What changes in the approach

A lesson is only reusable if a future agent can (a) recognise the situation
from the task in front of it, (b) see the wrong move it is about to make, and
(c) copy the right move. So every lesson becomes a **case** in the format the
`engineering-craft` skill already uses for its rules (frontmatter with
`applies-to`, `historical-incidents`, `impact`; then "Incorrect" and
"Correct" code; then the test that guards it), plus three sections this
week showed are missing:

| Section | What it holds | Why |
|---|---|---|
| **Symptom** | What the owner or a test actually saw | How the problem shows up before anyone knows the cause |
| **Wrong mental model** | What we believed, and why it was plausible | The part a future agent will repeat unless it is named |
| **How we found out** | The evidence: measurement, probe, review finding, owner question | Shows the debugging move, not just the answer |
| **Options considered** | The alternatives and why each was rejected | Makes the decision re-checkable when constraints change |
| **Pattern name + triggers** | A short name and the words/situations that should call it up | So the skill's trigger table can route to it |
| **Still uncertain** | What might still be wrong with the decision | Honest about decisions not yet proven |

One full example is at the end (§6). The other cases are listed in §2 with
their target category.

## 2. The cases to write (from this week, with evidence)

### Data and backend design

| # | Case | Wrong move → better move | Target category |
|---|---|---|---|
| C1 | **One record, many external fetches, users must never see it half-done** (photos + product as one unit) | Save whatever copied, retry later → copy everything first, write once, flip one visibility flag as the commit point | new: `data-pipeline-atomicity` |
| C2 | **Two copies of one fact written by two paths** (card price vs page price, the 21) | Patch the wrong rows → one shared rule decides the public version; every reader calls it | `cross-file-seams` |
| C3 | **Tightening a gate without listing every writer** (publish = approval; P0 classification, create-as-published, importer, contributor fields) | Add the check where you noticed → inventory all writers of the field, test the commonest real item through each | `grep-for-siblings` |
| C4 | **Optimistic concurrency where one writer doesn't bump the revision** (approval writes keep `updatedAt`) | `expectedUpdatedAt` alone → revision guard plus a state guard (`requireUnapprovedDraft`), and identity guard for linked rows | `concurrency-cas` |
| C5 | **Retry and resume semantics for a long job** (photo job: 12 s calls, resumable cursor, failure notes) | Retry everything after a day / ignore notes on manual retry → classify failures (permanent / passing / ours), count attempts only for the source's failures, fix a retry run's cutoff on the server clock | new: `data-pipeline-atomicity` |
| C6 | **Time budget that never trips** (no downloads → no progress → a call ran 4 minutes) | Count only downloads as progress → any finished unit is progress; a call always ends at its budget | `data-pipeline-atomicity` |
| C7 | **Ownership of a field shared by a sync and humans** (sync-owned vs admin-edited photos, supplier decisions by digest) | Last writer wins → a marker of what the sync wrote; admin edits detected by comparison; decisions stored with a digest of the exact incoming value | `historical-data-compatibility` |
| C8 | **Leaking through a side channel** (public search matched the Alibaba ID though the payload never showed it) | Blocklist fields in the payload only → allowlist per surface, including search fields | `enumeration-safety` |
| C9 | **Registry vs infrastructure drift** (three collections never created; `abandonUpload` crashed) | Trust that registered = exists → parity test between the registry and the deploy's provisioning list | `config-drift` |

### Performance

| # | Case | Wrong move → better move | Target category |
|---|---|---|---|
| C10 | **"The SDK can't batch" — slow publishing** | Accept the explanation → measure end-to-end vs function time (`x-cloudbase-upstream-timecost`), count serial requests; move the orchestration server-side in one request with a time budget and a hand-back; batch with bounded concurrency and stop rules | new: `performance-latency` |
| C11 | **Expensive scan on a rarely used path** (`abandonUpload` lists every collection, 7.5 s) | Scan at call time → keep a reference count or index (noted, not done) | `performance-latency` |

### React / front end

| # | Case | Wrong move → better move | Target category |
|---|---|---|---|
| C12 | **Same data fetched twice by two components** (list thumbnail + Edit photo manager) | Per-component fetch → module-level promise cache keyed by immutable id, failures evicted, size-bounded | `frontend-async-state` |
| C13 | **Timer or `finally` calling a stale callback** (photo retry after 10 minutes) | Capture the callback in the closure → `useRef` holding the latest callback; timers in refs, cleared on unmount and at run start | `frontend-async-state` |
| C14 | **Per-row async state in a table** (thumbnail preview, fallback on error) | One `loaded` flag → result tagged with the id it belongs to (`preview.id === previewId`), an explicit fallback state that cannot loop | `frontend-async-state` |
| C15 | **Display assumes the old data shape** (drafts gained stored photos the public address refuses) | Render with the public URL because it used to work → for each screen, ask what it reads and whether that changed; pick the source per row | `historical-data-compatibility` |
| C16 | **Component under test without its provider** (`useQuery` in RecordForm broke render tests) | Wrap tests or keep the hook → plain cancellable effect for a single read; providers only where caching matters | `frontend-async-state` |

### Process and verification

| # | Case | Wrong move → better move | Target category |
|---|---|---|---|
| C17 | **Checks that count instead of look** (thumbnails broke after the catch-up) | Status counts → open the screens the data feeds, in a browser, after the job | `verification-integrity` |
| C18 | **Stale on-demand smoke tests that swallow errors** | `catch(() => {})` in cleanup; run only on manual dispatch → log cleanup failures; schedule the smoke weekly | `e2e-test-resilience` |
| C19 | **Fixtures of the easy item type** (classification tests used admin-created products, never Alibaba drafts) | Whatever fixture exists → the commonest real item | `e2e-test-resilience` |
| C20 | **Decisions about whose data wins, asked in the abstract** (DEC-18 reversed the same evening) | Ask "should approval take supplier changes?" → show one product's before/after and ask | `process` |
| C21 | **Waiting on long external work** (silent hour-long deploy) | Poll or sit → state the expected wait, watch in the background, keep working, report state changes | `process` |
| C22 | **Before/after evidence for a production fix** (public search) | "Tests pass" → reproduce in production read-only before, same probe after | `verification-integrity` |

C1, C5 and C10 are the largest and the ones the owner explicitly asked
about (transaction-style mapping, retries, performance).

## 3. Decisions that may still be wrong (to revisit, not to act on now)

| Decision | Doubt | What would settle it |
|---|---|---|
| Hidden-until-ready drafts, retried only while the Sync page is open | With no timer, a waiting draft can stay hidden until someone opens the page | Owner decision on a photo timer; or count hidden drafts weekly |
| 403 from Alibaba counts as permanent | A throttling 403 would skip a good photo | Watch skipped-photo counts; "Copy photos now" retries them |
| Thumbnails for copied drafts load the Alibaba original | Depends on Alibaba's CDN and its referrer rules | Falls back to our copy already; check if fallbacks grow |
| Publish takes the first 18 description photos silently | The owner may want a different 18 | Picker exists; ask whether a notice is enough |
| Each approval writes new immutable configuration rows | Storage grows with every approval; no clean-up | Count rows per product after a month |
| `abandonUpload` scans every collection | 7.5 s today; grows with the catalog | Reference index or count (C11) |
| Two approval protocols (one request, plus the browser fallback) | Two code paths to keep equivalent | Measure how often the fallback runs; remove if never |
| Missing collections fixed only by provisioning | The adapter still throws 500 on a missing collection | Optionally map "collection missing" to an empty list in `list` |
| Manual products with configurations cannot be approved | Gap if the client adds such products | Owner decision when needed |
| Deploying to production on every push to `test` | One hour per change; no versioned rollback | Tag-based deploys (deferred by the owner) |

## 4. Skills: what deserves to be one

A skill earns its place when it (1) recurs across projects, (2) carries a
procedure with decisions, not just facts, and (3) has triggers an agent can
recognise from a task. Against that test:

| Candidate | Verdict | Instead |
|---|---|---|
| `cloudbase-ops` | **Not a skill.** Mostly facts about this project's platform; little procedure | A project reference doc (`docs/agents/cloudbase.md`) linked from `CLAUDE.md`: gateway latency, release ids on health endpoints, provisioning list, test = production, E2E branch rule, deploy timings, admin calls from the signed-in tab |
| `production-data-runbook` | **Not yet a standalone skill.** Real procedure, but one project's worth of evidence | A new engineering-craft category `data-operations` (plan → review → apply → re-plan to zero; receipts; stop rules; batch-and-resume within budgets; parallel-worker lock contention) with a runbook template; promote to a skill only after a second project uses it |
| `data-pipeline-atomicity` | **Category, not a skill** | C1, C5, C6 as rules in engineering-craft |

## 5. dev-pipeline refinements (detailed)

Each item names the command it changes, what it adds, and the incident that
justifies it.

1. **`plan` (Phase 1.1 blindspots) — writers-of-state inventory.** When a
   change adds or tightens a guard on a field (`published`, a status, a
   price), the analyst lists every code path that writes it: UI buttons,
   batch actions, create, importers, scripts, other functions. Output is a
   table in the plan; each row gets a test or an explicit "not applicable".
   *Incident: C3 (four missed paths).*
2. **`plan` — readers-of-data inventory.** When a job or migration changes
   the shape or visibility of stored data, list every screen and endpoint
   that reads it and how. *Incident: C15 (thumbnails).*
3. **`plan` — external source probe.** Before building ingestion from an
   outside system, sample real responses: status codes, formats, sizes,
   slow and failing items. Record the sample in the plan. *Incident: the
   photo work's five rounds (404, 403, GIF).*
4. **`implement` — fixtures rule.** Tests for a gated or transformed item
   must include the commonest real item type. *Incident: C19.*
5. **`review` — standard probes.** Add to the reviewer prompt the questions
   that found this week's P1s: who else writes this state; what if it
   changes between read and write; can anything stay hidden or stuck
   forever; what happens on retry or resume; what does each screen read; is
   any error swallowed. *Incidents: stuck-hidden draft, retry loop, missing
   fingerprint, batch confirmation.*
6. **`fix` — before/after evidence.** For an owner-reported production bug:
   reproduce read-only in production first, record it, run the same probe
   after deploy. *Incident: C22.*
7. **`deploy` — waiting protocol and post-deploy look.** State the expected
   duration; start a background watcher on the release id; keep working;
   report changes. After a UI-affecting deploy, open the touched screens and
   capture them. Tell infrastructure failures (stuck installs, time limits)
   from code failures before reacting. Know which runs share the concurrency
   group. *Incidents: C17, C21, the two stuck deploys, the near-cancelled
   smoke run.*
8. **Owner communication — decision brief.** Any question to the owner uses
   a fixed shape: the choice in one line, one concrete example
   (before/after), the recommendation, and what happens if there is no
   answer. Internal engineering questions are answered, not asked.
   *Incident: C20 and "don't throw obscure stuff at me".*
9. **`learn` / `consolidate-lessons` — case format.** The journal hook
   captures commit bodies, which produces one-liners. Add an end-of-feature
   step that writes cases in the §1 format, and have consolidation reject
   entries without symptom, wrong model, evidence and code.
   *Incident: this retro.*

## 6. spec-forge additions

New rows for `LEARNINGS_APPLIED.md`, each with a regression assertion:

| Landmine | Integration | Prevention |
|---|---|---|
| Deploy job re-runs the whole test suite after CI | `github-actions-ci` | Deploy depends on CI success instead of re-running |
| Browser install hangs and eats the job's time | `playwright-e2e`, `github-actions-ci` | Cached browsers; the install step gets its own short timeout |
| Post-deploy tests hit the deploy job's time limit | `github-actions-ci` | Separate post-deploy job with its own limit |
| Manual E2E shares the deploy queue; a push cancels a pending run | `github-actions-ci` | Separate concurrency group for read-only E2E |
| Environment branch policy rejects dispatched runs from feature branches | `github-actions-ci` | Documented allowed refs; early, clear failure |
| On-demand smoke tests go stale | `playwright-e2e` | Weekly scheduled run of every dispatch-only suite |
| Smoke cleanup swallows errors | `playwright-e2e` | Cleanup helper that logs and counts failures |
| Schema registry and infrastructure drift | data integrations | Generated parity test between models and provisioning |
| No way to tell which release is live | all deployable apps | Health endpoint returns release id and build time; deploy smoke asserts it |
| Flaky tests hidden by retries | `playwright-e2e` | Report retried-then-passed tests as a separate count |

## 7. Example case, written in full (C1)

---
title: One record, many external fetches — write once, flip one flag
type: pattern
impact: HIGH
applies-to: |
  Any job that builds one user-visible record from several slow or fallible
  external steps (downloads, API calls, file conversions) where users must
  never see the record half-done, and the store cannot hold one transaction
  across those steps.
historical-incidents:
  - Alibaba drafts appeared in the admin with no photos; publishing imported
    photos through the browser, 30–80 s per draft, and refused drafts with 19
    description photos (P0, 2026-10-09)
  - First photo-copy job saved whatever copied and retried failures after a
    day; drafts showed with some photos missing (owner: "success then all
    should success, fail then all fail and retry later")
---

**Symptom.** The owner opened drafts that were missing photos, had to click
"Import gallery" by hand, and saw publishing refused for photo reasons. Later,
after a first copy job, some drafts showed with only part of their photos.

**Wrong mental model.** "Product fields and photos are separate concerns: sync
the fields, attach photos when someone publishes, and patch the missing ones
later." It was plausible because the sync and the photo copy are different
systems with different speeds, and the existing code already had separate
"import gallery" and "import description photos" actions.

**How we found out.** The owner described the business rule (the product is
one unit, approved once, including its photos), then measured costs made it
concrete: 11,180 photo sources over 957 drafts, 1–3 s per photo through the
gateway from outside China, so copying at publish time could never feel
instant. A data scan showed 208 drafts with more than 18 description photos.

**Options considered.**
1. *One database transaction for fields and photos.* Rejected: a download
   takes seconds; CloudBase transactions are short and capped at 100
   operations; a transaction cannot wait on the network.
2. *Copy at publish time (status quo).* Rejected: slow, fails in front of
   the admin, and makes photos a reason publishing can fail.
3. *Copy ahead, save what succeeded, retry the rest later.* Built first,
   then rejected: users see half-ready drafts; "later" was a day.
4. **Copy everything off to the side, then one guarded write that sets the
   fields, the ownership marker and the visibility flag together.** Chosen.

**Incorrect**

```ts
// Saves whatever copied; the draft becomes visible with holes in it.
for (const part of plan.parts) {
  const states = await copySources(part.sources);
  const ids = states.filter(isCopied).map((s) => s.imageId);
  if (ids.length > 0) data[part.field] = ids;
  marker[part.part] = { sources: part.sources, imageIds: ids, missing: failedOf(states) };
}
await saveProduct(product._id, { ...data, alibabaAutoPhotos: marker });
// failed photos retried "after a day"
```

**Correct**

```ts
// 1. Copy everything first; nothing is written yet.
const copied = [];
for (const part of plan.parts) {
  const states = await copySources(part.sources); // copied | 'unusable' | 'waiting'
  if (states === null) return 'out-of-time';      // resume next call, nothing written
  copied.push({ part, states });
}
// 2. Any passing failure: the whole product waits; other products continue.
if (copied.some(({ states }) => states.includes('waiting'))) return 'waiting';
// 3. One guarded write is the commit point: fields + marker + visibility.
await saveCatalogProductWithIdentities({
  mode: 'update',
  productId: product._id,
  data: { ...fieldsFrom(copied), alibabaAutoPhotos: markerFrom(copied), alibabaPhotosPending: false },
  expectedUpdatedAt: product.updatedAt,       // nobody changed it meanwhile
  requireUnapprovedDraft: true,               // approval doesn't bump updatedAt
  expectedAlibabaIdentity: identityOf(product),
});
```

The record is created hidden (`alibabaPhotosPending: true`) and every list
leaves hidden records out, so the flag flip in step 3 is the only moment the
record becomes visible. Failures are classified: **permanent** (404/403,
wrong format, too large) are skipped and reported; **passing** (timeouts,
network) make the product wait 10 minutes; **ours** (storage write failed)
never count toward giving up.

**Pattern name and triggers.** "Prepare off to the side, flip one flag."
Triggers: *import, sync, ingest, copy media, enrich, multi-step job, partial
failure, half-ready, retry later, can't use a transaction.*

**Tests that guard it.** A passing failure writes nothing and the next
product still saves; a permanent failure is skipped and the product shows;
a record approved or published while hidden is shown again (review P1:
stuck hidden forever); a source change that the job would not act on does
not hide the record; a manual retry never fetches the same slow item twice
in one run (review P2: endless loop).

**Still uncertain.** Retries run only while the Sync page is open (no
timer), so "retry later" depends on someone using the page. The visibility
flag is a second source of truth next to `published`; a list that forgets
`hidePreparing` would show half-ready drafts.
