# Skill / Playbook — Private Direct-to-Storage Media & File Upload

> A reusable, **provider-agnostic** blueprint for browser→object-storage upload
> with server-brokered credentials, server-side finalization, and private/public
> delivery. Distilled from this repo's catalog-image (MIU-01…09) and OEM-drawing
> (MIU-08) implementations so the **next web app can adopt the tech stack directly**
> — the only provider-specific piece is a thin storage adapter.
>
> Reference implementation in this repo:
> `packages/media-storage`, `packages/db`, `packages/shared/src/media*.ts`,
> `apps/functions/admin/src/handler.ts` (intent/finalize/delivery actions),
> `apps/site/src/components/ProjectForm.astro` +
> `apps/site/src/islands/admin/oem-download.ts` (browser). Design of record:
> `docs/IMAGE_UPLOAD_STORAGE_DESIGN.md`; execution log:
> `docs/IMAGE_UPLOAD_EXECUTION.md`.

---

## 1. When to use this

Use it whenever a browser must upload a file that is **larger than your function
platform's request-body cap** (CloudBase Event Functions ≈ 100 KiB; many
serverless platforms are 1–6 MB), and/or the file is **private** (drawings,
contracts, unpublished media). Do **not** base64 the bytes through your API — it
inflates ~33 %, stores payloads in the DB, and hits the body cap.

Two delivery modes are supported by the same upload core:
- **Public, ref-count-gated** (catalog images visible only when a published record
  references them).
- **Private, admin-authenticated, short-TTL** (OEM drawings — never a durable URL).

## 2. Architecture — four phases (provider-agnostic)

```
┌────────────┐   1. intent      ┌───────────────┐
│  Browser   │ ───────────────▶ │  Your API      │  mint scoped upload credential
│            │ ◀─────────────── │  (function)    │  + write a PENDING metadata row
└────────────┘   {url,fields,   └───────────────┘
       │          secret,id}            │
       │ 2. DIRECT multipart POST       │ (bytes NEVER transit the function body)
       ▼                                │
┌────────────┐                          │
│  Object    │ ◀────────────────────────┘
│  Storage   │   (COS / S3 / GCS)
└────────────┘
       │ 3. finalize {id, secret}       ┌───────────────┐
       └──────────────────────────────▶ │  Your API      │  verify + activate row
                                         └───────────────┘
                                                │ 4. delivery
                              ┌─────────────────┴─────────────────┐
                        public: ref-count gated         private: admin-auth
                        proxy/redirect                  short-TTL temp URL
```

**Phase 1 — Intent (server).** Validate `{fileName, mimeType, byteSize}` against an
**extension + MIME allowlist** and a **size cap**. Mint a **scoped, short-lived
upload credential** for a server-chosen object key (`namespace/logicalId/name`).
Write a `pending` metadata row that stores server-managed fields (`storageKey`,
`storageProvider`, `byteSize`, `status:'pending'`, `expiresAt`) and — for private
flows — the **SHA-256 hash of a one-time upload secret** (plaintext returned once).
Return `{ upload:{url,method,fields}, fileId, uploadSecret? }`.

**Phase 2 — Direct upload (browser).** POST the server-minted form fields **first**,
then the file part, straight to the storage URL. The browser never holds a durable
storage identity and the bytes never touch your function.

**Phase 3 — Finalize (server).** Look up the pending row; verify expiry, provider,
key prefix; for private flows do a **constant-time compare** of the presented
secret against the stored hash. Take a **single-winner consume-once claim** (atomic
counter) *before* reading the object, then **re-read the object from storage and
recompute `byteSize` + `checksum` server-side** (client metadata is only a hint),
**sniff magic bytes** to confirm the real type, and only then flip the row to
`active` (and link it to its owning record). Byte-level failures mark the row
`failed` and best-effort delete the object.

**Phase 4 — Delivery.**
- *Public*: an app route checks a denormalized **`publishedRefCount > 0`** (or
  `isPublic`) before streaming/redirecting — never expose raw storage URLs.
- *Private*: an **admin-authenticated** action mints a **short-TTL temp URL**
  (≈60 s, never persisted) with a sanitized filename; the browser **downloads**
  it as a named attachment (fetch → object-URL `<a download>`), not `window.open`.

## 3. The storage-adapter seam (the only provider-specific code)

Everything above is provider-agnostic if you hide the provider behind one
interface. Implement it once per provider (CloudBase COS, AWS S3, GCS):

```ts
interface MediaStorage {
  // Phase 1: mint a browser-usable, scoped, short-lived upload grant.
  getUploadCredential(objectKey: string): Promise<{
    uploadUrl: string;
    method: 'POST' | 'PUT';
    formFields: Record<string, string>; // presigned POST policy fields
    storageFileId: string;              // durable id/key to persist
  }>;
  // Phase 3/4: server-side read for re-validation.
  getObjectAsBase64(id: string): Promise<{ body: string; byteSize?: number }>;
  // Phase 4: short-TTL delivery URL.
  getTempUrl(id: string, maxAgeSeconds?: number): Promise<{ url: string; expiresAt?: string }>;
  // cleanup / rejection.
  deleteObject(id: string): Promise<void>;
}
```

- **S3/GCS**: `getUploadCredential` = presigned POST (or PUT); `getTempUrl` =
  presigned GET — and both **can set `response-content-disposition`**, which lets
  you enforce attachment downloads server-side (see Gotcha G3).
- **CloudBase COS**: use `@cloudbase/node-sdk` `getUploadMetadata` for the POST
  form; `getTempFileURL` for the temp URL (it **cannot** set a disposition — see G3).

## 4. Security properties to preserve

- **Bytes bypass the function body cap** — direct browser→storage; the API only
  ever carries small JSON.
- **Server is the source of truth** — re-compute size + checksum + type (magic-byte
  sniff) at finalize; never trust client-declared size/MIME. CAD-type files with no
  reliable signature stay **extension-gated**, never accepted on signature alone.
- **One-time secret for anonymous/public intents** — store only its SHA-256 hash;
  constant-time compare (`timingSafeEqual` with a length guard) at finalize.
- **Single-winner finalize** — an atomic claim **before** any object download so a
  leaked secret can't amplify repeated large downloads or race the destructive
  path. Losers get `CONFLICT` with no storage read.
- **Private delivery is never a durable URL** — short TTL, minted on demand,
  admin-authenticated, fail-closed unless `active` + recognized provider + owner.

## 5. Abuse controls for *public/anonymous* intents

- **Fixed-window rate limit** + **live pending-intent cap**, each enforced
  **per-source** (hashed IP; never store the raw IP) **and** against a **global
  emergency ceiling** (the platform may not expose a trusted IP).
- **Reserve-first**: write the pending row, *then* count and roll back if a ceiling
  is exceeded — closes the check-then-create race that lets a burst overshoot.
- Denials return `429` with `Retry-After`.

## 6. Provider gotchas learned the hard way (carry these forward)

- **G1 — Atomic operators are per-SDK contracts.** On CloudBase, `wx-server-sdk`'s
  `db.command.inc()` **does not apply** in the runtime (returns `updated: 0`) even
  though plain updates work; route atomic counters through the **native**
  `@cloudbase/node-sdk` (`.update(patch)` direct, `.get()` → `{data:[doc]}`). Cover
  atomic-operator paths with a **deployed** smoke — unit-test doubles can't catch
  this. (See `docs/ENGINEERING_CRAFT_PROPOSALS.md` §1.)
- **G2 — Browser-direct storage needs bucket CORS / security domains** for the site
  origin (and `localhost:<devport>`); it's a deploy-time ops prerequisite, not code.
  Verify with an `OPTIONS` preflight. Managed buckets may hide in a separate console
  tab.
- **G3 — Not every temp-URL API can force a download.** If `getTempUrl` can't set
  `response-content-disposition` (CloudBase), enforce the attachment **client-side**
  (fetch → object-URL `<a download={name}>`); on S3/GCS set it on the presigned GET.
- **G4 — Size can't always be bound at the credential.** If the presigned policy
  can't bind `content-length-range` (CloudBase `getUploadMetadata`), enforce the cap
  **server-side at finalize** (re-read + reject/delete oversize).
- **G5 — Keep CI smokes small + configurable.** Large cross-region uploads time out
  on CI; prove the mechanism with ~20× the body cap, env-overridable, and validate
  near-cap with a local probe.

## 7. Copy-paste checklist for the next app

- [ ] Pick delivery mode(s): public ref-count-gated and/or private short-TTL.
- [ ] Implement the `MediaStorage` adapter for your provider (4 methods).
- [ ] Shared contracts: extension+MIME allowlist, size cap constant, magic-byte
      sniffer, filename sanitizer.
- [ ] Intent action: validate → (public: rate/pending caps, reserve-first) → mint
      credential → write `pending` row (+ one-time secret hash for public).
- [ ] Browser: direct multipart POST (fields first, then file); client-side
      size/type pre-check for UX only.
- [ ] Finalize action: expiry/prefix/secret checks → **atomic single-winner claim**
      → re-read + recompute size/checksum + magic-byte sniff → activate/link; fail
      → mark `failed` + delete object.
- [ ] Delivery: public route ref-count-gated; private action admin-auth + short TTL
      + sanitized attachment download (client-side if the URL can't carry
      disposition).
- [ ] Cleanup: reap expired `pending` rows + orphan objects.
- [ ] Ops: bucket CORS/security-domain for the site origin; env-scoped secrets.
- [ ] Tests: unit-test your logic with a fake adapter **and** a **deployed smoke**
      that exercises the real SDK operators end-to-end.
