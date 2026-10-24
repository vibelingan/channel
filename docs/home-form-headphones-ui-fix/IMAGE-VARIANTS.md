# CloudBase Image Variant Decision

Status: Deferred follow-up. No image processing service, URL transform, or persistent derivative is enabled by the current Headphones delivery.

Last verified: 2026-07-29

## Decision

Ship the basic Headphones performance work without Data万象 image variants:

- static Astro shell and initial-HTML hero discovery;
- 12-product pages with explicit Load More;
- lazy, asynchronously decoded card images with fixed geometry;
- gallery media unmounted until product detail opens;
- four thumbnail previews before View All;
- abort and ID deduplication;
- one conditional API-origin preconnect.

CloudBase image resizing is technically feasible, but the current application does not expose that capability. Treat `card`, `thumb`, and `detail` output as a separate media-platform enhancement with its own billing approval, SDK contract probe, security review, lifecycle design, and measured production trial.

Do not auto-enable advanced compression, add query parameters to signed private URLs, or begin generating derivative objects as part of the current G3 adjustment.

## Verified Platform Capability

CloudBase official documentation establishes the platform-level facts:

- CloudBase classic cloud storage is backed by Tencent COS and integrates Cloud Infinite/Data万象.
- Basic image processing supports resize, crop, rotation, format conversion, quality changes, blur, and sharpening.
- Basic processing is documented as enabled by default and callable through URL parameters such as `imageMogr2/thumbnail/200x200`.
- Reusable named image styles can be configured in the COS image-processing console and requested with a style name.
- Data processing also has workflows that process on download without saving, process during upload and save a result, or process an existing cloud object and save a result.
- Private objects still require a valid COS authorization signature.

This proves capability at the CloudBase/COS service layer. It does not prove that the project's installed Node SDK and media adapter safely expose each workflow.

## Billing Boundary

The accurate billing statement is narrower than "resizing is paid":

- Data万象 is currently settled separately and is not included in the CloudBase storage package.
- CloudBase lists basic image processing as free.
- CloudBase lists advanced image processing as charged by invocation.
- Extreme/intelligent compression and advanced formats require separate enablement or processing parameters and may incur charges.
- Storage, request, function, and delivery traffic costs remain relevant even when the basic transform itself has no processing fee.

Therefore, no paid or separately settled feature should be enabled without the environment owner's approval. A follow-up must confirm the current Tencent pricing page and the target account's console state immediately before activation; this document is architecture evidence, not a price guarantee.

## Current Application Contract

The repository is prepared to describe variants but does not generate or serve them:

- `packages/shared/src/media.ts` defines `original`, `detail`, `card`, and `thumb` roles plus per-variant storage metadata.
- Current queried Headphones image records are storage-backed, but the read-only production probe found no generated variants.
- `packages/media-storage/src/index.ts` exposes only original-object `getObjectAsBase64(fileId)` and `getTempUrl(fileId)` reads.
- `packages/media-storage/src/cloudbase.ts` delegates `getObjectAsBase64` to `sdk.downloadFile({ fileID })` and has no transform or CI operation.
- `apps/functions/public-api/src/handler.ts` verifies provider, active status, positive finite `publishedRefCount`, and `storageFileId`, then downloads that original object. It does not inspect `variants` or accept a variant role.
- The installed `@cloudbase/node-sdk@2.10.0` storage implementation obtains a temporary URL and downloads it. No project-verified method for creating persisted CI derivatives is present in the adapter contract.
- The repository has no `sharp`, `jimp`, `cos-nodejs-sdk-v5`, or other image-processing runtime dependency.

Appending `imageMogr2` to a `cloud://` file ID or an already-signed temporary URL is not an approved implementation. Query ordering/signature behavior and the exact installed SDK wrapper must be live-probed first. A hand-written type shim is not contract evidence.

## Security And Lifecycle Invariants

Any future variant path must preserve the current fail-closed public gate:

1. Resolve the image metadata by public image ID.
2. Require a recognized storage provider.
3. Require `status === "active"`.
4. Require a positive finite numeric `publishedRefCount`.
5. Map a closed server-side variant role to a fixed transform or stored object.
6. Fetch only after those checks pass.
7. Return 404 for unauthorized, corrupt, inactive, unpublished, or unfetchable media.

Never accept a raw Data万象 command, arbitrary width/quality string, storage path, or signed URL from a public request. Public input may select only a closed role such as `card`, `thumb`, or `detail`; the server owns every transform and object key.

If variants are persisted, activation and deletion become multi-object lifecycle operations:

- original upload validation completes first;
- derivative generation uses server-owned paths;
- metadata becomes active only after required outputs are verified;
- partial failures delete successfully created derivatives or leave a retryable failed state;
- replacement and deletion remove every stored variant and inspect each per-file result;
- orphan cleanup and backfill understand both original and derivative keys;
- checksums, MIME, dimensions, and byte sizes are measured from outputs, not trusted from a request.

The existing publication counter continues to govern the image document as a whole. A derivative must never become a public bypass around the original image record's status/refcount gate.

## Follow-Up Options

### Option A: Server-Controlled On-Demand Transform

Map `card`, `thumb`, and `detail` to fixed basic `imageMogr2` rules and fetch the processed bytes only after the existing public gate passes.

Advantages:

- no derivative inventory or migration;
- fastest way to test byte reduction;
- original remains the only durable object.

Costs and unknowns:

- private signed-URL/query behavior is not yet proven through `@cloudbase/node-sdk@2.10.0`;
- the function proxy and measured origin latency remain in the delivery path;
- processing/cache behavior must be measured rather than assumed;
- the media adapter and public route need an explicit closed variant contract.

This is the preferred first experiment if a live probe succeeds.

### Option B: Persistent Derivative Objects

Generate and save each role on upload or through cloud-side processing, then store complete `ImageVariantMetadata` entries.

Advantages:

- deterministic output bytes and dimensions;
- no repeated transform work at read time;
- the current function can fetch a smaller ordinary storage object.

Costs and unknowns:

- requires a verified CI/COS API or SDK not present in the current adapter;
- expands activation, replacement, delete, retry, orphan cleanup, and backfill behavior;
- consumes additional storage and write operations;
- requires atomic metadata/lifecycle design to avoid active rows with missing derivatives.

Do not choose this before Option A is measured or before repeated processing cost and latency justify the lifecycle complexity.

### Option C: Public Static/CDN Copies

This is rejected for ordinary catalog/card/gallery media because it would bypass automatic publication/refcount revocation unless a purge topology is designed and proven.

A separately approved hero can be classified as public marketing content and shipped as a curated static asset. That is a content-governance decision described in `PERFORMANCE.md`, not a catalog-variant implementation.

## Mandatory Follow-Up Probe

Before code design approval:

1. Confirm the target environment and bucket are classic CloudBase/COS storage, not PG storage.
2. Confirm basic processing, named styles, and every proposed advanced feature in the live console.
3. Obtain billing-owner approval for separately settled Data万象 use; explicitly list any non-free feature.
4. Inspect the exact installed SDK package and official CloudBase/COS API for the chosen transform path.
5. Use one non-public test object to compare original and processed status, MIME, dimensions, bytes, latency, cache headers, and signature behavior. Do not print or persist the signed URL.
6. Prove an invalid/expired signature and an unapproved role fail closed.
7. Prove the original object is unchanged by an on-demand transform.
8. If outputs are persisted, prove partial-failure cleanup and complete multi-object deletion.
9. Extend `pnpm verify:cloudbase-sdk` before relying on a new SDK or hand-written declaration.
10. Re-run public media authorization tests and live route smoke checks for every approved role.

## Proposed Trial Budgets

Exact dimensions should be finalized from rendered geometry, not copied blindly. The first probe may compare these bounded candidates:

| Role | Candidate maximum | Purpose |
|---|---:|---|
| `thumb` | 160x160 | gallery strip and compact previews |
| `card` | 640x640 | two-density product cards |
| `detail` | 1200x1200 | product detail without original-size transfer |

For each role, record actual transferred bytes and visual review against the original. Do not enable a format conversion that lacks required browser support or silently changes animation/transparency semantics.

## Evidence

Official CloudBase sources checked through the CloudBase knowledge-base tool on 2026-07-29:

- capability and billing overview: <https://docs.cloudbase.net/storage/ci-cos>
- image-processing operations and URL parameters: <https://docs.cloudbase.net/storage/ci-cos-processing>
- CloudBase storage overview: <https://docs.cloudbase.net/storage/introduce>
- Data万象 pricing reference linked by CloudBase: <https://cloud.tencent.com/document/product/460/6970>

Installed package source was independently inspected from `@cloudbase/node-sdk@2.10.0`. The current `downloadFile` implementation calls `getTempFileURL`, encodes the returned URL, and downloads it; that inspection proves the current original-read path but does not prove transformed private URL behavior.

The strongest attack on this decision is that reducing 209KB originals would likely improve cards immediately. That is true, but it does not make an unverified signed-URL mutation or partially managed derivative lifecycle safe. The current lazy/loading/pagination changes reduce unnecessary discovery now; one bounded live transform probe is the next proportionate step.