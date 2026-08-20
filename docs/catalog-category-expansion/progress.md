# Catalog Category Expansion — Progress

## 2026-08-19

- Interpreted the requested deliverable as requirements and UI design only, with implementation deferred until client confirmation.
- Confirmed `main` is the code source of truth and refreshed `origin/main`.
- Created `feat/catalog-category-design` from `origin/main` at `273987d`.
- Installed/verified repository pre-commit and pre-push hooks.
- Recorded the initial hierarchy, scope boundaries, and integration hypothesis.
- Inspected main's current catalog schema, public API, storefront route, generic admin CRUD, and pinned tests.
- Located the Alibaba implementation on `feature/alibaba-linked-catalog-sync` and extracted its canonical-product promotion boundary and explicit category-mapping contract.
- Inspected implemented and planned SEO/GEO constraints for canonical URLs, breadcrumbs, schema, sitemap, and claims.
- Rejected overloading the current Headphones `category` enum; selected an explicit product-family plus optional subcategory model for design.
- Confirmed the shared preview had stopped before route inspection. The documentation worktree has no installed dependencies, so visual research will use the existing OEM main worktree at the same `273987d` commit on a dedicated port.
- Inspected the live Headphones baseline at mobile and desktop sizes: dedicated hero, grouped Office/Bluetooth/Wired product matrix, shared SKU card fields, inquiry CTA, branded image fallback, and unauthenticated Admin redirect.
- Completed independent requirements and UI design reviews. Both confirmed that SKU details need real SSR URLs and that Admin should use one Products section with internal family tabs.
- Selected compatibility-first URLs: preserve `/headphones/`, add sibling family routes, and use category-independent `/products/{slug}/` SKU URLs.
- Authored the consolidated client requirements/UI design and a one-page confirmation checklist.
- At the end of the 2026-08-19 design-only session, final documentation validation passed and
	implementation was intentionally deferred pending client confirmation. The client subsequently
	approved V1.1 and MIUs 1–25 were implemented; final state is recorded below.
- Clarified that `productFamily` is a proposed internal field, not an existing main/Alibaba field.
- Added a non-technical client Word source containing all public-site and Admin wireframes, Alibaba behavior, scope, and confirmation decisions.
- Locked Phase 1 to menu/basic-page presentation, existing Headphones seed verification, and active storefront VIP suppression.
- Deferred schema/API/Admin/Alibaba/SKU URL and permission decisions from Phase 1.
- Authored `LOW_LEVEL_DESIGN.md` and an implementation-ready 12-MIU DAG with deploy-safe and local-seed E2E separated.
- Reconciled the customer requirements/Word document so the full Admin/SKU vision is explicitly later-phase work.
- Completed independent tech-lead and assumption reviews; all blocking findings were closed.

## Validation Log

| Check | Result |
|---|---|
| Planning files created | Passed (`git diff --check`) |
| Same-commit visual baseline | Completed on `http://127.0.0.1:4342/` |
| Documentation contract | Passed required-section and key-contract assertions |
| Cross-document links and terminology | Passed across 5 Markdown files |
| Repository typecheck | Passed for all packages/apps and E2E; Astro reported 0 errors, 0 warnings, 7 baseline hints |
| Repository lint | Passed: Biome checked 279 files with no fixes |
| Final `git diff --check` | Passed |
| Initial DOCX conversion and archive check | Passed; Word 2007+ archive valid |
| Initial DOCX content round-trip | Passed all required client sections and Chinese text checks |
| Strict HTML source check | Found raw display ampersands; corrected before final regeneration |
| Phase 1 LLD/MIU structure | Passed: 12/12 MIUs include mandatory fields, 1–3 files, TDD assertions, and compile criteria |
| Phase 1 scope consistency | Passed: menu/basic pages/seed now; schema/API/Admin/Alibaba/SKU/SEO hierarchy later |
| Client DOCX Phase 1 round-trip | Passed: implementation order and production publication gate survived conversion |
| Final repository typecheck | Passed: all packages/apps and E2E; Astro 0 errors, 0 warnings, 7 baseline hints |
| Final repository lint | Passed: Biome checked 279 files with no fixes |

## 2026-08-20 Implementation

- Client PDF V1.1 is authoritative; implementation is approved on the single
	`feat/catalog-category-design` branch.
- MIU 1 split product images to 9 while preserving Overstock/legacy at 18 (`384dff5`).
- MIU 2 added product family, identity, lifecycle, and hidden reservation contracts (`0a4938b`,
	public package export `953546f`).
- MIU 3 provisioning creates `catalogProductIdentities` with `ADMINONLY` permission (`7a76c42`,
	corrected to the single required collection in `240a08a`).
- Atomic owner-checked delete and installed SDK remove probes landed in `06b32d0` and `7b709f0`.
- Replaced the initial reserve/compensate design after concurrency review: product save and
	reservation transfer now run in one CloudBase transaction / local critical section (`fffebae8`).
- CloudBase runtime probes verify post-write rollback, conflict retry, and one-transaction adapter
	wiring (`65a7bfa`). Real local adapter tests verify concurrent single-winner persistence and
	reopen parity.
- MIU 3 Admin repository canonicalizes identity input and maps storage outcomes to stable domain
	errors (`785af0a`). MIU 3 is complete.
- MIU 4 moves lifecycle validation inside the atomic product/identity transaction (`4c07f9d`),
	routes Admin create/update through that authority, blocks hard/batch product bypasses, preserves
	legacy missing-archive published rows, rejects VIP/Alibaba forged writes, and returns the
	transaction-authoritative previous row for image visibility deltas (`dd83b16`). MIU 4 is complete;
	MIU 5 public product projection is complete.
- MIU 5 exposes valid product family/SKU/slug fields, projects legacy Headphones without storage
	mutation, enforces products 9 vs Overstock 18 images, and suppresses archived/malformed products
	with one bounded DB query (`48cc3ac`). The internal false-or-missing predicate stays outside the
	client filter protocol; installed CloudBase `exists(false)` and translator wiring are probed in
	`d5a9a25`. MIU 6 family filtering is active.
	- MIU 6 adds a bounded database family predicate with explicit and legacy Headphones matching,
	  strict publication/archive parity, closed-set query parsing, and family/subcategory/search/page
	  composition (`e0e4940`). Local Express now delegates catalog HTTP semantics to the production
	  adapter, with real repeated-query/method/header tests (`298feaa`). Installed CloudBase nested
	  query translation is probed in `e61d445`. MIU 6 is complete; MIU 7 slug detail lookup is active.
	- MIU 7 adds canonical published/non-archived slug detail lookup, uniform hidden-state 404s,
	  pre-normalization raw-path safety, gateway-prefixed/stripped routing, and a local regex bridge
	  that delegates to the production HTTP adapter (`43f7bd3`). MIU 7 is complete; MIU 8 site DTO and
	  fetch helpers are active.
- MIU 8 extends the storefront DTO and query contract, adds encoded family/slug and related-product
	helpers, reads the current token per request, forwards AbortSignal, and caps product media at nine
	without changing Overstock (`545c2f4`). MIU 8 is complete; MIU 9 catalog content registry is
	active.
- MIU 8 browser trust boundaries now decode envelopes and validate the complete present product,
	image, status, and Alibaba pricing/tier shapes before data reaches UI consumers (`7e610c3`). Craft
	gates report zero findings new since baseline.
- MIU 9 preserves six Headphones with one intentional no-family legacy row and adds two synthetic
	local-only fixtures for each AI Gadgets, Toys, and Misc family. Startup atomically repairs all
	slug/SKU reservations, fails closed without partial writes on conflicts, and reconciles image
	refcounts across database pages (`6ec055d`). MIU 9 is complete; MIU 10 content/menu is active.
- MIU 10 adds the typed four-family copy/media registry (`12f8cbf`) and replaces the flat
	Headphones nav with ordered desktop/mobile native disclosures, visual active state, 44px targets,
	Escape/focus/outside dismissal, and server-rendered no-JS links (`63ce22f`). MIU 10 is complete;
	MIU 11 Electronics & Toys hub is active.
- MIU 11 adds the static Electronics & Toys hub, four registry-backed image family destinations,
	a direct quote CTA, and an API-backed Featured Products island with loading, retryable error,
	empty, and real-data states. Products without a usable slug are omitted instead of producing
	invalid detail links. The public metadata inventory now verifies the hub title, description,
	uniqueness, bounds, and BaseLayout bindings. MIU 11 is complete; MIU 12 shared family catalog
	controller/grid is active.
- MIU 12 adds one family-aware controller and link-only catalog grid. It reuses the proven catalog
	reducer for generation guards and overlap dedupe, resets/aborts on family/filter/search changes,
	omits unconfigured filter bars, and renders only valid slug links with Alibaba/public/quote pricing.
	No VIP or video surface is present. MIU 12 is complete; MIU 13 family route shells are active.
- MIU 13 preserves the reviewed Headphones hero/canonical/enquiry flow while switching its catalog
	to the shared family controller, and adds registry-owned AI Gadgets and Toys shells with breadcrumb,
	one H1, canonical metadata, and quote CTA. MIU 13 is complete; MIU 14 Other Electronics route and
	metadata inventory is active.
- MIU 14 adds the registry-owned `/misc/` shell, makes the metadata audit compare discovered routes
	to audited values dynamically, and derives sitemap family inclusion from structured catalog
	frontmatter. MIU 14 is complete; MIU 15 SKU detail shell is active.
- MIU 15 adds the static `/products/item/?slug=` shell and abortable detail controller with distinct
	loading/not-found/error/retry states, max-nine Gallery, facts/MOQ, Alibaba/public/quote pricing,
	registry-owned OEM content, enquiry CTA, and nonblocking same-family related links. MIU 15 is
	complete; MIU 16 Admin Products family tabs is active.
- MIU 16 renames the Admin catalog section to Products, adds All/four-family URL-backed controls,
	composes family independently with search and flat AND/OR filters across Admin/server/DB adapters,
	resets page/selection, prefills New, and adds responsive mobile navigation/table containment. MIU 16
	is complete; MIU 17 product form and nine-image management is active.
- MIU 17 enforces `hideInForm`, groups product fields, clears incompatible Headphones subcategories,
	renders Alibaba status read-only, maps server errors to fields, and hardens nine-image management
	with Primary ordering, committed-plus-pending capacity, over-limit blocking, and linked image errors.
	MIU 17 is complete; MIU 18 public/auth VIP presentation suppression is active.
- MIU 18 removes VIP values/labels/locks from Headphones and auth presentation while preserving legacy
	storage/API/role compatibility. Manual public pricing is viewer-independent (wholesale, unit, quote),
	Alibaba link-identity routing remains unchanged, and Overstock is untouched. MIU 18 is complete;
	MIU 19 Alibaba compatibility regression suite is active.
- MIU 19 adds test-only V1.1 Alibaba compatibility coverage for unmapped/mapped drafts, exact curated
	field preservation on link/unlink/promotion, exact fenced promotion patch keys, and complete generic
	Admin ownership including the operator pin. MIU 19 is complete; MIU 20 catalog SEO/breadcrumb work
	is active.
- MIU 20 adds matching visible and structured breadcrumbs for the catalog hierarchy, an explicit
	index-follow JSON-LD graph policy, runtime publication-complete Product schema, fixed/range
	Offer provenance, query-SKU canonical timing, strict browser pricing decoding, and deterministic
	static sitemap/noindex behavior. Two independent assumption-audit rounds found and closed range
	misrepresentation, weak tier decoding, incomplete Product eligibility, premature canonical
	promotion, unknown-key acceptance, stale fixtures, and impossible-date normalization. MIU 20 is
	complete; MIU 21 public/Admin workflow E2E is active.
- MIU 21 adds explicit deploy-safe catalog and non-mutating Admin UI suites plus a real catalog
	lifecycle confined to a nonce-verified disposable local database. Public coverage now includes
	no-JavaScript navigation, reduced motion, family/filter/page composition, page append/reset, and the
	full hub/family/SKU workflows. Workflow secret scopes and post-deploy catalog execution are explicit.
	Independent review found and closed stale slash-active state, missing filter/pagination behavior,
	unsafe shared-environment cleanup assumptions, false locality flags, fixed-port races, signal cleanup,
	and overly broad secret exposure. At that point MIU 21 was complete and MIU 22 delivery
	verification became active; the final state is recorded in the remediation/delivery section below.

| Implementation check | Result |
|---|---|
| Shared tests | Passed: 91/91 |
| DB tests after atomic save | Passed: 40/40 |
| Real local adapter identity tests | Passed: 4/4 |
| DB + local-server typecheck | Passed |
| Installed CloudBase SDK contract | Passed, including post-write abort and conflict retry |
| MIU 4 Admin tests | Passed: 170/170 |
| MIU 4 DB tests | Passed: 40/40 |
| MIU 4 real local adapter tests | Passed: 7/7, including archive/publish and duplicate-publish races |
| MIU 4 function artifacts | Passed: Admin, public-api, and Alibaba builds/package/cold-start smoke |
| MIU 5 public API tests | Passed: 52/52 |
| MIU 5 shared tests | Passed: 92/92 |
| MIU 5 strict archive SDK probe | Passed |
| MIU 5 function artifacts | Passed: Admin, public-api, and Alibaba build/package/cold-start smoke |
| MIU 6 shared/public/local tests | Passed: 94/94, 56/56, 10/10 |
| MIU 6 family query SDK probe | Passed |
| MIU 6 function artifacts | Passed: Admin, public-api, and Alibaba build/package/cold-start smoke |
| MIU 7 public/local tests | Passed: 60/60, 11/11 |
| MIU 7 function artifacts | Passed: Admin, public-api, and Alibaba build/package/cold-start smoke |
| MIU 8 site tests | Passed: 150/150; focused API tests 11/11 |
| MIU 8 Astro typecheck/build | Passed: 0 errors, 10 static pages |
| MIU 9 local tests/typecheck | Passed: 23/23; TypeScript clean |
| MIU 10 site/source tests | Passed: 157/157; Astro 0 errors |
| MIU 10 browser interactions | Passed: 3/3 desktop/mobile Playwright tests |
| MIU 10 visual review | Passed: desktop/mobile open-menu screenshots, no overlap/overflow |
| MIU 10 site build | Passed: 10 static pages |
| MIU 11 site tests | Passed: 157/157, including public metadata inventory |
| MIU 11 typecheck/lint | Passed: Astro 0 errors; E2E TypeScript clean; scoped Biome clean |
| MIU 11 browser states | Passed: 2/2 loading/error/retry/real/empty/responsive Playwright tests |
| MIU 11 visual review | Passed: 375px mobile and exact 1440×900 desktop; four assets loaded; no overflow |
| MIU 11 site build | Passed: 11 static pages, including `/electronics-toys/` |
| MIU 12 focused state/render tests | Passed: 6/6 reducer, pricing, slug, lifecycle, SSR states, fallback, and pagination-edge contracts |
| MIU 12 site tests | Passed: 163/163 |
| MIU 12 typecheck/lint | Passed: Astro 0 errors; scoped Biome clean |
| MIU 12 site build | Passed: 11 static pages (components are consumed starting in MIU 13) |
| MIU 13 route/source tests | Passed: 8/8 focused registry, hero, canonical, and metadata checks |
| MIU 13 browser integration | Passed: 3/3 routes across 375px and 1440px; exact family queries and no overflow |
| MIU 13 visual review | Passed: AI Gadgets desktop and Toys mobile screenshots, no overlap/overflow |
| MIU 13 site tests | Passed: 163/163 |
| MIU 13 typecheck/lint | Passed: Astro 0 errors; E2E TypeScript clean; scoped Biome clean |
| MIU 13 site build | Passed: 13 static pages, including `/ai-gadgets/` and `/toys/` |
| MIU 14 metadata/indexing tests | Passed: dynamic route inventory and published-content sitemap filter |
| MIU 14 browser integration | Passed: 4/4 family routes across 375px and 1440px |
| MIU 14 site build | Passed: 14 static pages, including `/misc/` |
| MIU 14 generated sitemap | Passed: 5 catalog URLs included; 4 private/redirect URLs excluded |
| MIU 14 site tests/typecheck | Passed: 164/164; Astro 0 errors; E2E TypeScript clean; scoped Biome clean |
| MIU 15 focused detail/media tests | Passed: 14/14, including nine-image cap and SSR state rendering |
| MIU 15 browser journeys | Passed: 4/4 direct/share/back, not-found, retry, and delayed-related degradation |
| MIU 15 site tests/typecheck | Passed: 167/167; Astro 0 errors; E2E TypeScript clean; scoped Biome clean |
| MIU 15 site build | Passed: 15 static pages, including `/products/item/` |
| MIU 16 focused query tests | Passed: 5/5 helper and real-handler composition/rejection checks |
| MIU 16 Admin browser regressions | Passed: 6/6 tabs, URL recovery, reset, prefill, mobile, and session flows |
| MIU 16 site tests | Passed: 170/170 |
| MIU 16 runtime tests | Passed: Admin 172/172; DB 40/40; local-server 23/23 |
| MIU 16 typecheck/build | Passed: Admin/local/site/E2E clean; 15 static pages; scoped Biome clean |
| MIU 17 focused form tests | Passed: 7/7 grouping, transition, payload, ordering/capacity, and error contracts |
| MIU 17 Admin browser form | Passed: 2/2 edit/media and field-error journeys |
| MIU 17 site tests/typecheck | Passed: 177/177; Astro 0 errors; E2E TypeScript clean; scoped Biome clean |
| MIU 17 site build | Passed: 15 static pages |
| MIU 18 focused pricing/source tests | Passed: 15/15 wholesale/unit/quote, parity, Alibaba, and negative-source contracts |
| MIU 18 public/auth browser negatives | Passed: 11/11 family, SKU, login, and register checks |
| MIU 18 site tests/build | Passed: 179/179; Astro 0 errors; 15 static pages; built Headphones/auth scan clean |
| MIU 19 focused compatibility tests | Passed: 28/28 linking, promotion, and shared ownership checks |
| MIU 19 full tests/typecheck | Passed: Alibaba 74/74; shared 95/95; both typechecks clean |
| MIU 19 function artifact | Passed: Alibaba build plus Admin/Public/Alibaba package cold-start smoke |
| MIU 20 focused SEO/pricing/render tests | Passed: 44/44 |
| MIU 20 site tests | Passed: 191/191 |
| MIU 20 typecheck/lint | Passed: Astro 0 errors; E2E TypeScript clean; Biome 314 files clean |
| MIU 20 browser integration | Passed: 8/8 family/SKU tests on fresh guarded server, including canonical error/retry transitions |
| MIU 20 production build | Passed: 15 static pages with `SITE_URL=https://example.test` |
| MIU 20 generated artifact parser | Passed: 5 BreadcrumbLists, SKU `noindex,follow`, no static Product/Offer/AggregateOffer, SKU absent sitemap, 5 catalog URLs present |
| MIU 20 assumption audit | Passed: final independent audit reported no findings |
| MIU 21 deploy-safe public browser | Passed: 16/16 menu/hub/family/filter/pagination/SKU/no-JS/reduced-motion journeys |
| MIU 21 non-mutating Admin browser | Passed: 6/6 tabs/mobile/form/media/error/VIP-free journeys |
| MIU 21 disposable Admin lifecycle | Passed: 1/1 create/move/duplicate/publish/public/unpublish/archive; exact temp DB removed |
| MIU 21 site/local tests | Passed: site 191/191; local-server 23/23 |
| MIU 21 typecheck/build/lint | Passed: Astro 0 errors; local/E2E TypeScript clean; 15-page build; Biome 317 files clean |
| MIU 21 workflow contract | Passed: YAML parse, secret scopes, dispatch populations, and post-deploy catalog lane |
| MIU 21 assumption audit | Passed: final independent audit reported no findings |
| MIU 22 exact local integration | Passed: exact 6/2/2/2 seed, one legacy Headphones row, real SKU browser, Admin lifecycle, and whole-DB cleanup |
| MIU 22 runner failure paths | Passed: API/site spawn failures both remove and verify the temporary directory |
| MIU 22 deployment contracts | Passed: 25/25 |
| MIU 22 function/SDK/static gates | Passed: three function builds/packages/cold starts, CloudBase SDK contract, 15-page build, secret scan, Biome 319 files |
| MIU 22 assumption audit | Passed: final independent audit reported no findings |
| MIU 22 remote delivery | Passed: implementation candidate `7252af0` pushed; PR #27 open |
| MIU 22 test preview | Delivered by merging into `test` (`0fa5962`). CI `32325527620` passed. Deploy Test `32325527543` deployed successfully; its smoke then caught a real defect (empty `ai-gadgets` family), fixed in `SMOKE_REQUIRED_FAMILIES`. The earlier feature-branch dispatches failed only because dispatch is the wrong delivery route |
| MIU 22 production smoke | Not run: production approval was not provided |

## 2026-08-20 Remediation And Final Delivery

- MIU 23 restored published legacy products and the existing in-page detail journey without
	requiring slugs or mutating production records (`65ba453`, `25d06f6`).
- MIU 24 made the shared card/grid self-contained, eliminated grey empty tracks, aligned card
	regions, stabilized first paint/header hydration, matched CSS/JS media-query semantics, and
	clamped Admin table text with full-value tooltips (`d6972a5`, `182ff6d`, `d63138e`, `1b16b74`,
	`8f64659`).
- MIU 25 repaired spec discovery, deployed smoke assumptions, capacity-fixture arithmetic, and
	public browser assertions against the approved information architecture (`1e4f3ff`, `2dcce50`,
	`b897b7b`, `b06c17c`, `dcbc8f2`).
- Final feature SHA `8f64659` was merged directly into `test` as `a4d0bc5`.
- CI run `32359898730` passed.
- Deploy Test run `32359898758` passed: CloudBase deploy, deployed smoke, public browser E2E
	37/37, and catalog E2E 16/16.
- Safari/WebKit header/catalog behavioural validation passed 6/6.
- PR #27 remains open against `main`. No implementation MIU remains; next action is to query its
	live head/checks and review/merge through the normal PR gate when green. Production smoke is not
	authorized.