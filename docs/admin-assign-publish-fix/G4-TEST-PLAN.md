# G4 test plan: Admin classification UX and responsive navigation

Status: **IN PROGRESS: initial deploy `24936f0` / run 36849272212 was verified before live testing; subsequent local repairs passed default 158/158 and formal 144/144 browser lanes, but integration, exact-SHA delivery gates and post-fix live acceptance remain pending.** Earlier 157/143 results and failures are preserved in progress history. Live Admin-only acceptance is authorized for the known production-serving `test` target with per-product state snapshots. Scope is the current <=20-product, revision-checked sequential publication workflow in [SPEC.md](SPEC.md), [ui-design.md](ui-design.md) and [miu-breakdown.md](miu-breakdown.md), plus the authorized legacy-category and Archive policy repairs recorded below. The true backend batch and SDK cloud-transaction proof remain deferred in [SDK-PROBE.md](SDK-PROBE.md).

## Test boundary and proof of isolation

- Write unit tests before each active MIU (2 -> 3 -> 4; MIU 5 independent), reusing `apps/site/src/islands/admin/catalog-taxonomy-ui.test.ts` and the existing batch API tests. The initial UI-only plan had no backend repair; live testing later required the authorized legacy-category and safe Archive repairs with red-first DB/API coverage. No SDK/schema/atomic-batch change.
- Extend `tests/e2e/admin-subcategory-visibility.spec.ts` for assignment/publication and focus; extend `tests/e2e/admin-product-family-tabs.spec.ts` for responsive selectors. Run with `pnpm test:e2e:catalog-admin-local`: the runner creates an owned temporary JSON DB and media directory, checks API health `mode:local` and exact DB path, builds a disposable Astro site, sets `E2E_CATALOG_LOCAL_SEED=1`, `E2E_ALLOW_MUTATION=1` and synthetic local credentials, then deletes its temporary directory. The classification spec must reject missing local opt-in. Never set these flags against a CloudBase URL.
- For a focused local Admin regression, `node scripts/run-catalog-admin-local-e2e.mjs --admin-only` uses the same owned DB, production build and cleanup but runs only the seven classification browser cases. This is a diagnostic lane, not a substitute for the unchanged default full regular and formal CI suites.
- The EnvId called `test` in deployment docs routes the live production domains and `/api/admin`. The user explicitly acknowledged this and authorized deployment plus Admin-only live acceptance, selecting products through the signed-in browser. The one existing published candidate below is a real storefront product: its brief withdrawal is customer-visible even if Admin restores business fields. Never use live write probes for SDK atomicity; those still require a physically separate environment.

## Behavior matrix (red-first assertions)

| Scenario and owner | Positive assertion | Negative / side-effect assertion |
| --- | --- | --- |
| MIU 2: row and multi-select default | Both show Save classification and Save and publish, correct selected IDs/count and saved public/draft status; Confirm save sends one `catalogCategories` assignment without `includeSavedRevision`. | No `update` publication call, no default-on publish checkbox, no mutation when Back/Escape is used before confirm. |
| MIU 2: confirmed publish (1 and 2 drafts) | Confirm save and publish sends assignment with `includeSavedRevision:true`; after all saved revisions are returned, sends revisioned `update` requests for exactly those IDs and shows their confirmed final status after readback. | No publish request before full confirmation; zero duplicate calls on repeated Confirm, no claim that the group was atomic or rolled back. |
| MIU 2: rejected assignment / approval | One stale taxonomy/product revision, invalid draft, or supplier detail needing Edit shows the named next action, retaining selected IDs. | Any assignment not fully saved makes **zero** publish updates; supplier review is never silently approved; no automatic retry. |
| MIU 2: partial publish / auth failure | First product confirmed, second rejected -> result shows one confirmed and one needs review; an auth error halts remaining requests. | Confirmed first product is not described as rolled back; `not-attempted` IDs receive no update; no per-product live counter or percentage. |
| MIU 2: timing / readback | Hold assignment and early/late publish responses; immediate result skips a transient indicator, slower result shows one waiting state; a failed active list refetch retains the write receipts. | No second write from Refresh statuses, no `Done`-as-success on failed readback, no busy button/Close interaction during a request. Test the candidate 250 ms threshold deterministically rather than inferring performance from elapsed CI time. |
| MIUs 2–4: ambiguous outcome and safe exit | Drop a publish response after the handler may have committed; final state names confirmed/unknown/not-attempted. Refresh statuses performs reads. When verification remains unavailable, Check later or settled-state Close/Escape returns focus, keeps selection, confirmed receipts and a visible list warning. | Unknown is neither failed nor published, no automatic replay, no second `catalogCategories`/`update` request, no forced stay in the dialog after the request has settled. While a request is still running, Close/Escape cannot dismiss it. |
| MIU 3: role and independent commands | Admin row/bulk entry shares the default-save editor; standalone Publish/Disable use their existing actions and semantic colors; non-admin lacks bulk Assign category. | Opening editor, Clear selection and switching family/section send **zero** write actions; visibility commands never send classification. |
| MIU 5 + MIU 3: responsive geometry | At exact CSS viewport widths 375, 390, 734, 768, 1024 and 1440px, assert document/nav width and table-local scrolling. Manual browser checks at 1440 and 720 CSS px used measured `innerWidth` and a reflow proxy for 200% zoom; native browser zoom remains untested. Desktop keeps active left rail; narrower widths expose labeled Section and family Select. | No document-wide overflow, clipped button, inaccessible action, role-hidden selector choice or label overlapping a preceding/following control. Preserve original Admin command colors. |
| MIU 4: keyboard and focus | Tab through actions and options; before-write Escape/Close cancels with focus returned to opener; after Done/Check later focus returns to row or bulk action. `aria-live=polite` reports meaningful stage/result changes once. | No focus trapped on a hidden element; do not announce a percentage, per-item live counter or falsely final outcome. |

## Acceptance gates

1. Scope approval: the user approved the G1 actions, G2 layout/palette, deferred true backend batching and explicitly confirmed that `test` deploys the live site. They authorized deployment and asked the agent to select products in the signed-in Admin. A/C must be newly created test-only drafts; B's temporary customer-visible withdrawal and complete UI restoration must be logged and rechecked.
2. Per MIU: first observe the relevant assertion fail, implement only that 1–3-file slice, rerun its focused test and typecheck; preserve the preexisting positive/negative API coverage. All existing frontend/API unit tests and the owned local browser lane pass after integration.
3. Before delivery: `pnpm --filter @vibelingan-channel/site test`, `pnpm --filter @vibelingan-channel/site typecheck`, `pnpm exec tsc --noEmit --project tsconfig.e2e.json`, `pnpm exec biome check .`, `pnpm --filter @vibelingan-channel/site build`, and `pnpm test:e2e:catalog-admin-local` must succeed. Inspect browser console/network for errors and verify actual CSS viewport sizes before counting screenshot evidence. Branch-specific CI does not substitute for this local lane.
4. Exit criteria: no schema/SDK/deploy configuration change, no unauthorized production data mutation, no claim of throughput or atomicity improvement. The discovered backend legacy-category fix and safe Archive policy repair are explicitly authorized deviations. Approved live writes require B's business-visible restoration through Admin and A/C archival; disclose that baseline absence, timestamps/audit and transient public visibility cannot be undone. No deletion bypass.

## Requested Admin-only live acceptance and restoration (in progress; fixtures archived)

The `test` branch push automatically deploys the shared CloudBase environment after CI; pushing this feature branch alone does not. First finish the owned local production-build runner, workspace typecheck/lint, diff review, and release-SHA review. Push the reviewed feature branch, pass PR checks, then merge into `test` after identifying safe fixture candidates in Admin. Verify the deployed SHA and read-only public/Admin smoke before a live product write. Never dispatch `catalog_acceptance_only=1`: that existing workflow sets `E2E_ALLOW_MUTATION=1` and uses direct API-backed fixtures outside this UI-only acceptance scope.

Use A/C as two uniquely named, test-only **unpublished, image-free** products created through Admin after deployment. Their original state is absence; do not upload media. The original delete-cleanup plan was disproved by live HTTP 400: products must be archived. Restore/check intermediate categories, archive through Admin, verify unpublished/archived/empty subcategories, and retain the records; absence cannot be restored through permitted UI. B is the existing source-key-empty, published `SY-T8 Wireless Headphone` (Headphones / Bluetooth Headphones; website price $5.50, MOQ 500; preview images loaded). Before touching B, use Admin to capture its unique row identity/SKU, all image and pricing fields, archived/published flags, category and subcategories. Do not assume its displayed name alone is a stable ID. No Alibaba-linked or supplier-review product is a substitute. Admin UI actions necessarily issue the application's own network requests; the tester must not issue standalone `fetch`, `curl`, `adminAction`, direct DB changes or cleanup APIs. Passive browser network observation is allowed only to corroborate what the UI did.

| Fixture and browser action | Positive check via Admin/public pages | Negative check |
| --- | --- | --- |
| A: row Classify -> Save classification -> Confirm save | Category changes in Admin after reload; product remains a draft and absent from the public catalog. | No publication status change; no second write from preview or Cancel. Restore A's starting category before the next case. |
| B: use Admin to withdraw B, then row Classify -> Save and publish -> Confirm save and publish | Changed category and Published status survive Admin reload; the product appears in the public storefront. | A and C are unchanged; no duplicate confirmation write or atomic-batch claim. Immediately restore B's original Bluetooth category while Published and compare all captured fields. |
| A + C: select only these two -> Assign category -> Save classification | Both receive the chosen category after reload and remain drafts. | No product is published; B retains its restored Published baseline. Restore/check A/C's intermediate category, then archive both through Admin and verify archived/unpublished with empty subcategories; do not claim deletion or absence. |

After **each** scenario, use only Admin controls to restore the affected fields before moving on, then reload Admin and public views and compare the captured business-visible state. Do not leave B withdrawn during A/C tests; restore B's original category and Published state before starting the bulk scenario. Archive A/C through Admin at the end and verify retained archived records, unpublished and absent from public search, rather than deleted records. If any write or status is unknown, stop subsequent cases, refresh through Admin only, preserve screenshots/receipts and do not retry blindly; request manual resolution before declaring restoration. Record the cause and recovery of every issue. UI restoration cannot rewind added `createdAt`, `updatedAt`, revisions, audit history, original A/C absence or the temporary public absence/category change of B: only B's original business-visible state can be compared.

## Latest evidence and follow-up gates - 2026-10-02

- Reported live results and exact fixture IDs/baseline are in
	[LIVE-ACCEPTANCE-20261002.md](LIVE-ACCEPTANCE-20261002.md). Actual-admin row
	save-only/cancellation, B publish/per-ID Done/public price and immediate
	restoration, draft Replace/Append/Clear and no-write Clear selection passed.
	A/C were archived successfully via Edit UI, not deleted. B actual prices are
	unit 6.2/wholesale 5.5/VIP 4.3, MOQ 500; nine original ordered images retained.
- Live geometry passes are actual 375/390/734/1024/1440px; 390px modal bounds
	16/374 and scrollWidth/clientWidth 357/357, screenshot no overlaps. Exact
	768px is local only due editor zoom. Synthetic native cancel closes/returns
	focus; transported VS Code keyboard Escape did not. Local real Chromium
	Escape passed; do not call synthetic cancel an equivalent live real-key pass.
	Ordinary scope changes reset ordinary selection intentionally; unresolved
	selection/receipt persistence is proven by local recovery tests.
- Local repair checks: red-first DB regression + DB 51/51 + tsc; safe exact
	Archive `{archived:true,published:false}`, single/bulk authoritative readback,
	API 16/16 and owned Admin 8/8. Reject other product bulk-update combinations;
	deduplicate <=20, sequential execution and unknown-stop, with no atomicity
	claim. New browser case uses drafts only; existing server coverage proves
	published withdrawal. Independent assumption-checker no new P1/P2, archive
	graph PASS.
- Full pre-integration gates: 2,755 unit passes/3 skips, default 158/formal 144
	browser passes with cleanup, 19 workspace/E2E plus site/test types green,
	Biome 760 green after terminal-newline formatting in three local ignored
	review JSON files, three function builds/artifact smoke green. Root
	typecheck/build:functions wrappers offered unpinned pnpm via npx; declined
	installation, then pinned no-install equivalents passed.
- Pending: integrate PR #64 price-tier changes at remote `test` `2f8567f`,
	commit, exact-SHA review, CI, merge, deploy and post-fix live acceptance.
	Independent public-only image check remains pending after a blank screenshot
	in the hidden shared tab. No pageerror observed; console 400 from failed
	Remove is known and must not be labeled clean console. Do not mark deployment
	of the repairs or overall live acceptance complete.
