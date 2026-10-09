# Timeline

Times are UTC. "Owner" is the product owner; quotes are short excerpts of their
messages. Commit hashes are on `feat/catalog-alibaba-price-tiers` unless noted.
`test` is the branch that deploys to supplychainsai.com (production, and the
owner's only test environment).

## 2026-10-02 — The price block redesign ships

- Two patch files from the owner (Alibaba-style price tiers on the product
  page) were applied on a branch from `main` and checked in the browser.
- Deployed through PR #64 into `test` (`2f8567f`), with the admin
  classification fix #65; #66 promoted the verified classification work to
  `main`.
- Owner, 03:14: "Why do you always have doubts in test branch? It's a
  deployment branch but not newest code authority". The agent had kept
  questioning `test` diverging from `main`. Recorded as a standing rule:
  branch from `main`, merge to `test` to deploy, don't caveat the divergence.

## 2026-10-06 — Wrong prices on the live site; the redesign is agreed

- 09:23 Owner: product pages in production still don't look as required.
- 09:41 Owner asks whether it is a front-end or back-end issue and why 21
  products show stale prices: "Data accuracy is important not to have stale
  data". Investigation on the live API: 137 listed products, 130 with an
  approved page, **21 where the card price differs from the page price**.
- Cause found: the card read prices from the product's own row (rewritten by
  every sync); the page read the copy saved at approval. For wholesale
  products with configurations, Alibaba's single "headline" price had been
  stored as a fixed price, so the approved page showed "USD 1.20, ≥10 pieces"
  while 10 pieces actually cost $1.30.
- 10:21 Owner, alarmed by "the page reads a saved copy": "Why froze data? …
  It should be like changing the status available to public right?"
- 12:01–12:31 Owner settles the principle: synced data still needs approval;
  the error was having **two sources of truth**. "Product detail and product
  list should be the same, exactly the same thing … What gets approved can be
  displayed."
- 14:18–15:37 Owner on colours and SKUs: every configuration keeps its own
  price (a SKU is the full combination of options); the list card shows the
  cheapest configuration; one product, one approved version, read by the list
  call and the single-product call alike. Owner asks for a design doc and a
  detailed work-unit (MIU) plan, and a standing rule: never use a `claude/`
  branch prefix.
- 16:02 Plan committed (`96c8ea3`): DESIGN.md, MIU_BREAKDOWN.md (38 work
  units in batches 1–5b), EXECUTION_LOG.md.

## 2026-10-07 — Decisions, then batches 1–3 built

- 01:32 and 05:10 Owner answers the open decisions in quoted replies:
  manual products must look exactly like synced ones (DEC-4: same schema, API,
  pagination, search, sort); unpublishing does not clear "Changed" (DEC-11);
  fix and validate locally before unpublishing the 21 (DEC-13); contributors'
  edits stay drafts flagged "edited" (OWN-1); the Hermes importer creates
  drafts but is not investigated now (OWN-2); the card's price summary is part
  of the same approval, only shown in a different place. Owner: "My comment /
  replies should be treated together" (rule: answer quoted comments as one
  reply).
- 01:17 `71272a6`: price tiers below the minimum order are never shown.
- Built and reviewed through the day: batch 1 (normalizer drops the headline
  price when configurations exist; the stored Alibaba data can be rebuilt
  without calling Alibaba), batch 2 (price summary stored with each approval;
  backfill for older approvals), batch 3 (list, product page and quote all
  read the one approved version; consistency audit script). Several review
  rounds, each fixing real defects (see PROBLEMS_AND_FIXES.md).
- 16:27 Owner: "Don't just give this obscure stuff thrown at me for me to
  decide" (about internal questions such as "can fix X apply cleanly on Y"),
  asks what the backfill scripts are and where they run, and asks for full
  local browser testing, then deploy through `test` and real admin testing in
  production on the 21 products.

## 2026-10-08 — Rollout to production

- Night: batch 4 (the "Changed"/"Removed" flag and its reason) and batch 5a
  (manual products) built locally; full local validation; review rounds.
- 04:52 Agent reports nothing is live: the permission system refused merging
  into `test` and refused admin writes (unpublishing the 21). Owner asks
  what is stopping it, since `gh` is authorised.
- 07:18 Owner switches the session to bypass permissions and sets the rule:
  "Don't open PR then, merge feat into test, PR is before merging to main".
  PRs #67/#68 (stage A/B into `test`) were dropped.
- 07:22–08:04 **Stage A** (batches 1, 2a, 2b) deployed by fast-forwarding
  `test` to `b5f50c9`. The admin login in Chrome had expired; the owner
  signed in again.
- R1: the 21 products were unpublished from the signed-in admin page (public
  list 137 → 116). R2: Alibaba data rebuilt for 1,109 source products (471
  headline prices removed). R3: 0 pinned offers. R4: card price filled in for
  all 150 approved products.
- 10:26–11:15 **Stage B** (batch 3) deployed. Audit after: 116 listed, 0
  mismatches.
- 11:15–11:28 R7: the 21 re-approved and published from the admin list; each
  card now matches its page.
- 14:02 Owner, in quoted replies: asks how the fill was done; asks to fix
  publishing speed ("I don't quite buy it" about the claim that the SDK
  cannot batch); revises DEC-18: keep admin edits and **never apply supplier
  text or photo changes silently**; show them side by side in Edit; think
  about batch publish and about roles. Also reports that tapping a colour
  photo does not select the colour, and that manual products used the old
  page layout.
- Same evening: measured the cause of slow publishing (8–9 requests in a row,
  0.6–3 s each through the CloudBase gateway); built one-request approval and
  four-at-a-time batch publish (`13d6392`); photo → configuration selection.
- 14:26–15:24 **Batch 4 + 5a + speed** deployed (`a4ee43a`). R6 audit
  flagged 9 products "Changed". R9: the 7 manual products approved (1.8–2.4 s
  each) and now on the shared page. Audit: 137 listed, 137 approved, 0
  fallback.
- During the hour-long deploy the agent waited silently. Owner: "After an hour
  still waiting for deployment? … you still have to keep working". Rule
  recorded: never idle on a long wait; say how long it takes and keep doing
  useful work.

## 2026-10-09 — Review panel, P0 publish fix, photos, one-unit products

- 01:29 Owner on the five open questions about the side-by-side review: "Go
  with your decision let's wrap things up", then `/dev-pipeline:pipeline`.
- 01:30–02:30 Built DEC-19 (Supplier changes panel), DEC-20 (photos per
  configuration) and batch 5b (publish gate for every product, refusal to
  create an already-published product, contributor edits): `5af7309` …
  `cb1c6b5`, two review rounds.
- 02:32 Deploy of `539392e` started.
- 02:35 **P0 from the owner**: classification "Save and publish" (single or
  batch) refused every Alibaba draft; "Really bad experience". Also asked for
  a page-jump box. The 02:32 deploy was cancelled during its tests so one
  deploy could carry the fix. Fix `f90363c` + review fixes `8d7cbdf`.
- 03:00–03:58 Deployed `7f32909` (DEC-19, DEC-20, 5b, P0 fix, "Go to page").
- 03:51 Owner: one of two drafts still failed ("Import up to 18 description
  images…"), and asks why photo import is manual at all. `d54b027`: publish
  takes the first 18 description photos instead of refusing.
- 04:10 Owner: photos belong to the product and its single approval; they
  should be in our storage before an admin sees the draft and must never
  block publishing; admins only add or remove. Answers: untouched drafts
  follow Alibaba until edited; copy photos for all existing drafts; run
  automatically after each sync. Mid-turn additions: a draft must not appear
  until it is ready; more than 18 description photos → tell the admin and let
  them add the rest one by one; after deploying, run the catch-up and report.
- Built PT-G (`609b362`, picker `099ab12`, review fixes `7e3a4c8`); deployed
  `0997cb3` (functions live 05:37).
- 05:38–06:55 Catch-up from the signed-in admin page: about 11,200 photos
  copied; all 957 drafts have their photos; 7 photos failed. Found and fixed
  a time-limit bug (`78a4c47`, deployed 06:16–07:10).
- 07:27 Owner: a product's sync must work like a transaction: "see a
  product's everything as a whole, success then all should success, fail then
  all fail and retry later, but don't affect later other product's data";
  retry sooner than a day; make sure existing drafts can be published after a
  category is assigned (single or batch); and write these retro docs, kept
  up to date.
- `5fd7752`: one product, one unit (below and in DESIGN_AS_BUILT.md);
  formal browser lane 8/8 including a new test that publishes a prepared
  Alibaba draft through "Assign category → Save and publish". Validation
  green.
- 07:50–08:30 Independent review of `5fd7752` before deploying: one P1 (a
  hidden draft approved before its photos landed would stay out of the admin
  list), two P2 (an all-unavailable refresh stopped following Alibaba; the
  10-minute retry was not scheduled). All fixed with tests, then validated
  again (see EXECUTION_LOG "Review of MIU-55 and the fixes").
- 08:10–08:33 Deployed `8cca888` (functions live 08:33). 08:35 retry pass:
  5 drafts saved, the remaining failures traced to one deleted photo, two
  refused (403) and four animated GIFs. 403 now counts as unavailable.
  Read-only readiness check: all 955 drafts have photos, none hidden or
  flagged, none over the image limit; 56 need a product family.
- ~09:00 Owner: most admin list thumbnails are broken; asks for the
  refused-photo product and for GIF support. Cause: the list used the public
  image address, which refuses unpublished photos — a display regression
  from photo copying, data intact. Re-sync of the refused-photo product
  showed Alibaba still lists the photos but blocks them (403). Fixed the
  thumbnails, added GIF support end to end, and "Copy photos now" now
  retries unavailable photos.
