# SKU photo mapping repair — 2026-09-11

## Observed cause, not a photo-order assumption

Reported public product: `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f` (SY-T11).
Retained Alibaba `product.get` evidence SHA-256:
`3e8a5d2c949d61cc57588f693ad901425d2be2b8da01e1fe556983f9fb7bc255`,
captured 2026-09-03T08:10:44.340Z. This is retained evidence, not a fresh
supplier API response. Source key:
`fba5c0af145d21fac836a4ed4366798af6a87b080e6762ad4b7f3a5a8563be28`.

The raw product has six general photos and three SKUs. Its color definition
(`attribute_id=191288010`) provides an `image_url` for each option value;
each SKU's `attr2_value` explicitly selects that attribute/value pair:

| Color | Value ID | Original SKU ID | Source photo filename |
| --- | --- | --- | --- |
| Black | 3327837 | 10001424505346 | Hdd76b413997a44cb91f594cc004237e8N.jpg |
| White | 3331185 | 10001424505344 | Hbb64fd6a2fd041c2879fe6bd84472d31U.jpg |
| Pink | 3328925 | 10001424505345 | H445a300485e148579071381c766d0aacj.jpg |

These three URLs are distinct from the six general-gallery URLs. The old parser
read the option names but dropped their image URLs; the observation adapter
created empty SKU media. Separately, approval required SKU photos to be in the
general gallery, and the gallery resolver appended/fell back to all product
photos. Thus selecting Black and showing the white first product photo was
possible even though the source had a correct mapping. A disclaimer did not
repair that missing relationship.

## Implemented contract

- Parse only explicit attribute/value identity joins, not color recognition,
  filename inference, position or equal-length array zipping. Deduplicate images;
  reject invalid URL transports and ambiguous duplicate value-image mappings.
- Model SKU photos independently of general and description photos. Approval
  binds source URLs to owned image records, validates lifecycle state, records
  SKU image IDs in an internal approved manifest and updates public reference
  counts atomically. Retries cannot double-count; private drafts stay private.
- Authenticated Preview and public detail share `CatalogVariantGallery`. Preview
  uses authenticated blob previews for owned images; unimported supplier URLs
  use the existing explicit allowlisted source-preview contract. Preview never
  imports or publishes images. Explicit Save/approval imports reviewed missing
  SKU images and revalidates the review before committing.
- Default/selected SKU shows only its bound photos. Switching SKU resets photo
  selection. General photos remain behind “View product gallery”; browsing them
  never changes the selected SKU. Missing/broken SKU photos do not silently show
  another color. Unequal photo/SKU counts are normal and supported.
- Public default photo loads first. After it loads, an idle queue prefetches at
  most nine distinct SKU URLs, with two concurrent low-priority loads. Save-Data
  and 2G disable speculation, not user-selected loading. Exact URLs reuse browser
  cache/in-flight image fetches; this is not a TanStack request-ID mechanism.
  Selection changes reuse loaded product/version data instead of refetching it.

## Verification and release procedure

Local production-build/disposable-DB run: 41 public tests, 22 catalog tests and
6 formal journeys passed. The new formal journey derives a draft from the
sanitized real wire fixture, verifies three private SKU images return 404,
checks Preview, publishes through the normal Admin UI, then validates the public
owned-image identities and mobile color switching. Fixture image bytes are
synthetic; semantic source identity is asserted independently.

Five focused mobile WebKit tests passed: explicit switching, unequal counts,
missing/broken mapping, default-first/in-flight reuse/late completion, and
Save-Data/2G. The latter two also passed Chromium. This is WebKit automation,
not a claim of physical-iPhone acceptance.

Full CI includes parser/adapter identity edge cases, source import/review change
detection, transaction failure/retry/ref-count cases, bounded raw replay and
authenticated handler scope forwarding. Local full tests must use CI's Node
22.13.0: the machine's Node 25 experimental server-side localStorage otherwise
breaks existing browser-client unit tests. Production security is not loosened.

Release frontend and all three cloud functions through the same-SHA gated
Deploy Test workflow. No direct function deployment. After deployed SHA checks,
dispatch acceptance-only with `catalog_acceptance_scope=variant-media`:

1. Dry-run exactly the reported source key; require one source/three variants,
   valid retained evidence and a completed server-owned manifest.
2. Apply that manifest/hash only. This reparses retained evidence, not a fresh
   Alibaba fetch or full-catalog mutation. It cannot expand its scope on retry.
3. Normal Admin Preview verifies all three exact source URLs; normal Save
   imports/approves their owned images. Preserve manual prices, categories,
   gallery/description IDs and the set of published products.
4. Read back approved/public mappings; load each actual owned photo in mobile
   public UI. Retain only public screenshots. No email, RFQ or new publication.

CI/live results must be recorded in the delivery response; local green does not
mean this existing product's retained observation has already been repaired.

### Release lifecycle regression found by deployment

Deploy Test `34501051480` passed full CI but failed at the admin configuration
update. Actual readback returned `Status=Updating, AvailableStatus=Available`;
the old waiter incorrectly OR-ed those fields and returned early three times.
[Tencent's lifecycle contract](https://cloud.tencent.com/document/product/583/115197)
defines `AvailableStatus` as billing availability, not deployment readiness.
Context7 was unavailable; official docs and the actual read-only MCP response
independently confirmed this contract. No SDK methods or CLI argument contracts
changed.

The shared, executable waiter now requires `Status=Active`, bounds polling,
rejects lifecycle/billing failures, and never logs environment values. The
deployment uses it before code replacement, after code upload and after config
update. Tests reproduce the exact Updating/Available pair, missing/unknown
states, timeout, billing/terminal failure and credential-error propagation.
The failed run uploaded admin code but did not reach public-api, sync or site
deployment; do not describe that intermediate state as a completed release.
Recovery must run the same full CI/CD path, not update remaining functions by
hand. The four product repair operations have not run at this point.

## Boundaries

The final read-only audit found **11 public products**, of which four already
use approved new details and all four lost explicit source SKU image mappings.
Expand the narrow acceptance to these exact existing products, one independently
hashed manifest each (not a full-catalog replay):

| Product ID | Model | SKUs | Explicit source colors | General photos |
| --- | --- | --- | --- | --- |
| 0aa9d459-159c-4ffa-a5c0-db9a8e7c642f | SY-T11 | 3 | Black, White, Pink | 6 |
| 7e8c6ece-41ad-4573-a2ed-d3e7fea94c8f | M1 | 4 | White, Black, across two connector options | 5 |
| af743d00-ca07-45b3-a2c5-f7a6b256035b | CYZ-32 | 2 | Gold, White | 5 |
| f15a8e4f-3f48-4021-ac3d-67bd1060836a | WH3 | 1 | Black | 6 |

All source image URLs were read directly from each retained raw payload. The
other three evidence hashes are `fe30d9b1b1275e22dc26a748ade4e8d1e09fd7c5db9052098fd117446a505ca4`,
`04f496b383065ea2a9ef13a460b489389d799279eca491938901f00c378368b8`,
and `0a0a2c6177210acf915bdc712ab68ca559cb42c821a12e8d4d27962b8a4ee099`.
The previous pending deployment was cancelled during its CI unit-test step,
before any deployment job began, so this complete audited scope can ship together.

- Future syncs use the fixed parser automatically. Other historical observations
  are not silently reparsed or republished by this targeted acceptance. They
  require explicit retained-data replay/resync and normal review; no mapping is
  invented where the source lacks one.
- Existing transaction operation limits remain fail-closed. A product with too
  many unique owned media references can require a separately designed staged
  reference rollover; no truncation was added to fit that limit.
- Responsive image derivatives/thumbnail byte reduction and automatic WebKit CI
  expansion are separate follow-ups. The current change does implement bounded
  initial/speculative loading without a new image-proxy service or state library.
- A source URL can later change its bytes. This repair checks source identity
  and owned byte availability; live screenshot inspection is still required to
  confirm the three returned photos visibly match the source color labels.
