# Untouched Alibaba draft acceptance — 10 September 2026

Baseline: `fix/alibaba-sync-storage-wiring@b0b0767`; live test `caf7e8d`.
This follows the customer's rejected Admin acceptance, not a new product design.

## Reproduced defects and repair

1. Live “Surround Sound Wired Headset with Microphone for Gaming Luminous Over
   Ear Headphones Gamers”, external ID `AAFNBBhgAOVTpOKZBnRh_lfS`: list showed
   unavailable / blank MOQ, while its stored source review displayed MOQ 10 and
   USD 6.00–7.89. This is a projection/read-path mismatch, not evidence that
   Alibaba returned no price. Admin now labels available source evidence when
   the legacy projection is absent; manual pricing remains authoritative.
   A second live check of the screenshot's first row, EB1 / external ID
   `AAEVBBhgAOVTpOKZBnRTvUv1`, found the same mismatch: source review already
   showed MOQ 7 and USD 2.52–4.89 while the list still showed unavailable.
2. That draft's Prepare detail review failed. Local reproduction showed the sync
   materializer omits `imageIds`, but review validation required the array. Treat
   an omitted array as an empty review gallery; null/malformed values still fail.
   Publishing without an image remains rejected by product publication validation.
3. Preview still composed the old compact grid and flattened description rather
   than the new detail component. It now uses the shared validated DTO and actual
   buyer layout in a wide, viewport-bounded native dialog. Technical preparation
   buttons are removed; source preparation happens behind Preview. Viewing does
   not approve, publish, mark reviewed, import images or submit an inquiry.

Escape cause: earlier acceptance sampled previously edited/published products,
not the untouched materialized draft state, and checked Edit rather than Preview.

Public product `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f` was also reread through
`/api/products/{id}/detail?view=sections`: `websitePricing.basis=website-manual`,
MOQ 1000, one tier starting at 1000 with `unitAmountMinor=380`, currency USD.
That visible single tier is the approved manual website price, not evidence of
the renderer truncating an Alibaba three-tier response. This release preserves
the values and corrects the manual table's misleading source-price column label.

## Local evidence

- New imageIds regression was observed failing before the shared-schema fix.
- Production-build formal browser runner: 41 public checks + 19 catalog checks +
  2 real API/DB journeys passed. The added journey uses an untouched draft, three
  source tiers, 55 configurations, source gallery, pagination, injected transient
  failure/retry and 320–1440px modal geometry. It verifies no publication, approval,
  review acknowledgement or image attachment was caused by preview.
- Existing normal-route buyer RFQ and persistent Admin follow-up passed again.
- Desktop/mobile preview captures were visually inspected. Fixture image bytes
  are synthetic; real customer-image acceptance must still be done after release.
- Full workspace tests: 1,477 passed; after the additional no-referrer regression,
  the final site suite passed 365 tests. Workspace/E2E typechecks and lint passed.
- Final baseline production-build lane: 76 passed; final formal lane: 62 passed.
  Logs: `/tmp/channel-draft-unit-tests.log`, `/tmp/channel-draft-site-final.log`,
  `/tmp/channel-draft-baseline-browser.log`, `/tmp/channel-draft-formal-final.log`.
  One earlier local baseline attempt collided with the full workspace test's Astro
  build cache; the lanes were rerun sequentially. That build failure was not waived.
- Release evidence is recorded below. No direct cloud deployment is allowed.

## Release trace

- Fix commit: `18a7f3e94bb29c2745d512ba2a327162fd1637a7`.
- Feature CI [34428818272](https://github.com/vibelingan/channel/actions/runs/34428818272)
  passed: 1,478 unit assertions, 76 baseline browser checks, 62 formal-route checks.
- [PR #39](https://github.com/vibelingan/channel/pull/39) merged into **test only**
  as `9eabedab567fa41aac4a77e75f2fba0208b8a275` after that CI succeeded.
- [Deploy Test 34429504839](https://github.com/vibelingan/channel/actions/runs/34429504839)
  passed full CI at the merge SHA before deployment, deployed the site and
  functions together, and passed 41 live public plus 19 live catalog checks.
  Independent health reads confirmed admin/public-api at `9eabeda`; deployed
  smoke also confirmed alibaba-catalog-sync at that release.

## Follow-up found by live browser acceptance

At `9eabeda`, both screenshot drafts opened the shared preview successfully.
The gaming headset has five loaded images, two configurations and four tiers:
10–99 / USD 7.89; 100–499 / 6.89; 500–999 / 6.57; 1000+ / 6.00.
Selecting Red and quantity 100 returned USD 6.89; quantity 9 returned below-MOQ.
EB1 has four loaded images, three configurations and four tiers:
7–99 / USD 4.89; 100–499 / 3.72; 500–999 / 3.31; 1000+ / 2.52.
The desktop preview measured 1440px wide. Close/actions remained in the viewport
after scrolling supplier notes. No product was published or marked reviewed.

Live Edit still used the old effective-price block for untouched drafts, despite
the list and Preview now showing existing source prices. A new failing regression
captured this contradiction. The follow-up reuses the same private source fallback
in Edit and presents the existing source-tier component in place of the unavailable
legacy block. Explicit manual prices and missing-source guards remain unchanged;
the fallback does not write source evidence into manual overrides or public DTOs.
The extended production-build formal lane passed all 62 checks, including Edit
price visibility and close-without-write. Site tests (367), lint and workspace/E2E
typechecks also passed. Follow-up commit `aa104cb2b348be3e1a9030118b4db89143af360a`
passed [feature CI 34431289815](https://github.com/vibelingan/channel/actions/runs/34431289815).
[PR #40](https://github.com/vibelingan/channel/pull/40) merged into test as
`e6f9a0375fd3df58431d8d4a3d867f264f83a15f`; its
[Deploy Test 34431999936](https://github.com/vibelingan/channel/actions/runs/34431999936)
completed successfully, including the final live browser checks. Independent health reads
confirmed all three functions at `e6f9a03`. Live EB1 and gaming-headset Edit now
show their four source tiers inline, without Pricing unavailable or the technical
preparation panel. EB1 Edit measures 1152px in a 2323px viewport, has four source
thumbnail buttons, and keeps Close/Save visible after scrolling to its final tier.
Both editors were closed without saving or publishing.

The same live inspection caught another inconsistency: gaming-headset Edit has
six source images while Preview stopped at five. The old source-URL helper's
default limit was five, independent of the shared nine-image catalog capacity.
A new test reproduced dropping image six; the helper now uses the shared limit,
and the formal journey's untouched draft now has nine images and selects image
nine. Invalid limits fail closed. Site tests (368), formal browser checks (62),
lint and workspace/E2E typechecks passed. Commit
`875b218343ba045d4efd6ebea01419d2c49a529a` passed
[feature CI 34433496688](https://github.com/vibelingan/channel/actions/runs/34433496688).
[PR #41](https://github.com/vibelingan/channel/pull/41) merged into **test only**
as `ad0f97a03f1bfd81e803b2b119916df2ee3fd864`.
[Deploy Test 34434027974](https://github.com/vibelingan/channel/actions/runs/34434027974)
completed its automated checks, and all three function health endpoints reported
`ad0f97a`. **Manual live acceptance nevertheless failed**: current AdminApp
`Bxt7nu0y` references `AdminDetailPreview.C-WGxnlv.js`, which returns HTTP 404 /
COS `NoSuchKey`. Both the customer domain and default TCB hostname failed, as did
a fresh query-string request. The other 14 dependencies in that Admin entry's
dynamic dependency map returned 200 with JavaScript MIME. This is a missing
hosted chunk, not demonstrated stale browser cache. Why that individual file was
not present is not proven by the upload log (which only said upload finished,
request unknown). Do not infer all files arrived from that top-level result.

The browser's uncaught lazy-import error blanked the Admin island. Recovery
reloaded the list without product mutations. The next repair adds a mandatory
post-upload comparison of every generated Astro dependency and HTML entry with
the local build hash/MIME, with one identical additive retry and a hard failure
on continued mismatch. No broad prune, DNS change, function rollback or direct
MCP upload is introduced. A Preview error boundary preserves the shell/Close and
offers an explicit page reload rather than blanking the whole Admin island.
The local production-build lane now passes 63 checks, including an injected 404
for that lazy chunk, usable dismissal, successful reload recovery and unchanged
product publication/media/review state. Release/live acceptance is still pending
for this integrity repair; the six-image result is not yet claimed passed.
Full-workspace verification for the integrity repair passed 1,488 tests, plus
workspace/E2E typechecks, lint and the CloudBase SDK contract gate. The HTTP gate
reuses the existing fully-drained response helper and adds no new SDK API or
dependency. Official hosting docs describe newer verification flags, but the
installed CLI 3.5.9 help does not expose them; they were not invented or enabled.
Integrity repair commit `c8e4107f02dee16794edd37bca4b28228830e5b7` passed
[feature CI 34436272815](https://github.com/vibelingan/channel/actions/runs/34436272815).
[PR #42](https://github.com/vibelingan/channel/pull/42) merged into **test only**
as `0f9d3865d971c462face0e28a9d195805621a2c3`; its
[Deploy Test 34436974985](https://github.com/vibelingan/channel/actions/runs/34436974985)
completed successfully, including the same-SHA prerequisite CI, full deployment,
resource/function smoke and final live-browser lanes. Its deployment log verified
**50 hosted pages/assets against build hashes**; **41 public browser checks** and
**19 catalog browser checks** passed. No identical-upload retry was required in
this successful run. The earlier PR #41 failure remains recorded above.

Independent live checks after that upload:

- Public API, Admin and Alibaba sync health endpoints all returned HTTP 200 and
  release `0f9d3865d971c462face0e28a9d195805621a2c3`.
- Reloaded the authenticated Admin and opened the untouched gaming-headset
  Preview through its real row action: all six thumbnails decoded. Clicking
  **View image 6** displayed **6 / 6** and a decoded 1500px-wide source image.
- The Preview measured 1440px wide in a 2177px viewport. Its top Close stayed
  visible after gallery scrolling, and the fixed footer remained usable.
  The live screenshot was visually inspected, not merely checked for overflow.
- Gaming prices retained all four tiers (10/100/500/1000, USD
  7.89/6.89/6.57/6.00). Closing returned to the list; the product remained
  **NEW / Disabled**. No Save, publication or Mark reviewed action was used.
- Independently reopened EB1: four decoded images, **4 / 4** on the last image,
  all four tiers (7/100/500/1000, USD 4.89/3.72/3.31/2.52), then closed it.
  The previously missing lazy module no longer blanked Admin.

The published `@cloudbase/cloudbase-mcp@2.24.1` package was inspected read-only.
Its hosting handler delegates to `hosting.uploadFiles`, then returns a success
message without fetching hosted bytes. The bundled manager's per-file failure
path does throw when retries are exhausted, so the evidence does **not** justify
claiming that the SDK deliberately ignores file errors. The original upload log
does not identify the missing object's failure mechanism. Independent content
verification is the enforced boundary rather than an invented SDK method or an
unproven explanation of that single transfer.

The real public `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f` page was also checked in
Chrome: six gallery images, new structured detail UI, `Website unit price` table
heading, unchanged USD 3.80 at 1000+. Quantity 999 shows below-MOQ; 1000 shows
USD 3.80/unit. The footer links to `sales@supplychainsai.com`. No RFQ was submitted.

## Camping-light raw evidence resolved; historical failing baseline

Update: the local remediation now preserves these fields and has raw-derived end-to-end coverage.
See [the implementation and rollout record](DATA-CONSISTENCY-RCA-2026-09-10.md).
The following table and failing assertions describe the pre-fix / observed cloud baseline,
not the corrected local implementation. No cloud backfill was performed in this remediation turn.

The camping-light sample `AAHsBBhgAOVTpOKZBnRh1CDS` has no usable normalized
quote in the new preview. Its stored source product points to product.get payload
`f603d9873401045b526e0a4da579702987c2a6fcec1f85e9e9a98d0270de5e33`, fetched
2026-09-03T07:51:00.841Z. TCB database and Storage/COS read-only UI confirmed the
stored JSON exists, 10,777 bytes. No resync or product edits were performed.

The earlier browser download/online-editor access gap was resolved on 2026-09-10
after user-completed CloudBase management authorization. `queryStorage(read)`
returned the complete text without changing the object's ACL or exporting browser
credentials. Local SHA-256 matches the payload identifier above exactly. A narrow
read of `catalogSourceObservations` ties the live empty observation to this same
payload. This is stored September 3 evidence, not a fresh Alibaba API request.

| Item | Actual product.get evidence | Current transformation / outcome |
| --- | --- | --- |
| Price | `wholesale_trade.price` is `7.6699999999999999289457264239899814128875732421875`; one SKU bulk record has price `7.67`, start quantity `-1` | Wholesale price is not extracted. The SKU record is treated as a tier and rejected for its negative threshold. No explicit currency field exists in this response. |
| MOQ | `wholesale_trade.min_order_quantity = 1`, `sale_type = normal`, `unit_type = Piece` | Extractor reads `1`, but unavailable-pricing construction drops MOQ. Inventory `1000` is separate and must not become MOQ. |
| Specifications | `attributes.product_attribute` has 47 entries, including repeated names / multiple values | Product-level attributes are not extracted; the observation sets `identity.attributes = []`. Three SKU options survive separately. |
| Description | HTML contains 17 image elements; no substantive text | Sanitization removes image markup; the resulting observation says `placeholder: true`. No description-image projection reaches the detail UI. |
| Gallery | `main_image.images.string` has 6 images | Current preview shows six; these are separate from the 17 description images. |

The official [product.get field reference](https://developer.alibaba.com/docs/api.htm?apiId=25439)
explicitly defines `wholesale_trade.price` in USD, accurate to two decimal places.
It defines a bulk discount start quantity as 1–99999; it does not explain the live
`-1` sentinel. Thus the response contains a USD wholesale amount approximately
7.67 and MOQ 1. It is incorrect to report "Alibaba supplied no price". Do not
invent a three-tier schedule, rewrite `-1` as 1, or extend the wholesale USD
contract to every unrelated currency-less price. Product-level wholesale price
and SKU pricing must retain distinct provenance.

### Reproduction and next repair boundaries

The subsequent [data-consistency RCA](DATA-CONSISTENCY-RCA-2026-09-10.md)
distinguishes the source-loss bug from intentional draft/publication revisions,
documents the duplicated pricing policy and the raw-parser gap in the formal
browser fixture, and defines the consolidation acceptance boundary.

Replayed this exact payload through `parseAlibabaApiResponse` (lossless numbers),
`extractProductDetail`, `normalizeProductDetail`, and `alibabaObservationAdapter`.
The emitted offer is unavailable, the product attribute array is empty, and the
description is a placeholder, matching the live observation. Three independent
assertions against the real adapter currently fail: MOQ 1 survives; product
attributes are nonempty; image-only description is not a placeholder. No product
code was changed and these failures are not a successful repair.

Required follow-up:

1. Model/extract wholesale pricing explicitly, use its documented USD contract,
   and handle decimal noise without routing arbitrary malformed amounts through
   a permissive float parser. Preserve valid MOQ independently of price validity.
   Keep unresolved SKU sentinel semantics visible to admins rather than claiming
   there was no source amount.
2. Preserve all valid named product attributes and multivalues with source
   provenance; do not overwrite SKU-scoped choices. The source itself contains
   potentially conflicting claims (LED vs Incandescent, rechargeable vs alkaline)
   which must not silently become one invented, authoritative specification.
3. Extract description images into a validated content/media contract, separate
   from the primary gallery. Use the existing private admin / approved public
   media lifecycle; never render raw supplier HTML or turn OCR into authoritative
   specifications without review.
4. Add real-shape regression fixtures and test draft preview, approved detail,
   manual price precedence, missing/invalid price, image-only/mixed/empty content,
   repeated attributes, and failures at media access boundaries. Replay stored
   raw data with pagination/idempotency after repair; preserve manual changes and
   publication state. Release frontend, functions and compatible schema through
   the same CI/CD version, not a direct cloud-function update.

## Domain / mailbox investigation (read-only)

TCB HTTP gateway has both `supplychainsai.com` and `www.supplychainsai.com`
enabled with normal certificates/status, and both website routes use `channel-test`.
DNSPod has 11 active records, including root CloudBase CNAME, two MX records
(`5 mxbiz1.qq.com`, `10 mxbiz2.qq.com`) and SPF `include:spf.mail.qq.com`.
The website domain is not currently replaced by a mailbox hostname.

Google and Cloudflare DNS-over-HTTPS returned the MX records. The initial local
resolver query returned only the website CNAME for MX/TXT; a later local query
returned MX correctly. This is inconsistent resolution, not proof that records
were absent or the mailbox never works. DNSPod explicitly warns that root CNAME
plus MX/TXT can be resolved differently by recursive caches:
https://docs.dnspod.cn/dns/help-type/

DNSPod's CNAME flattening is intended for this case, but the actual account is
Free and the panel requires Enterprise/Ultimate. No upgrade or DNS change was
made. A controlled change would enable flattening **only for @**, preserving
CloudBase targets and existing MX/SPF, then check HTTPS/certificates plus MX/TXT
from multiple resolvers. Its documented 1600ms fallback can still return CNAME;
it is mitigation with a provider caveat, not an absolute delivery guarantee.
https://docs.dnspod.cn/dns/cname-flattening/

If that paid option is unacceptable, plan a separate move of authoritative DNS
to an apex-flattening provider, preserving all 11 records and testing before the
NS switch. Do not hardcode a currently observed CDN IP or replace the website
CNAME with a mail hostname. The user chose **evaluate the no-upgrade path**;
[the resulting assessment](DNS-MAIL-NO-UPGRADE-ASSESSMENT-2026-09-10.md) keeps
Cloudflare DNS-only, preserves website/mail services and lists compatibility,
DNSSEC, whole-zone verification and rollback gates. No migration was performed.

DMARC still contains `rua=mailto:your@supplychainsai.com`; this is a placeholder,
not the verified sales mailbox. No DKIM selector appears among these 11 records.
Mailbox existence/alias, DKIM provisioning and actual send/receive remain unverified
and require QQ enterprise-mail admin access. Footer sales@ is contact content;
changing it does not create a mailbox or configure notification SMTP.
