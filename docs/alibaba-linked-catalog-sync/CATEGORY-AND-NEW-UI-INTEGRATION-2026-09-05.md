# Alibaba categories and shared product UI integration

> Scope update: the user's later September 5 decision pauses category work and
> prioritizes local shared-detail UI implementation. Follow
> `SHARED-PRODUCT-UI-FINAL-SCOPE-2026-09-05.md` for the active order and scope;
> the category-first sequence below remains historical planning context.

Date: 2026-09-05. Status: investigation and implementation plan; offline category
audit implemented. Live category repair and the new real-data UI are NOT complete.

## What is actually wrong

The supplier catalog and the website navigation use different taxonomies.
`products.productFamily` drives the four website tabs. `products.category` is
still the legacy enum `wired | office | bluetooth`, not a general category tree.
`sourceCategoryMappings.channelCategory` has the same restriction.

The previous verified 2026-09-04 snapshot had 1,074 Alibaba drafts plus seven
legacy products. Five source-category mappings covered 716 Alibaba headphones;
358 Alibaba products had no website family. These were already materialized,
not missing from the API sync. Examples observed during that audit included
clocks, fans, lamps and motors. These numbers are historical evidence, not a
fresh database count on September 5.

The current root cause is incomplete website classification, not evidence that
Alibaba sells only headphones. An empty AI Gadgets or Toys tab is not proof of
missing acquisition, either: those assignments must be supported by product
facts. Ordinary electronics are not automatically AI products.

The earlier explanation “a large category mixes products, so leave subcategory
empty” was incomplete. Many categories are fine. Two real constraints are:

1. Alibaba category IDs do not mean the same thing as our three headphone enum
   values. A mixed supplier category cannot map every child to one specific
   website subcategory without checking product-level facts.
2. Connectivity and use case overlap: a Bluetooth headset may also work by cable
   and be intended for office use. Those facts are often facets, not mutually
   exclusive children of a category tree.

Source category ID is already retained in the mirror, observation and draft
review. The Alibaba adapter retains a provided category path in the normalized
mirror and a joined label in the common observation. The audited live responses
had IDs but no category paths. We must not fabricate a missing provider label.
Remapping saved observations does not require repeating OAuth or product.get.
Only missing vendor taxonomy metadata may require its own supported lookup.

## Branch and deployment evidence

Read-only branch inspection on September 5:

| Surface | Evidence | Meaning |
| --- | --- | --- |
| Current work | `fix/alibaba-sync-storage-wiring@97c645a` before this change | Existing Alibaba implementation baseline; initially clean |
| Stable import | `origin/feat/dianxiaomi-excel-import@0cf5526` | Entire branch is an ancestor of current HEAD; current HEAD is 54 commits ahead |
| Main | `origin/main@78506d5` | Stable import branch is 37 commits ahead of main; do not claim it is merged to main |
| Test git ref | `origin/test@73fd85b` | Does not contain stable import head; branch name is not a receipt for later manual deployments |
| Import local worktree | `channel-dianxiaomi-excel-import@396981f` | Dirty application files and untracked RFQ prototype remain separate; do not reset or wholesale merge |
| Catalog refactor | `origin/refactor/catalog-architecture-hardening@03b5f17` | Recent commits centralize SEO pricing and mark MIU 14 active; old design snapshot at MIU 12 is stale |

The user-visible Import Categories menu proves that an entry is rendered. It
does not identify the full deployed backend SHA or validate a worker.
Current `CatalogImportPage` is a read-only jobs/items screen using generic Admin
list actions. Its empty state explicitly points to the local workbook CLI.
`runCatalogImport` is invoked by the local CLI and tests; the current admin HTTP
handler does not invoke it. Merely deploying these service source files does not
start ingestion. No autonomous importer was found in this code path.

Therefore, “backend without a worker stays idle” matches the current acquisition
path, but is not a universal deployment safety guarantee. Future upload/finalize,
queue consumers or timer entrypoints must each be explicitly gated. Read-only
menus can be deployed separately from import execution. Local parsing acceptance
is not a completed cloud upload/queue/retry acceptance test.

Live verification attempted today: CloudBase NoSQL MCP twice failed resolving
`tcb.tencentcloudapi.com`; curl to the deployed Admin timed out resolving the
domain; selecting the existing authenticated Chrome Admin tab timed out. No
credential extraction, permission bypass, network reconfiguration, remote
category write, publication or deployment was performed.

## Approved UI source and what must change

Use the existing uncommitted prototype in the import worktree:
`docs/dianxiaomi-excel-import/product-detail-rfq-prototype/src/App.jsx` and
`src/styles.css`, plus its desktop/mobile visual references. Preserve that
worktree. It is a client-discussion prototype, not a production implementation.

Retain its image-led detail, gallery, option selection, specifications disclosures,
mobile sticky CTA and contextual RFQ sheet. Replace hardcoded Xiaomi title,
four color/storage combinations, inventory, specification claims and demo
reference. Missing fields must stay “Available on request”, not plausible fiction.
The prototype’s own design QA still records browser visual acceptance as blocked.

Do not copy its demo submission behavior into production: quote success requires
a persisted server-derived request reference. Quote and product customization
remain distinct intents. No new general layout or design system is needed.

## One shared contract, two different collectors

```text
Alibaba list -> selected product.get -> raw evidence --+
                                                      +-> CatalogSourceObservation
Dianxiaomi workbook -> parse/stage -> file evidence ----+
  -> reviewed canonical product + variants + approved content
  -> existing Catalog summary/detail projection -> gateway/state -> shared UI
```

Reuse `CatalogSourceObservation`, not a second Alibaba-only UI model. It already
supports identities, category, description, media, variants, options, inventory,
offers and evidence. Acquisition/retry/cursor semantics remain provider-specific.
Source keys and evidence are private; website product/variant IDs are canonical.

The common observation is not itself the public API. Reuse and update the
existing refactor contracts, projection, family adapters and media/state modules
identified in the September 2 HLD/LLD. Inspect their current interfaces before
porting files; do not merge the whole active refactor branch just for its age/name.

| Concern | Shared UI contract and ownership |
| --- | --- |
| Lists | Lean summaries, real pagination, canonical product ID; no full variants per card |
| Detail | Selected product only; bounded/paged variants if the product exceeds the detail limit, never silent truncation |
| Options | Preserve source label/value facts; explicit variant identity; do not assume every product has Color/Storage |
| Images | Common gallery; variant image only when explicitly linked; no gallery-index-to-SKU inference |
| Pricing | Fixed/tiered/range/negotiable/unavailable; currency and quantity windows preserved; supplier offers are not approved website sale prices; no VIP work |
| Inventory | Unknown is not zero; supplier available quantity is not our warehouse stock; retain semantics and snapshot time privately |
| Content | Conservative extracted text/spec groups; no raw HTML rendering or unsupported phone-specific claims |
| Review | Source listing approved/published does not mean website published; new drafts stay unpublished and pending review |
| Media privacy | Authenticated byte preview for unpublished media; no private COS/raw URLs in public DTO/DOM |

Use existing Query/Table and Catalog architecture. Detail state is keyed by
product + request generation; ignore stale responses, reset selected variant on
product changes, and preserve list pagination/filter state on Back. Gallery
normalization/deduplication/bounds stay in the existing media owner. No new state
library is needed just to support a second provider.

## Ordered implementation and acceptance gates

### 1. Complete the category coverage audit and repair visible gaps

- Export a consistent, `_id`-ordered snapshot of all active observations and linked
  products using authenticated backend access. Keep files ignored/private.
- Run `pnpm --filter @vibelingan-channel/catalog-import audit:categories <file>`.
  Input is an array of normalized observations, not database envelopes. Extract
  the `observation` field server-side. This command has no network or write path.
- Reconcile valid unique observations + invalid/duplicate findings to input count;
  match source IDs to links and products. Count website families separately.
- Create reviewed exact source-category mappings. Sample all ambiguous groups,
  not just their first title. Never map all remaining products to Toys or AI.
- Add an explicit Unclassified admin view/filter with a pending-review indicator.
  “All products” must retain every draft irrespective of mapping.
- Backfill only missing machine-owned classification on eligible linked drafts.
  Capture dry-run before/after and mapping revision; compare expected current
  values when applying to avoid overwriting concurrent admin edits.
- Acceptance: source/link/draft totals unchanged; only approved classification
  changes; no published/price/description/review reset; repeat application no-op;
  each mapped family visibly contains the expected product IDs.

### 2. Replace the headphone-only category limitation additively

- Introduce a provider-neutral website category registry with stable ID, parent,
  name, family and active state; validate parent existence and prevent cycles.
- Add a canonical category reference through the common schema; preserve legacy
  `category` for old URLs/readers until migration completes. Do not change the
  meaning of the existing field in place.
- Keep provider taxonomy metadata and source-to-website mappings separate.
  Store original source IDs/names once per current observation plus immutable
  revision evidence; absence is explicit. No automatic creation of public
  categories from arbitrary vendor input.
- Add facets for overlapping facts such as connection type/use case. Category
  creation and mapping are admin actions, not a reason to resync raw data.
- Deploy compatible readers first, then writers/backfill, then new UI selectors.

### 3. Make the new detail UI consume canonical data locally

- Reuse the prototype visual anatomy, but implement it within current Catalog
  presentation modules and existing shell. Keep importer-specific code out of JSX.
- Extend the canonical variant/content projection once for both providers.
  Source-to-canonical changes must preserve operator-owned content and prices.
- Local test fixtures: real headphones with multiple SKUs/tiers, a non-headphone,
  unavailable pricing, missing media/description, and the real Dianxiaomi sample.
  Record capture date and expected mapped fields; never add credentials/raw
  evidence URLs to fixtures or git.
- Use local-only cloned drafts and the production projection/handler paths.
  A public-UI test can use explicitly published local copies; never publish the
  real cloud drafts just to preview them. Browser must not call Alibaba directly.
- Verify desktop 1440x1024 and mobile 390x844: gallery, SKU changes, correct tier
  boundaries/currency, unknown stock, missing states, Back/URL state, stale
  requests, and no console errors. RFQ stays non-sending until its durable path
  is implemented and separately verified.

### 4. Integrate and deploy the smallest verified slice

- Stable import code is already in this workstream; no duplicate feature merge.
- Review and port selected dirty UI changes without overwriting the source
  worktree. Do not pull unrelated AI or unfinished refactor changes.
- Run shared/provider contract tests, local import acceptance, public privacy
  tests, admin review/pagination tests, and browser regression tests.
- Record exact source/build SHA and deployed function/frontend receipt; a stale
  `test` ref or menu label cannot substitute for deployment evidence.
- Leave import execution disabled/unexposed until its cloud workflow is ready;
  deploying shared UI or read-only import screens need not activate ingestion.

## This turn's implementation boundary

Implemented the offline audit and tests in `packages/catalog-import/src/category-coverage*`.
It validates with the existing strict common schema, includes non-headphone and
missing categories, scopes IDs by provider, detects duplicate identities, retains
conflicting category labels, and excludes evidence/media/account data from output.
It does not propose automatic website mappings or mutate data.

Not completed: fresh cloud counts, category backfill, new canonical category
registry, adapted UI, real-Alibaba local browser acceptance, branch merge or
deployment. Network/browser failures block the live evidence step; they do not
justify inventing taxonomy or declaring the new UI ready.

Verification: catalog-import suite 264/264 passed (including five new audit
tests); package typecheck passed; changed-file Biome check passed; `git diff
--check` passed. CLI smoke with an empty input file returned exit 1 and the
redacted `Invalid JSON snapshot` message, as intended. No live snapshot was
available for an honest real-data audit run today. Changes are local and
uncommitted on the existing wiring branch.
