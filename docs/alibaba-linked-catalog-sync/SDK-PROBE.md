# SDK / API Reality-Check — Alibaba Linked Catalog Sync

Rule 22 record for this feature. Probed 2026-08-06 against the INSTALLED
packages in this worktree, not against training knowledge or hand-written
stubs. The probe is **executable and repeatable** — it is not this document:

```bash
node scripts/verify-cloudbase-sdk-contract.mjs
```

44 assertions, all PASS at the time of writing. CI runs the same script, so
this record cannot silently rot: an SDK bump that breaks any contract below
fails the build rather than this file going stale.

## Installed versions probed

| Package | Version | Resolved from |
|---|---|---|
| `@cloudbase/node-sdk` | 3.17.2 | `node_modules/.pnpm/@cloudbase+node-sdk@3.17.2` |
| `wx-server-sdk` | 4.0.2 | `node_modules/.pnpm/wx-server-sdk@4.0.2` |
| `@cloudbase/database` | 1.4.3 | `node_modules/.pnpm/@cloudbase+database@1.4.3` |

## Third-party surfaces this feature introduces

### 1. Transactional writes (the fenced sync lease) — NEW in this feature

The lease machine in `packages/db/src/cloudbase-adapter.ts` re-verifies the
holder, fence and expiry **inside** the write transaction (ARCHITECTURE §
fenced conditional write, R1 amendment). That depends on three behaviours the
docs do not state precisely, so each is probed against the real driver:

- `database.runTransaction` commits, returns the callback's value, rolls back
  on throw, and retries **only** on `DATABASE_TRANSACTION_CONFLICT`.
- In-transaction `doc.set` is a **full-replace upsert** implemented via
  `database.modifyDocument` (`merge:false, upsert:true`, and `_id` must NOT
  appear in the data) — not a partial merge.
- In-transaction `doc.get` resolves `{ data: doc | null }` for a missing
  document rather than rejecting, which is what makes get-miss → set-upsert
  a single atomic claim.

The probe exercises get-miss / set-upsert / update against the real
`@cloudbase/database` and asserts the exact shape the lease write relies on.

### 2. Storage (candidate media import) — reuses the verified surface

`getUploadMetadata` lives on `@cloudbase/node-sdk` and returns
`{ data: { url, authorization, token, fileId, cosFileId } }`. `wx-server-sdk`
does **not** expose it — the probe asserts that absence explicitly, because
the historical production 500 came from stubbing the method on the wrong
package. Uploads are `PUT` with the credential in **headers** (no multipart
form); the probe checks the SDK's own request shape and both browser call
sites.

### 3. Alibaba Open Platform GOP — not an SDK

The Alibaba side is plain `fetch` against a signed HTTP gateway; there is no
installed package whose types could be checked. Its contract is pinned
differently, and the distinction matters:

- **Signing** — HMAC-SHA256 over `apiPath` + ASCII-sorted key+value concat,
  uppercase hex, pinned by a golden vector in
  `packages/alibaba-catalog-sync/src/alibaba-signature.test.ts`.
- **Response shapes** — table-driven contracts in `alibaba-contracts.ts`; a
  response that misses a required field quarantines the run rather than
  silently degrading.
- **Endpoints** — `oauth.alibaba.com/authorize` is CONFIRMED official. The
  `/rest` gateway host and the token create/refresh paths remain
  **ASSUMED-UNVERIFIED** until the MIU 15 live smoke; they are overridable at
  runtime via `ALI_API_BASE_URL` (suffix-anchored to `alibaba.com`, https
  only) so a correction needs no redeploy.

That last point is load-bearing for the token layer: because the refresh path
is unverified, a bare HTTP status is **not** treated as evidence that a
credential is dead — see the round 4-6 records in `EXECUTION_LOG.md`.

## What this record does NOT cover

The live Alibaba gateway itself. Registering the callback URL, the live
authorize→token exchange, and confirming the `/rest` host are MIU 15 gates
that require the deployed test env and the Alibaba console.
