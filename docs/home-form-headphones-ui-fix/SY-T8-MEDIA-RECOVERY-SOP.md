# SY-T8 Media Recovery SOP

Status: **SUPERSEDED - DO NOT EXECUTE THE BACKFILL/REPAIR STEPS BELOW.** The approved recovery is
canonical re-upload and product-reference replacement; see `SY-T8-REUPLOAD-RUNBOOK.md`.

Decision update, 2026-07-29:

- Do not run global `backfillImageRefCounts` for this incident.
- Do not implement or run a scoped counter-repair action.
- Do not hand-create or patch old image metadata/refcounts.
- Preserve the old batch as quarantined evidence until the newly uploaded batch is verified.
- Re-upload the approved 18 source images through the portal upload/finalize API and update the
  existing SY-T8 product once with the resulting new image IDs.

Everything below this notice is retained only as forensic evidence explaining the rejected repair
option. It is not an operational procedure.

Branch: `fix/home-form-headphones-ui`

Environment investigated: `diversity-123-d9grnqfux221323bb`

Incident product:

- Product ID: `483207676a6829f2008b7cba2ca33a11`
- Product name: `SY-T8 Wireless Headphone`
- Public page: <https://supplychainsai.com/headphones>

## 1. Executive Conclusion

The image bytes were uploaded successfully. This is not a fake TCB URL, an empty
upload, or a failure to retrieve the WeCom image.

The batch import did not complete the portal's media lifecycle:

| Layer | Observed state | Meaning |
|---|---:|---|
| CloudBase Storage objects under `products/sy-t8/` | 18 | The JPEG bytes landed in COS/CloudBase Storage. |
| `images` metadata rows matching the product references | 15 | Fifteen storage objects were registered, but registration is incomplete. |
| SY-T8 `product.imageIds` references | 16 | The product points at one image ID that has no metadata row. |
| Valid `publishedRefCount` values on the 15 rows | 0 | All fifteen rows fail the public-delivery gate. |
| Current public image responses | 16/16 return 404 | Expected fail-closed result for incomplete metadata/dangling reference. |

The current state proves that the portal media lifecycle was not completed. Available
evidence does not identify whether Hermes, TCB MCP, another import tool, or a partial
operational failure caused it. The object keys also differ from the portal's canonical
upload-intent keys, but Hermes gateway logs/upload manifests were not available in this
workspace. Do not attribute the incident to a specific actor or tool without that trace.

## 2. Does "15 Metadata Rows" Mean 15 Images Are OK?

No. It means fifteen image records can be recovered without recreating their storage
binding. They are not currently public-display-ready.

Each of the fifteen rows has:

- a real `cloud://` storage ID;
- a matching `products/sy-t8/*.jpg` storage path;
- `storageProvider: cloudbase-storage`;
- `status: active`;
- a declared JPEG MIME and byte size matching the listed storage object.

Each row is missing `publishedRefCount`. For storage-backed images, the public API
requires a positive finite numeric `publishedRefCount`; an absent value fails closed.
After a reviewed reference-count backfill, these fifteen rows should move from
`null -> 1`, because the published SY-T8 product is their only published catalog
reference. They become displayable only after the backfill applies and their public
URLs return 200.

One product reference has no metadata row at all:

```text
179185b66a682c3d00697b3b4dcba5d2
```

No counter backfill can repair a nonexistent image row. That reference must be removed
or replaced with a new ID created through the canonical uploader.

## 3. What Each Layer Does

### 3.1 Storage Object

The storage object is the raw JPEG byte payload. Its `cloud://` ID or storage path
answers: "Where are the bytes?"

Storage alone does not make an image public. The bucket is private, and the application
must not expose it by changing the bucket to public-read.

### 3.2 Image Metadata

The `images` row is the trusted binding between an application image ID and storage:

- provider and storage ID/path;
- lifecycle status (`pending`, `active`, `failed`, `deleted`);
- MIME, measured size, and checksum;
- media purpose;
- `publishedRefCount` public-visibility index.

This layer is both an integrity contract and a security boundary. It prevents a raw COS
object, a pending upload, an invalid MIME, or an unreferenced image from becoming public.

### 3.3 Product Reference

`products.imageIds` controls which application image IDs belong to the product and their
display order. The first ID is the card cover.

For a published product, adding/removing IDs also changes each existing image row's
`publishedRefCount`. A dangling ID is harmless to authorization but produces a 404.
Retaining an existing ID does not change its count. Removing the current dangling ID
changes no counter because that image row does not exist.

### 3.4 Public Image URL

The catalog projects each image ID as `/api/images/:id`. That route looks up metadata,
checks recognized provider + active status + positive refcount, then reads the private
object. The URL returning 404 is the security gate working as designed; it is not proof
that the underlying object is absent.

## 4. Read-Only Evidence Snapshot

Observed on 2026-07-29:

- All 16 projected URLs return JSON 404 `Image not found`.
- CloudBase Storage lists 18 JPEG objects, uploaded between
  `2026-07-28T04:08:14Z` and `2026-07-28T04:12:39Z`.
- A downloaded sample, `Detail-02.jpg`, is a valid baseline JPEG:
  - 566,013 bytes;
  - 790 x 1405 pixels;
  - SHA-256 `1744689de9ee9623bbc378fd732ae8f0f1021cde822e24ba55bfd73f5e8502ea`.
- The temporary sample was deleted after inspection.

### 4.1 Recoverable Existing Metadata IDs

These fifteen rows exist and are expected to backfill from `null -> 1`:

```text
7b76ee416a682b9401120d1d2c392d92
7b76ee416a682c5a01121c63780791a3
483207676a682c5c008b966626e7e62a
0e0afdc26a682c5d0053647c4f007832
179185b66a682c5f00698b4d2a771b8a
483207676a682c61008b969854115bac
7b76ee416a682b9401120d1a4e8d18e7
7b76ee416a682b9401120d1c2e09555f
179185b66a682c6200698bcd6f1b368c
179185b66a682c6400698bd828573ec4
0e0afdc26a682c660053653f3735e816
7b76ee416a682c6701121d2b126e4299
483207676a682c69008b97242b69a4fd
179185b66a682c6c00698c4c2d5c8b50
0e0afdc26a682c6e005365cb45ff89bf
```

### 4.2 Dangling Product Reference

```text
179185b66a682c3d00697b3b4dcba5d2
```

Its array position is between `Detail-07` and `Main-02`. Storage contains
`Main-01.jpg` but no metadata row for it, so `Main-01.jpg` is the strongest mapping
hypothesis. This is not sufficient proof to hand-create metadata or silently bind it.

### 4.3 Storage-Only Orphans

```text
products/sy-t8/Main-01.jpg
products/sy-t8/SKU-03-Black.jpg
products/sy-t8/SKU-06-Black.jpg
```

Do not delete these during the public-display repair. Preserve them until the intended
product gallery is confirmed and a retention decision is approved.

## 5. Recovery Gates

### Gate R0: Quiescent Window

Before backfill, pause product/image edits for this environment. The reconciliation writes
absolute counts and can transiently clobber a concurrent catalog delta.

### Gate R1: Dry-Run Review

An authenticated admin must run `backfillImageRefCounts` with `dryRun: true`.
Never extract or print the session token. Run inside an authenticated browser context:

```js
async function adminAction(action, data) {
  const token = localStorage.getItem('channel.token')
  if (!token) throw new Error('Admin session required')

  const response = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, data, token }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

const expectedSyT8Ids = new Set([
  '7b76ee416a682b9401120d1d2c392d92',
  '7b76ee416a682c5a01121c63780791a3',
  '483207676a682c5c008b966626e7e62a',
  '0e0afdc26a682c5d0053647c4f007832',
  '179185b66a682c5f00698b4d2a771b8a',
  '483207676a682c61008b969854115bac',
  '7b76ee416a682b9401120d1a4e8d18e7',
  '7b76ee416a682b9401120d1c2e09555f',
  '179185b66a682c6200698bcd6f1b368c',
  '179185b66a682c6400698bd828573ec4',
  '0e0afdc26a682c660053653f3735e816',
  '7b76ee416a682c6701121d2b126e4299',
  '483207676a682c69008b97242b69a4fd',
  '179185b66a682c6c00698c4c2d5c8b50',
  '0e0afdc26a682c6e005365cb45ff89bf',
])

function canonicalChanges(changes) {
  return [...changes].sort((a, b) => a.imageId.localeCompare(b.imageId))
}

function assertExpectedDryRun(report) {
  if (report.dryRun !== true) throw new Error('Expected a dry-run report')
  if (report.changes.length !== expectedSyT8Ids.size) {
    throw new Error(`Expected exactly 15 changes, received ${report.changes.length}`)
  }
  const actualIds = report.changes.map((change) => change.imageId)
  const actualIdSet = new Set(actualIds)
  if (actualIdSet.size !== actualIds.length) {
    throw new Error('Dry-run contains duplicate image IDs')
  }
  for (const expectedId of expectedSyT8Ids) {
    if (!actualIdSet.has(expectedId)) throw new Error(`Missing expected change: ${expectedId}`)
  }
  for (const change of report.changes) {
    if (!expectedSyT8Ids.has(change.imageId)) {
      throw new Error(`Unexpected non-SY-T8 change: ${change.imageId}`)
    }
    if (change.from !== null || change.to !== 1) {
      throw new Error(`Unexpected counter delta for ${change.imageId}`)
    }
  }
}

const dryRun = await adminAction('backfillImageRefCounts', { dryRun: true })
assertExpectedDryRun(dryRun)
const canonicalDryRun = { ...dryRun, changes: canonicalChanges(dryRun.changes) }
console.log(`${JSON.stringify(canonicalDryRun, null, 2)}\n`)
```

Expected SY-T8 subset:

- exactly the fifteen existing IDs above;
- `from: null`;
- `to: 1`.

The action scans all images. The assertion deliberately fails if the report contains a
non-SY-T8 change. Stop and create a new reviewed remediation plan for every additional row;
do not weaken the assertion, truncate the report, or assume unrelated drift is safe.

Persist the exact JSON returned by the assertion to:

```text
docs/home-form-headphones-ui-fix/evidence/<UTC>-sy-t8-refcount-dry-run.json
```

The executing agent must write the exact printed JSON, including its final newline, with the
workspace file tool and run `git diff --check` on it. A human using DevTools must save/copy
the complete JSON into that path. Compute its SHA-256 with `shasum -a 256 <file>`. A
`console.table` view or screenshot is not durable approval evidence. The file must not
contain the session token, credentials, or signed URLs.

### Gate R2: Human Approval

Record:

- environment ID;
- dry-run timestamp;
- `imagesScanned`;
- complete changes array;
- SHA-256 of the persisted dry-run JSON;
- explicit approval to apply the reviewed global report.

No mutation occurs before this gate.

## 6. Apply And Verify Existing Fifteen Images

The backfill is global, sequential, and non-transactional. It has no portal-level rollback.
If one update or the HTTP response fails, earlier image rows may already have changed even
though the caller receives no applied report. On timeout, network failure, or any non-OK
response:

1. assume partial writes;
2. keep the quiescent window active;
3. do not edit catalog data or manually restore counters;
4. run a fresh dry-run and persist its complete JSON;
5. compare it with the approved pre-apply evidence;
6. obtain renewed approval before rerunning toward convergence.

A true rollback requires an explicitly approved database restore or server-side repair;
never improvise one by manually decrementing counters.

In the same quiescent window, open a fresh authenticated browser context. Paste the Gate
R1 helper declarations (`adminAction`, `expectedSyT8Ids`, `canonicalChanges`, and
`assertExpectedDryRun`) first, but do not reuse an old dry-run variable. Then run this
self-gating continuation:

```js
// Paste the exact complete file content, including its final newline.
const approvedEvidenceText = `PASTE COMPLETE APPROVED JSON FILE CONTENT HERE`
const approvedEvidenceSha256 = 'PASTE APPROVED 64-CHARACTER SHA-256 HERE'

if (!approvedEvidenceText.trimStart().startsWith('{')) {
  throw new Error('Approved evidence JSON was not pasted')
}
if (!/^[a-f0-9]{64}$/.test(approvedEvidenceSha256)) {
  throw new Error('Approved evidence SHA-256 is missing or invalid')
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const actualEvidenceSha256 = await sha256Hex(approvedEvidenceText)
if (actualEvidenceSha256 !== approvedEvidenceSha256) {
  throw new Error('Pasted evidence does not match the approved SHA-256')
}

const approved = JSON.parse(approvedEvidenceText)
assertExpectedDryRun(approved)
const approvedChanges = canonicalChanges(approved.changes)

const currentDryRun = await adminAction('backfillImageRefCounts', { dryRun: true })
assertExpectedDryRun(currentDryRun)
if (currentDryRun.imagesScanned !== approved.imagesScanned) {
  throw new Error('Current image scan count differs from the approved evidence')
}
if (
  JSON.stringify(canonicalChanges(currentDryRun.changes)) !==
  JSON.stringify(approvedChanges)
) {
  throw new Error('Current dry-run has drifted from the approved evidence')
}

// No mutation occurs above this line. The apply begins only after every approval check passes.
const applied = await adminAction('backfillImageRefCounts', {})
if (applied.dryRun !== false) throw new Error('Apply returned a dry-run report')
if (applied.imagesScanned !== approved.imagesScanned) {
  throw new Error('Applied image scan count differs from the approved evidence')
}
if (JSON.stringify(canonicalChanges(applied.changes)) !== JSON.stringify(approvedChanges)) {
  throw new Error('Applied changes differ from the approved dry-run')
}

const verify = await adminAction('backfillImageRefCounts', { dryRun: true })
if (verify.imagesScanned !== approved.imagesScanned) {
  throw new Error('Verification image scan count differs from the approved evidence')
}
if (verify.changes.length !== 0) {
  throw new Error(`Backfill did not converge: ${verify.changes.length} remaining changes`)
}
```

Acceptance:

1. Applied report equals the approved dry-run report.
2. Second dry-run reports zero changes.
3. Each of the fifteen recoverable `/api/images/:id` URLs returns:
   - HTTP 200;
   - an `image/*` content type;
   - non-zero bytes.
4. The dangling ID remains 404 until removed or replaced.
5. The SY-T8 card cover loads because its first ID is in the recoverable set.

If an existing metadata row still returns 404 after a converged backfill, stop. Recheck
`status`, provider, storage ID, and object retrieval; do not weaken the public gate.

## 7. Resolve The Dangling Reference

Choose exactly one path.

### Path A: Fast, Lowest-Risk Recovery

Use the Admin product editor to remove the dangling ID from SY-T8 and save. Keep the other
fifteen IDs in their current order.

Acceptance:

- catalog returns fifteen SY-T8 image URLs;
- all fifteen return 200;
- card/detail gallery has no broken image;
- a new refcount dry-run remains zero-change.

### Path B: Restore Main-01 Through The Canonical Uploader

Use this only after a content owner confirms that the missing position is `Main-01.jpg`.

1. Download `products/sy-t8/Main-01.jpg` to a temporary local file through authenticated
   CloudBase Storage tooling.
2. Verify JPEG magic bytes, dimensions, byte size, and checksum.
3. Open Admin -> Products -> SY-T8.
4. Upload the local file with ImageManager. This executes:
   `createUploadIntent -> direct COS POST -> completeUpload`.
5. The new image ID appends to the gallery. Use ImageManager's left control to move it into
   the confirmed position.
6. Remove the dangling ID and save the product once.
7. Confirm the new row is active, has measured metadata, and receives
   `publishedRefCount: 1` from the published product update.
8. Delete the temporary local file.

Do not manually create an `images` row pointing at the existing `Main-01.jpg`; that would
repeat the unverified side-channel adoption and bypass `completeUpload` validation.

## 8. Orphan Retention And Cleanup

Keep the original storage-only objects during recovery. After the product owner decides
whether SKU-03 and SKU-06 belong in the gallery:

- needed: re-ingest each through the canonical uploader, then add/reorder through Admin;
- not needed: record the object key, checksum, decision, and approval; delete only through a
  reviewed cleanup operation;
- never make the bucket public and never persist temporary signed URLs.

Use a retention window rather than deleting immediately so rollback remains possible.

## 9. End-To-End Acceptance Matrix

| Check | Required result |
|---|---|
| Storage inventory | Intended files exist with non-zero bytes and `image/jpeg`. |
| Metadata | Every referenced image ID has one active row with recognized provider and `publishedRefCount` equal to the number of distinct published catalog documents referencing it; for this verified SY-T8-only set, finite numeric `1`. |
| Product references | No missing IDs; no duplicate IDs; confirmed order; first ID is the cover. |
| Refcount convergence | Post-apply dry-run has zero changes. |
| Public URLs | Every projected image URL is 200 `image/*`; an unreferenced control image remains 404. |
| Card | SY-T8 cover has `naturalWidth > 0`; no broken-image alt is visible. |
| Detail | All gallery images open; navigation/order match Admin. |
| Security | Raw private bucket remains private; publication gate is unchanged. |
| Release evidence | Record timestamp, environment, product ID, IDs tested, statuses, and operator. |

## 10. Proposed Hermes / WeCom Import Contract (Not Yet Implemented)

There is no application-owned Hermes/WeCom import endpoint or manifest processor in the
current repository. Until this boundary is implemented, contract-tested, and deployed,
Hermes must not perform product-image imports. Use the human-operated Admin ImageManager,
which already executes the canonical upload and finalization flow.

The future assistant integration must not independently write storage objects, image rows,
and product references. It must call one application-owned import boundary that enforces
this sequence:

1. Receive/download WeCom media bytes.
2. Validate extension, declared MIME, size, and real magic bytes.
3. Call `createUploadIntent` with the file metadata.
4. Upload bytes with the returned single-object credential.
5. Call `completeUpload` and require `status: active`.
6. Collect only successfully finalized image IDs.
7. Update the product once with the complete ordered ID array.
8. Read the product and image rows back.
9. For published products, verify public URLs return 200.
10. On partial failure, do not publish a partial/dangling gallery; keep a retryable import
    manifest and clean pending/orphan objects through the approved cleanup path.

Required import manifest per file:

- WeCom media ID/message ID;
- original filename;
- measured byte size;
- SHA-256;
- detected MIME and dimensions;
- upload intent ID;
- resulting application image ID;
- final status;
- product update status.

The manifest must not contain storage credentials, session tokens, or signed temporary URLs.

## 11. Customer Communication Review

Original draft:

> 我看应该是传到腾讯云上了，就是它应该是自己调用 tcb 的 mcp 的旁路上传的不是通过本站接口上传，少了一些 metadata 没存到库里，展示会有问题，这个我看看怎么跟助手说下

Review:

- Directionally correct: bytes did reach Tencent Cloud and the import bypassed part of the
  portal lifecycle.
- Too uncertain about the proven fact: storage upload is confirmed, not merely "应该".
- Too certain about the unproven mechanism: TCB MCP is plausible, but Hermes logs were not
  inspected, so do not state it as fact.
- "少了一些 metadata" is incomplete: fifteen rows exist but lack refcounts, one referenced row
  is missing, and three storage objects are unregistered.
- Avoid blaming the assistant before the importer/tool trace is available.

Recommended customer response:

> 已确认图片文件本身已经成功上传到腾讯云存储，文件没有丢失。问题出在网站侧的图片发布登记没有完整完成：15 张图片已有记录，但缺少发布引用计数；另有 1 条商品图片引用没有对应的图片记录。网站的图片接口出于安全策略，会对这类未完成发布登记的图片返回 404，所以页面显示为破图。我们会先补齐发布索引、修正无效引用并逐张验证；下一步建议新增并验证企微图片导入边界，再统一接到网站标准的上传、校验和发布流程，避免再次发生。

Short internal version for the Hermes operator:

> 图片字节已成功落到 CloudBase Storage，但 portal 的 metadata/refcount/product reference 合同没有完整收敛。当前尚无 Hermes 专用的站内导入接口，请暂停自动图片导入，先由人工通过 Admin ImageManager 操作；完成并验证应用侧 import boundary 后，再让 Hermes 调用该边界并保留逐文件 import manifest。

## 12. Stop Conditions

Stop and escalate instead of applying if:

- dry-run contains unexplained non-SY-T8 changes;
- an existing image's object size/MIME does not match metadata;
- backfill times out, returns non-OK, or loses its response (assume partial writes and return to Gate R1);
- backfill apply differs from approved dry-run;
- second dry-run is non-zero;
- any recovered metadata ID still returns 404;
- the content owner cannot confirm whether Main-01/SKU images belong to SY-T8;
- an operation would require making the storage bucket public or bypassing the refcount gate.

## 13. Sanitized Evidence Appendix

This appendix preserves the read-only evidence used for the SOP. It contains no session
token, storage credential, secret, or signed temporary URL.

### 13.1 Ordered Product References

```text
01  7b76ee416a682b9401120d1d2c392d92  Detail-02
02  7b76ee416a682c5a01121c63780791a3  Detail-03
03  483207676a682c5c008b966626e7e62a  Detail-04
04  0e0afdc26a682c5d0053647c4f007832  Detail-05
05  179185b66a682c5f00698b4d2a771b8a  Detail-06
06  483207676a682c61008b969854115bac  Detail-07
07  179185b66a682c3d00697b3b4dcba5d2  MISSING METADATA; candidate Main-01 only
08  7b76ee416a682b9401120d1a4e8d18e7  Main-02
09  7b76ee416a682b9401120d1c2e09555f  Main-03
10  179185b66a682c6200698bcd6f1b368c  Main-04
11  179185b66a682c6400698bd828573ec4  Main-05
12  0e0afdc26a682c660053653f3735e816  Main-06
13  7b76ee416a682c6701121d2b126e4299  SKU-01-White
14  483207676a682c69008b97242b69a4fd  SKU-02-Sky Blue
15  179185b66a682c6c00698c4c2d5c8b50  SKU-04-White
16  0e0afdc26a682c6e005365cb45ff89bf  SKU-05-Sky Blue
```

The product row was `published: true`, and all sixteen public image routes returned HTTP
404 with the JSON error `NOT_FOUND: Image not found`.

### 13.2 Existing Metadata And Storage Match

Every row below was observed with `mimeType=image/jpeg`, `purpose=catalog-image`,
`status=active`, `storageProvider=cloudbase-storage`, and no numeric
`publishedRefCount`.

| Image ID | Storage key | Metadata bytes | Storage bytes |
|---|---|---:|---:|
| `7b76ee416a682b9401120d1d2c392d92` | `Detail-02.jpg` | 566013 | 566013 |
| `7b76ee416a682c5a01121c63780791a3` | `Detail-03.jpg` | 466980 | 466980 |
| `483207676a682c5c008b966626e7e62a` | `Detail-04.jpg` | 243366 | 243366 |
| `0e0afdc26a682c5d0053647c4f007832` | `Detail-05.jpg` | 344914 | 344914 |
| `179185b66a682c5f00698b4d2a771b8a` | `Detail-06.jpg` | 462994 | 462994 |
| `483207676a682c61008b969854115bac` | `Detail-07.jpg` | 248043 | 248043 |
| `7b76ee416a682b9401120d1a4e8d18e7` | `Main-02.jpg` | 185499 | 185499 |
| `7b76ee416a682b9401120d1c2e09555f` | `Main-03.jpg` | 140382 | 140382 |
| `179185b66a682c6200698bcd6f1b368c` | `Main-04.jpg` | 106908 | 106908 |
| `179185b66a682c6400698bd828573ec4` | `Main-05.jpg` | 69538 | 69538 |
| `0e0afdc26a682c660053653f3735e816` | `Main-06.jpg` | 394143 | 394143 |
| `7b76ee416a682c6701121d2b126e4299` | `SKU-01-White.jpg` | 140382 | 140382 |
| `483207676a682c69008b97242b69a4fd` | `SKU-02-Sky Blue.jpg` | 154007 | 154007 |
| `179185b66a682c6c00698c4c2d5c8b50` | `SKU-04-White.jpg` | 32334 | 32334 |
| `0e0afdc26a682c6e005365cb45ff89bf` | `SKU-05-Sky Blue.jpg` | 33283 | 33283 |

### 13.3 Complete Storage Inventory

| Object key | Bytes | Last modified UTC |
|---|---:|---|
| `Detail-02.jpg` | 566013 | `2026-07-28T04:09:29Z` |
| `Detail-03.jpg` | 466980 | `2026-07-28T04:10:25Z` |
| `Detail-04.jpg` | 243366 | `2026-07-28T04:10:35Z` |
| `Detail-05.jpg` | 344914 | `2026-07-28T04:10:53Z` |
| `Detail-06.jpg` | 462994 | `2026-07-28T04:11:14Z` |
| `Detail-07.jpg` | 248043 | `2026-07-28T04:11:27Z` |
| `Main-01.jpg` | 154007 | `2026-07-28T04:08:14Z` |
| `Main-02.jpg` | 185499 | `2026-07-28T04:08:58Z` |
| `Main-03.jpg` | 140382 | `2026-07-28T04:09:05Z` |
| `Main-04.jpg` | 106908 | `2026-07-28T04:11:36Z` |
| `Main-05.jpg` | 69538 | `2026-07-28T04:11:42Z` |
| `Main-06.jpg` | 394143 | `2026-07-28T04:11:57Z` |
| `SKU-01-White.jpg` | 140382 | `2026-07-28T04:12:04Z` |
| `SKU-02-Sky Blue.jpg` | 154007 | `2026-07-28T04:12:17Z` |
| `SKU-03-Black.jpg` | 97419 | `2026-07-28T04:12:25Z` |
| `SKU-04-White.jpg` | 32334 | `2026-07-28T04:12:30Z` |
| `SKU-05-Sky Blue.jpg` | 33283 | `2026-07-28T04:12:35Z` |
| `SKU-06-Black.jpg` | 30671 | `2026-07-28T04:12:39Z` |

### 13.4 Byte-Level Sample

```text
object: products/sy-t8/Detail-02.jpg
file: JPEG/JFIF baseline, 790x1405, 3 components
bytes: 566013
sha256: 1744689de9ee9623bbc378fd732ae8f0f1021cde822e24ba55bfd73f5e8502ea
temporary local copy: removed after inspection
```
