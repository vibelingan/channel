# Common source observation integration — 2026-09-04

## Final decision

Alibaba and Dianxiaomi share a validated **product observation** contract, not
an acquisition workflow and not a public product schema.

```text
Alibaba product.list -> product.get -> immutable raw payload --\
                                                         provider adapter
Dianxiaomi workbook -> immutable raw xlsx -> bounded parser ----------/       |
                                                                    v
                                                  CatalogSourceObservation
                                                                    |
                                                  latest private source view
                                                                    |
                                         explicit review/link/publish (later)
```

This boundary is deliberately below transport concerns and above provider
payload shapes. Alibaba retains time-window bisection, pagination, TOP signing,
OAuth refresh, rate limiting, checkpoints, tombstones and raw-object recovery.
Dianxiaomi retains workbook detection, archive/XML limits, header mapping,
row quarantine, grouping and per-store evidence. Neither adapter writes a
canonical `products` row merely because source data was collected.

The collection is a latest validated observation per provider product key. For
Alibaba, a complete full run can also prove that a product disappeared and set
the wrapper `active` flag to false. A Dianxiaomi export may cover only one
store, so absence from a later workbook is not deletion evidence; its older
observation remains addressable with `observedAt` and `lastSeenOperationId`
until an explicit source-status record says it is missing.

## Alibaba call strategy

The production path remains `product.list` for discovery followed by one
`product.get` per id. The list response is not an economical replacement for
detail: live evidence shows that description HTML, images, SKU selections,
availability, tier rows, MOQ and source status are detail fields.

- Full sync enumerates the historical modification window with the existing
  bounded time-window bisection and page state; it never assumes one response
  contains the whole catalog.
- Incremental sync reuses that enumerator over the committed cursor window.
- `product.get` is the complete-product normalization boundary for every id.
- The admin single-product action remains a read-only contract probe. It is not
  a hidden targeted sync and does not own checkpoint or tombstone state.
- The current raw replay reads already stored `product.get` bodies. It is a
  recovery/migration path, not a substitute for future provider calls.

## Runtime contract

`CatalogSourceObservation` is strict at runtime with Zod. Unknown object keys,
unsafe media protocols, non-canonical timestamps, invalid money, duplicate
variant/offer keys, dangling offer-to-variant references and overlapping price
tiers fail validation before persistence. Provider option and attribute names
are stored as arrays of `{ sourceName, value }`, so source-controlled text never
becomes an object prototype key.

The price contract is a tagged union:

- `fixed`: currency plus one minor-unit amount;
- `range`: currency plus ordered minimum/maximum minor-unit amounts;
- `tiered`: currency plus non-overlapping quantity windows and unit amounts;
- `negotiable`: no invented amount, optional currency/MOQ;
- `unavailable`: no usable currency-bearing price in the source.

Alibaba quantity breaks are supplier quotation evidence. They do not map to the
legacy customer `vipPrice`, which is out of scope.

Descriptions pass through the shared allowlist sanitizer. The observation may
carry sanitized HTML and text; it never carries executable source HTML. Exact
provider bytes remain separately hash-addressed evidence. Frontend code must
validate the observation and render its reviewed projection rather than read
raw provider JSON or call `innerHTML` with source content.

The embedded Alibaba `attr2_value` is special because it is JSON encoded inside
the outer JSON response. It uses the bounded lossless parser rather than lodash
or ordinary `JSON.parse`: empty, null, scalar, array, malformed, oversized and
over-depth values degrade to the direct compatibility attributes without
throwing; exact numeric id lexemes survive; duplicate and dangerous object keys
are rejected.

“Scoped to one SKU” means the product-level attribute dictionary lists all
possible choices, while that SKU's own `attr2_value` selects its actual choice.
For a product defining Black and Red, the Black SKU selects Black and the Red
SKU selects Red. That SKU-specific selection therefore wins over a same-named
generic compatibility value.

## Persistence contract

`catalogSourceObservations` is private (`ADMINONLY`) and uses a deterministic
SHA-256 id over `(provider, sourceProductKey)`. Replays converge on the same
row. The wrapper stores query/provenance fields plus the validated observation:

- provider and source/external product ids;
- schema version, observation/source-update instants and active flag;
- evidence id;
- `firstSeenOperationId` and `lastSeenOperationId`, neutral names that accept
  an Alibaba sync run id or a Dianxiaomi import job id;
- the strict provider-neutral observation.

The large Alibaba raw response is not copied into NoSQL. Its evidence entry
references the existing payload hash/COS object. A Dianxiaomi import first
stores the exact workbook bytes at the private, content-addressed
`catalog-import-raw/<prefix>/<source-sha256>/<job-sha256>.xlsx` path. The import-job row records the
digest and storage pointer; observations reference the exact job that produced
them (`dianxiaomi:<sha256>` for the first import, an `:rN` job for an explicit
replay) and do not duplicate the workbook bytes.

Normal Alibaba detail ingestion now writes the observation beside its existing
source mirror and supplier offers. Every mutable mirror/offer/observation write
rechecks the active lease atomically; a stale owner stops with `lease-lost`.
The provider-absence allowlist is intentionally empty until a sanitized live
`product.get` error fixture or authoritative provider contract confirms the exact
code and envelope. Today every missing/detail-error discrepancy quarantines the
run instead of turning an API failure into a deletion. Once that evidence gate
is satisfied, a confirmed tombstone will deactivate the common row through the
same fenced repair window used for canonical demotion.

Dianxiaomi staging writes one observation per store-scoped source product, while
the candidate/group remains the operator-facing cross-store review unit. Thus
the accepted four-store fixture has 77 grouped candidates but 100 observations.
A later one-store workbook updates only that store's deterministic row and
cannot erase observations belonging to the other stores. An invalid observation
rejects only that staged item and never overwrites the last valid common row.

## Existing-data migration

Alibaba's current 1,074 source products are migrated from immutable raw
`product.get` evidence in pages of at most 20 under the shared Alibaba lease.

1. A dry-run page verifies source/payload metadata, byte size, SHA-256, provider
   envelope and ids, deterministic source key, exact current active offer-key
   set, and the common observation contract. It performs no derived-data writes.
2. The server records each ordered page, its SHA-256 and the authoritative
   active-source total in a private, admin-bound `alibabaRawReplayManifests`
   document. The manifest is sealed `ready` only after every page has passed,
   the cursor chain is contiguous and its row count equals that total.
3. Apply requires the sealed manifest id plus the exact page hash and repeats
   the complete preflight before its first derived-data write. A browser or
   direct caller cannot start page one after validating only page one. A changed,
   expired, cross-admin or out-of-order manifest/page stops with conflict.
4. Apply updates only derived `sourceAttributes` on existing supplier offers
   and upserts the common observation. Each write is atomically lease-fenced;
   offer comparison reads the full active set rather than a 100-row prefix. It
   preserves first/last run provenance and never writes, links, prices or
   publishes a canonical product.
5. Deterministic ids make an interrupted page safe to repeat. Every apply page
   must present the same authoritative total found by dry-run; a changed total,
   page, owner or manifest stops fail-closed. The server advances a fenced apply
   cursor after each page, so only the next manifest page is accepted. Manifests
   expire after two hours and cannot be reused after reaching `applied`.

Expected live invariants from the read-only audit are 1,074 observations,
3,672 active offers represented, 3,661 attributed variants, 10,100 option
pairs, 1,808 tiered USD offers and 1,864 unavailable-price offers. Any mismatch
or per-row failure stops apply for investigation.

## Branch and UI boundary

The stable remote Dianxiaomi feature head was merged into
`fix/alibaba-sync-storage-wiring`; its separate dirty local worktree and newer
UI prototype were not copied or edited. This implementation supplies the
common backend contract that UI can target. It does not adopt either old
Alibaba admin rows or an unpublished prototype as the final UI.

The next UI stage should decode the common observation as `unknown`, display a
source-comparison/review projection, and keep raw evidence behind authenticated
admin routes. Category mapping, product linking and public promotion remain
explicit later decisions.

## Acceptance gates

- common-contract, provider-adapter and malformed-input tests pass;
- real Dianxiaomi acceptance workbook writes 77 grouped candidates and 100
  deterministic store-scoped observations, preserves store prices and writes
  zero canonical products;
- exact Dianxiaomi workbook bytes are recoverable from the private storage
  pointer and match the recorded SHA-256; a single-store follow-up cannot mutate
  other stores' observation documents;
- both function artifacts are self-contained and pass cold-start smoke tests;
- the observation collection and indexes exist with `ADMINONLY` permission, and
  the hidden server-only replay-manifest collection exists with no direct admin
  CRUD access, before deploying the Alibaba function;
- all live Alibaba pages pass dry-run before apply;
- post-apply database counts and sampled tier/attribute/evidence records match
  the immutable raw payloads;
- `products`, source links and category mappings remain unchanged by replay.

## Live acceptance — 2026-09-04

The migration ran against CloudBase environment
`diversity-123-d9grnqfux221323bb` in `ap-shanghai`. The common observation
collection, its two query indexes and `ADMINONLY` permission were confirmed
before execution. The first function deployment used source release `dd501f1`
(`UpdateFunctionCode` request `4d800269-21fa-4f51-b077-e6a1dfa539a2`).

The authenticated Admin control completed a full 54-page dry-run with no row
failures:

- 1,074 source products and observations;
- 3,672 variants/offers, of which 3,661 have SKU-scoped attributes;
- 10,100 attribute pairs;
- 1,808 tiered USD offers and 1,864 unavailable-price offers;
- 1,073 observation warnings.

The first apply attempt stopped after 11 pages / 220 observations with
`page-changed`. This was a fail-closed stop, not a parser or partial-write
failure. A direct source-mirror query showed all 1,074 rows still belonged to
the completed full run and the newest `fetchedAt` remained
`2026-09-03T08:13:10.081Z`; no concurrent source refresh explained the change.
A second complete dry-run reproduced all aggregate values, passed the former
failure page, and the immediately following apply completed all 54 pages and
1,074 observations. Deterministic ids made the first 220 updates harmless to
repeat. The precise transient read cause was not observable because this
environment has no CLS binding and the retired legacy function-log API returns
no invocation detail.

The replay diagnostics were subsequently hardened in `90840ab`: an apply page
with a concrete preflight failure now reports the bounded failure reason (for
example `offer-set-mismatch`) before the generic hash conflict, while source
keys remain private. The safety hash is unchanged. That release was packaged,
artifact-smoked and deployed only to `alibaba-catalog-sync`
(`UpdateFunctionCode` request `b453edb2-dae0-4a10-80a2-14a621eb526d`). The live
health route returned release `90840ab`, Nodejs20.19 remained Active/Available,
and configuration, gateway, OAuth secrets and triggers were not changed.

The Admin diagnostic update was built from the deployed site baseline plus the
Alibaba-only UI commits, not from the merged feature worktree. Only
`_astro/AdminApp.Mnlsj0_I.js` and `admin/index.html` were uploaded; all nine
referenced shared chunks were independently confirmed reachable. The local
Dianxiaomi prototype was therefore not published.

Independent NoSQL reads after apply established the persisted result rather
than trusting the UI status:

- all 1,074 observations have unique document, source and external-product ids,
  schema `catalog-source-observation-v1`, `provider=alibaba`, `active=true`, and
  valid first/last operation provenance;
- all 1,074 evidence ids are SHA-256 values and resolve to an existing raw
  payload metadata row; the replay itself successfully read and re-hashed every
  current `product.get` object before writing;
- observation totals are 3,672 variants, 3,672 offers and 10,100 option pairs;
  the 3,672 common offer ids exactly equal the 3,672 active supplier-offer ids,
  with no dangling variant reference;
- the 1,808 tiered offers contain 4,958 quantity tiers, with zero invalid or
  non-increasing intervals; the remaining 1,864 offers are explicitly
  unavailable rather than assigned an invented price;
- 1,073 descriptions are marked sanitized and 19 are explicit placeholders;
  a 20-record HTML sample contained no script, inline-event, JavaScript URL,
  iframe, object or embed pattern (the strict sanitizer tests remain the
  exhaustive contract check);
- all 6,193 normalized media URLs use HTTP(S);
- the raw registry still contains 2,157 stored, hash-linked objects, while the
  canonical boundary remains `products=7`, `alibabaProductLinks=0`, and
  `alibabaCategoryMappings=0`.

Relevant verification after the diagnostic change: function tests 92/92, site
tests 230/230 with Node 25 experimental Web Storage disabled, repository lint
clean, both affected typechecks clean, and all three packaged function
artifacts pass cold-start smoke.

## Post-acceptance correctness hardening

The integration branch subsequently closed the independent review findings that
were not exercised by the first 1,074-row migration: strict absence-only
tombstones, transaction-fenced source/offer/observation writes, authoritative
replay totals, complete offer scans beyond 100 rows, exact frontend response
keys and cross-field cardinality checks, calendar-valid UTC instants,
store-scoped Dianxiaomi observations, sanitizer provenance, and durable raw XLSX
evidence. These changes require their own function/static release verification;
the preceding live-acceptance section remains the evidence for the earlier
`90840ab` release until that deployment is recorded.

## Hardened release acceptance — 2026-09-04

Independent review found no Critical, Important or Minor blockers at
`27f6128738cee205fd63cd8af04047199025d715`. Typecheck, lint, the CloudBase SDK
contract gate, function artifact cold-start smokes and the focused Site,
Alibaba, DB, catalog-import and local-server suites all passed. The branch was
pushed before deployment.

The hidden `alibabaRawReplayManifests` collection was created and independently
read back with `ADMINONLY` permission. Only the `alibaba-catalog-sync` function
code was updated (`UpdateFunctionCode` request
`8cbbba8f-d65c-4e6b-8a2a-257c7b48d7c6`). Remote detail then reported
Nodejs20.19, `Active` / `Available`, Event type, no triggers, 900-second timeout,
and modification time `2026-09-04 14:44:18`; existing masked environment
configuration was preserved. The matching static Admin build was uploaded and
`admin/index.html` was read back with modification time
`2026-09-04T06:48:36Z`.

An authenticated one-product inspection called `product.get` for
`AAF-BBhgAOVTpOOZBg46XHoO`. It returned 22,933 bytes, an HTML description of
15,882 characters, six images and two SKU offers; both SKUs had scoped option
values and USD tier pricing. Payload
`02b1508207d238bac3a5ade1c70cc7cb33af427e59ea015e2ce485563868d833`
was recorded as `stored`, and an independent storage-info read confirmed the
private 22.40 KiB JSON object exists. The probe wrote no source mirror, supplier
offer, link or canonical product.

The first replay click after function deployment intentionally failed closed on
page two: the already-open browser still ran the older Admin bundle, which did
not echo the new server manifest id after page one. It left one bounded
`collecting` manifest that expires after two hours and made no derived-data
write. After the matching Admin bundle was deployed and reloaded, a fresh
manifest (`raw-replay-3accd8a4-957d-4f19-8cd6-cb2c918bd616`) validated all 54
pages / 1,074 products with the same aggregate values as the earlier audit, was
sealed `ready`, and then applied all 54 pages. The database readback showed
`status=applied`, `nextApplyIndex=54` and `totalSourceProducts=1074`.

Post-apply reads confirmed 1,074 active common observations, 1,074 active
Alibaba source products and 3,672 active supplier offers. The sampled product
contained the sanitized description and text, six media URLs, two variants with
`color` and `Connectors` options, two matching supplier offers, MOQ 2,000 and a
USD 1.07 tier; its evidence hash resolved to the preserved raw payload. The
canonical boundary remained unchanged at seven `products`, zero
`alibabaProductLinks` and zero `alibabaCategoryMappings`.

Finally, the matching release completed normal manual incremental run
`incremental-2026-09-04T07-18-29-824Z` in about three seconds. Its new
173-byte `product.list` response was recorded as stored and independently found
in private storage. The empty update window produced no detail calls or derived
count change, which is the intended daily strategy: list discovers ids and
pagination; detail is authoritative only for ids returned by that window.
