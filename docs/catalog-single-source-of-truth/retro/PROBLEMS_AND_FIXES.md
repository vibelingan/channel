# Problems, attempts and fixes

Every problem worth discussing in the retro, in four groups: problems the
owner saw on the live site, bugs our own reviews caught before shipping,
difficulties running things in production, and process problems. Each entry
says what happened, why, what we tried, how it ended, and what to do next time.

## 1. Problems the owner saw on the live site

### 1.1 21 products: card price ≠ product page price (found 2026-10-06)

- **What:** e.g. *Lightweight Foldable 3.5mm Wired Music Earphones*: the card
  showed three tiers ($1.30 / $1.22 / $1.20); the page said "USD 1.20, ≥10
  pieces", which was false.
- **Why:** two copies of the price, written by two paths. The card read the
  product row, which every sync rewrites; the page read the copy saved at
  approval. On top of that, for wholesale products with configurations the
  sync stored Alibaba's single "headline" price as a fixed product price, and
  the approved page preferred it over the configurations' own tiers.
- **Tried first:** the owner's instinct was "fix the data and the page should
  follow; no re-approval". That would still have left two sources. After
  discussion (10-06) the owner chose one approved version read by everything.
- **Fix:** batches 1–3 (headline price dropped when configurations exist,
  stored data rebuilt, price summary saved with each approval, one shared
  rule for list, page and quote), then the runbook: unpublish the 21, deploy,
  rebuild, backfill, deploy, re-approve the 21 (10-08). Audit since: 0
  mismatches.
- **Lesson:** when two screens show the same fact, check where each reads it
  from before fixing data.

### 1.2 "Why is the page a frozen copy?" (10-06)

- **What:** the owner read "approval saves a copy of the page" as stale,
  frozen data and was alarmed.
- **Why:** the wording. The approved version is what approval *means*: the
  version an admin looked at. It is replaced at every approval; nothing reads
  an old one.
- **Resolution:** explained as "approval = publishing this version"; the
  owner agreed approval stays the gate and the real defect was the second
  source. DESIGN §10 records the prior decision this reversed.
- **Lesson:** explain mechanisms by what the owner sees ("the page shows what
  you approved; approving again replaces it"), not by storage words.

### 1.3 The 7 manual products used the old page layout (10-08)

- **Why:** only Alibaba-linked products had an approved version; manual ones
  fell back to the old row-based page.
- **Fix:** batch 5a made manual products go through the same approval (DEC-4)
  and R9 approved the 7 (1.8–2.4 s each). Audit: 0 on the old layout.

### 1.4 Tapping a colour's photo did not select the colour (10-08)

- **Why (two cases):** on most products the click handler did not look up the
  configuration for a photo. On "China Manufacturer Custom 3.5mm…"
  (`1098d540`) Alibaba sends no photo per colour at all, so nothing links
  "White" to the white photo.
- **Fix:** a photo that belongs to exactly one configuration now selects it
  (`configurationForPhoto`); for listings without per-colour photos, admins
  assign gallery photos to configurations in Edit (DEC-20).

### 1.5 Publishing was slow, especially in batches (10-08)

- **Claim we inherited:** "each action must validate the cloud operation and
  the SDK has no batch update". The owner did not believe it.
- **Measured:** each request to CloudBase took 0.6–3 s end to end while the
  function itself ran 28–52 ms; the gap is the gateway in mainland China,
  reached from outside it. A publish made 8–9 requests one after another, and
  batch publish handled one product at a time: 15–25 s per product. The token
  check was not the cost (a no-auth health call paid the same).
- **Fix:** one request runs the whole approval on the server (`13d6392`);
  batch publish runs four products at once. A publish is now about 4–6 s.
- **Lesson:** measure before accepting an explanation for slowness.

### 1.6 P0: classification "Save and publish" refused every Alibaba draft (10-09)

- **What:** single or batch, every Alibaba draft failed with "Open Edit to
  review supplier media and approve this product before publishing"; saving
  in Edit did not help. The owner called it a really bad experience.
- **Why:** this path publishes with the revision the classification just
  saved. With that revision present, the admin page refused every
  Alibaba-linked product before checking anything, and the server refused
  any product still flagged "New" — which every draft is. Nothing in Edit
  could satisfy either check. The browser tests for this path used products
  created in the admin, never an Alibaba draft.
- **Fix:** `f90363c` + `8d7cbdf`: the guarded publish runs the same steps as
  Publish (unchanged since classification, flagged products sent to Edit,
  photos imported, approval, publish), each write carrying the revision the
  previous one returned. The deploy already running was cancelled so one
  deploy carried the fix. Owner rule recorded: every publish entry point runs
  the approval itself; Edit only when there is a real reason.
- **Lesson:** test every entry point that publishes with the most common
  product type (Alibaba drafts), not only the easiest fixture.

### 1.7 "Import up to 18 description images" refusal (10-09)

- **What:** one of the owner's two test drafts was refused because Alibaba sent
  19 description photos.
- **Fix:** `d54b027`: publishing takes the first 18, as the Edit import already
  did; an admin's own selection is never replaced. The rest can be added one
  by one in Edit (PT-G picker).

### 1.8 Photos had to be imported by hand (10-09)

- **What:** the owner opened a refused draft and had to click "Import gallery";
  asked why that wasn't automatic.
- **Why:** photos were copied from Alibaba only when an admin published or
  clicked import. Copying 11,000+ photos inside a publish click is slow and
  can fail.
- **Fix:** PT-G: photos are copied on the server after each sync, before the
  draft appears; drafts stay hidden until ready; one-time catch-up for all
  957 drafts.

### 1.9 A product's data and photos should succeed or fail together (10-09)

- **What:** after the catch-up, 7 photos had failed, and the rule was "retry
  after a day". The owner: one product is one unit; all of it succeeds or the
  product waits and retries; other products are not affected; a day is too
  long.
- **Fix:** `5fd7752`: a draft is shown only when every photo is in our storage
  or known to be unavailable from Alibaba (404, bad file, too large);
  otherwise nothing is written and it retries after 10 minutes (up to 6
  times). A sync that changes a draft's photos hides it until they are copied
  again.

### 1.10 Admin list thumbnails broke for drafts (10-09)

- **What:** after the photo catch-up, most thumbnails in Admin → Products
  showed a broken image. The owner asked whether the data had synced.
- **Why:** the list loaded a product's first photo through the public image
  address, which serves only photos of published products. Before photo
  copying, drafts had no stored photo, so the list showed Alibaba's own
  photo. After copying, every draft had a stored photo that the public
  address refused. The data was complete. None of our tests rendered the
  list with a draft that has copied photos, and the production check after
  the catch-up looked at counts, not at the page.
- **Fix:** the list now picks the source per row (public address for live
  products; the Alibaba original for copied drafts; the signed-in preview
  otherwise).
- **Lesson:** after a data change that every row sees, open the admin page
  and look, not just count.

### 1.11 Animated GIFs from Alibaba (10-09)

- Four description photos are animated GIFs named `.jpg`; our storage took
  only JPEG, PNG and WebP. The owner asked for GIF support from storage to
  the website; added across the upload allowlist, the Alibaba copier, the
  Excel import and the upload button (public delivery already served GIF).

## 2. Bugs our reviews caught before shipping

Every batch had at least one independent review; these are the findings that
would have reached the live site.

| When | Severity | What would have gone wrong | Fix |
|---|---|---|---|
| Batch 1 | P2 | Rebuilding stored Alibaba data could be run only once; any repeat failed with `page-changed` | Hash no longer includes the field the first run changes |
| Batch 2 | P2 | The price-summary backfill trusted the summary sent by the caller | Server re-plans each product and writes only its own result |
| Batch 3 | 8 × P2 | Approved products could leak row prices or descriptions; the audit called any 404 "fallback" | Tests pin what approved products never ship; audit made strict |
| Batch 3 re-review | P1 | The stage A deploy recipe lacked `variantCount`, so the R4 check would have matched nothing | Recipe corrected before deploying |
| Batch 4 | P1 | Prepare's shortcut skipped recording the source fingerprint, so most live products could never be flagged "Changed" | Recorded; test reproduced it first |
| Batch 4 | P2 | An approval built from older supplier data could clear a fresh "Changed" flag | Sync records the last-seen digest; publish keeps the flag on mismatch |
| DEC-12 notices | P1 | Batch Publish confirmation kept a fixed list while the table stayed clickable: unticking a product still published it | Modal dialog; ids from a tested helper |
| DEC-19 | P2 | An admin's own edit on a flagged product created a new undecided part, so the flag never cleared | Such edits are recorded as "keep" |
| Batch 5b | P2 | A product with an old Headphones category could never be published from the row switch or batch | Gate accepts the pre-cleanup category |
| Batch 5b | P2 | A contributor's change to family, category, slug or SKU went live at once | Contributors can't change these on a live product |
| PT-G | 5 × P2 | Missing photos never retried; an all-fail refresh dropped photos; approval mid-copy; removed image; emptied list | All fixed in `7e3a4c8` before deploy |
| MIU-55 | P1 | A hidden draft approved or published before its photos landed stayed hidden from the admin list for good (every photo run refused to touch a live product) | The next run clears only the hidden flag |
| MIU-55 | P2 | A refresh whose new photos were all unavailable silently made the gallery "the admin's", so later Alibaba changes were ignored | Marker records the photos kept |
| MIU-55 | P2 | The page promised "try again in 10 minutes" but nothing scheduled it | The open Sync page reruns after 10 minutes; text says so |

## 3. Difficulties running things in production

### 3.1 Deploys take about an hour

- `test` deploys run the full test suite twice (CI, then again inside the
  deploy job): about 60–70 minutes. A new push queues behind a running
  deploy. This shaped the day: fixes were grouped into fewer deploys.
- Follow-up task offered: "Speed up test deploys" (no duplicate CI, tag-based
  deploys, which the owner also suggested; deferred until this feature ships).

### 3.2 Permission refusals (10-08)

- The session's permission check refused merging into `test` (it deploys) and
  admin writes such as unpublishing the 21. We did not work around it and
  reported it; nothing was live for hours. The owner switched to bypass
  permissions and set "no PR into `test`". Later the check still refused two
  writes outside the agreed list; we asked or found another way (backfill
  instead of unpublishing two extra products).

### 3.3 Admin session in Chrome

- Admin writes run from the owner's signed-in admin page (in-page requests
  with the stored session; the token is never read or typed). The session
  expired once and the owner had to sign in again before R1.

### 3.4 Photo catch-up (10-09)

- **Slow:** one loop over 957 drafts would have taken hours at 12 s per call.
  Split into 4 id ranges run in parallel.
- **Lock contention:** drafts from the same supplier share photos; parallel
  workers took the same image lock and drafts came back "busy". Some locks
  were left behind and only expire after 15 minutes. Final single passes
  saved every busy draft.
- **Time-limit bug:** a page where no photo downloaded never counted progress,
  so the 12 s limit never stopped it; one call ran about 4 minutes. Fixed in
  `78a4c47`.
- **Tool limit:** browser-tool batches over about 150 s timed out; runs were
  cut into batches of about 110 s.

### 3.5 The last few photos (10-09)

- After the catch-up and the retry pass, 7 Alibaba photos still fail. Each
  address was fetched by hand: one is gone (404, shared by 2 drafts), two
  are refused (403), four are animated GIFs named `.jpg`, which our image
  storage does not accept (JPEG, PNG, WebP only).
- Change: 403 now counts as "Alibaba no longer serves it", like 404, so a
  new draft is not held back through six retries. GIF support is not
  planned; the drafts keep their other photos and an admin can add others.
- Lesson: when a failure count stops shrinking, look at the actual
  responses before adding retries.

### 3.6 Local test environment quirks

- Node 25 needs `NODE_OPTIONS=--no-experimental-webstorage` for tests.
- Browser lanes need `TMPDIR` on the same disk as the repo (otherwise an EXDEV
  rename error).
- Pre-push hooks: the reviewed commit must equal HEAD, and the push must
  contain a docs change.

## 4. Process and communication problems

| Problem | Owner's words (short) | What changed |
|---|---|---|
| Doubting the `test` branch repeatedly | "Why do you always have doubts in test branch?" | Rule: branch from `main`, merge to `test` to deploy, no caveats |
| Internal questions thrown at the owner | "Don't just give this obscure stuff thrown at me" | Plain language first; recommend, don't ask, on technical details |
| Answering quoted comments one by one | "replies should be treated together" | One integrated reply per message |
| PRs opened into `test` | "there is no PR to test" | Merge or fast-forward into `test`; PRs only into `main` |
| Waiting silently on a deploy | "you still have to keep working" | Say how long a wait is and keep working |
| A rule decided, built, then reversed (DEC-18) | "never … silently mapping to the new change" | Before building a rule about whose data wins, show the owner a concrete case |
| Publish entry points diverged | "Really bad experience P0" | Every publish path runs approval itself |

Context limits also forced several conversation summaries; the tracked docs
(DESIGN, MIU_BREAKDOWN, EXECUTION_LOG) are what kept the work consistent
across them.

## 5. What to keep doing

- Measure in production (read-only) before designing: the 21, the speed, the
  photo counts and sizes all came from live numbers.
- Independent review of every batch before it ships; most serious bugs were
  caught there.
- Runbook steps with a check after each (audit exit 0, counts) and a stop
  rule.
