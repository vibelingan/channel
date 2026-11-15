# Recovery archive v2: store only what changed

Status: implemented and verified on `test` (PR #84). Owner decisions are not needed unless
the review questions below are reopened.

## Problem

Every site delivery keeps a private recovery copy of the release payload so the site can be
rolled back after the GitHub artifact expires (90 days). Today (record schema 1) that copy
is one ZIP of the whole payload, `seo-recovery/objects/<sha256>.bin`, about 83 MB.

The ZIP's hash changes on every run, because two small per-run files travel inside it, so
every deploy uploads all 83 MB again:

| Measured | Value |
|---|---|
| Payload | 1,810 files, 166 MB raw, 83 MB compressed: videos 43 MB, JS 14 MB, HTML 12 MB, images 12 MB |
| Files that differed between runs 42582880958, 42962596960 and 42973739468 (Nov 9–11) | `compatibility.json` (148 B, holds the commit) and `payload-manifest.json` (run identity); nothing else |
| Upload of the 83 MB copy from the US runner | 2.3–4.5 min per deploy (~350 KB/s to ap-shanghai) |
| Readbacks of that copy during the save | two full downloads (~15–20 s each): one inside `put`, one in `load` |
| Storage | +83 MB per deploy, never deleted |

## Goals and invariants

Must keep (unchanged from schema 1):

1. Rollback works after the GitHub artifact expires: the private copy alone restores the
   exact payload, verified by SHA-256 of every byte read.
2. The bucket is private and has no expiry or archive-transition rule on `seo-recovery/`.
3. A record is written only after its stored bytes were proven equal to the payload.
4. Records already written (schema 1) stay readable.
5. Reads stay hardened against hostile archives (member names, sizes, counts).

Goals: a deploy with no page change stores only the per-run files (seconds, not minutes);
a deploy that changes some pages uploads only the part of the payload that changed.

## Options considered

| Option | No-change deploy | Template change (all HTML/JS) | Product edit (a few pages) | Objects per record | Recovery read |
|---|---|---|---|---|---|
| Schema 1 (today) | 83 MB | 83 MB | 83 MB | 1 | 1 GET |
| A. One object per file | ~0 | ~33 MB, 1,800 puts (~6 min of call overhead) | ~100 KB | 1,810 | 1,810 GETs (~2.5 min) |
| B. Content ZIP + small head | head only | 83 MB | 83 MB | 2 | 2 GETs |
| C. Head + large files alone + small files in 32 path-hash packs | head only | ~33 MB | a few MB | ~42 | ~42 GETs |

Chosen: **C**. It keeps A's property that unchanged bytes are not uploaded for the cases
that occur, with a bounded object count, and it is no harder to build than B because the
code handles a list of objects either way.

## Design

### Layout (stored in every record, so it can change later)

`{ kind: 'site-packs', version: 1, packs: 32, soloBytes: 524288 }`

The object plan is a pure function of `payload-manifest.json` and the layout:

- **head**: `payload-manifest.json` and `compatibility.json`, the files that carry the run's
  identity.
- **solo**: each other file of at least `soloBytes` raw bytes, alone (videos, large images,
  `product-snapshot.json`; 9 files, 50 MB compressed, which rarely change).
- **pack n**: every remaining file whose `sha256(path)` (first 32 bits) mod 32 is n (median
  ~1 MB compressed, largest ~2 MB).

Each object has a **content id**: SHA-256 of its canonical member list
`[[path, bytes, sha256], …]` with the layout version. The stored object stays a deterministic
ZIP addressed by the SHA-256 of its bytes, under the same `seo-recovery/objects/<sha>.bin`
key family as schema 1.

### Record (schema 2)

Stored in `catalogSeoArchives` under the doc id `site-v2-<artifactId>`. Schema 1 records
stay under `<artifactId>`. Fields: the schema 1 identity fields (`artifactId`, `releaseId`,
`codeSha`, `target`, `repository`, `manifestSha256`, `run`), `layout`, and `objects`:
`[{ key: 'head' | 'solo:<path>' | 'pack:<n>', contentSha256, members, object: {fileID,
bytes, sha256}, etag }]`.

### Save

1. Same input checks as schema 1. An existing record for the artifact (either doc id)
   with the same manifest returns early, as today.
2. Plan the objects from the payload directory.
3. For each object whose content id this process has already verified (from the accepted
   baseline it read, or an earlier save): HEAD it. Same size and ETag as when verified →
   reuse with no transfer. Different ETag → read it fully and check its SHA-256. Absent →
   upload it again.
4. Pack the rest locally (deterministic ZIPs), check each packed ZIP with the extractor in
   plan mode, upload each (6 at a time), read it back fully (SHA-256), then HEAD it for its
   ETag.
5. Write the record, read it back, compare.

The second full readback of schema 1 (`load` inside `save`) is gone: every object in the
record is proven either by a full readback in this save or by an unchanged ETag since its
own full readback.

### Load (rollback and the baseline read at every deploy)

1. Read the record (schema 2 doc id first, then schema 1).
2. Schema 1: unchanged code path.
3. Schema 2: read the head, check `payload-manifest.json` against `manifestSha256`,
   recompute the plan from it with the record's layout, and require the plan's content
   ids to equal the record's objects exactly. Read every object (8 at a time, SHA-256
   verified), then extract all of them in one plan-mode run of the extractor: each ZIP
   must hold exactly its planned members, with planned sizes and SHA-256, under the same
   name and budget checks as schema 1, with no member in two objects.
4. The same identity checks and retained proof as schema 1.

### Bucket policy checks

`private-archive` checks the bucket's permission and lifecycle before every put and get
(two API calls, 0.6–3 s each from the US). With ~42 objects that would add minutes, so the
site delivery memoizes the result for 10 minutes per process (opt-in; other callers keep
checking every time).

## Socratic review

Each question was asked against the first draft; answers that changed the design are
marked **changed**.

1. **Why store a new record per run at all, if the payload did not change?** Records are
   looked up by artifact id, and every accepted run must be restorable by its own id. With
   schema 2 a run's own cost is its head (about 60 KB compressed).

2. **Is reusing an object written by an earlier run weaker than writing a fresh one?** The
   key is the hash of the bytes, and reuse requires a HEAD with the size and ETag recorded
   when the object was fully read back. A rewrite changes the ETag, which forces a full
   read; a deletion forces a re-upload. Schema 1 already trusted a record once written.

3. **What about bytes that rot without an ETag change?** The next deploy reads the
   accepted record fully (it prefers the private copy when one exists), so every object of
   the live record is re-verified at every deploy: the same detection point as schema 1.

4. **Shared objects mean one lost object breaks many records. Acceptable?** This is the
   real cost of not re-uploading. Mitigations: nothing deletes these objects, expiry rules
   are refused, the bucket is private, every deploy reads the live record fully (so a loss
   is found at the next deploy, while the GitHub artifacts of the last 90 days still exist),
   and a missing object is uploaded again by the next save of the same content. That repairs
   every record naming it when the ZIP comes out byte-identical, which it does with the same
   Python and zlib (unit-tested); otherwise older records need their GitHub artifact. Any
   future cleanup must count references across all records; this is stated in
   `docs/agents/cloudbase.md` and beside the code.

5. **Why not one object per file?** 1,810 puts on a full change and 1,810 GETs on a
   restore cost minutes of per-call latency from the US, more than the bytes.

6. **Why not two objects (content + head)?** It covers only no-change deploys. Any page
   change would upload 83 MB again, including 43 MB of videos that have not changed.

7. **What if zlib changes and the same files pack to different bytes?** Reuse is decided
   by content id (the member list), not by ZIP bytes; a stored object stays whatever bytes
   were verified when it was written.

8. **What if the layout constants change later?** Each record carries its layout; load
   recomputes the plan with the record's layout and requires the same content ids.

9. **A product edit touches ~5–10 files in different packs; is that still a lot?** About
   5–10 MB (15–30 s) instead of 83 MB. An overlay pack of only the changed files would cut
   that to kilobytes but needs pack chains and compaction; deferred, and the record format
   allows it later.

10. **Is the baseline read at every deploy slower with ~42 objects?** Each read is
    HEAD + GET + HEAD; 8 at a time with the policy check memoized, so about the same as one
    83 MB stream (~20 s). Measured on test.

11. **What happens if this change is reverted?** **Changed**: the first draft wrote
    schema 2 under the same doc id; schema 1 code throws on a schema 2 record, which would
    block every deploy after a revert. Schema 2 records now use their own doc id, so
    reverted code finds no record and falls back to the GitHub artifact (90 days), and
    writes schema 1 again.

12. **Could a save that fails halfway leave a bad state?** Objects are immutable and
    unreferenced until the record is written; the next attempt re-plans, uploads the
    missing ones again (same keys) and writes the record.

13. **Could a crafted object smuggle files?** The plan-mode extractor requires each ZIP to
    hold exactly its planned names with planned sizes and SHA-256, no duplicates across
    objects, and the schema 1 safety and budget checks.

14. **Does the memoized bucket check hide a bucket made public mid-run?** The bucket is
    re-checked every 10 minutes and at the start of every process; an object written in
    that window lands in the bucket that already holds every earlier copy, so the exposure
    is the bucket's, not this write's.

15. **Two deploys at once?** Deploys share one concurrency group and the delivery lease;
    content-addressed writes are idempotent anyway.

16. **What proves it on the real environment?** **Changed**: the first draft relied on unit
    tests. Two consecutive test deploys cover every path: the first reads a schema 1
    baseline and writes the first schema 2 record (all ~42 objects); the second reads that
    schema 2 record as its baseline (the full restore read used by a rollback after expiry)
    and writes a record that reuses everything but the head.

17. **Can one object's upload run out of time while others share the link?** **Changed**
    (found while checking the upload path against measured rates): COS sends an object of
    n MiB as n parallel 1 MiB parts, each bounded by the archive deadline (60 s up to 8 MiB),
    and one connection from the US carries ~15–40 KB/s. Unbounded parallel uploads (three
    videos are 40 parts) would leave a 1 MiB part at ~8 KB/s, past its deadline. Uploads now
    keep about 8 parts in flight, the count that already reached the link's full
    ~350–580 KB/s in earlier runs: a multipart video goes alone, small packs go 8 at a time,
    and a part takes ~20 s.

## Test plan

Unit (Node 22.13.0): plan determinism and member placement; content ids; save uploads only
new objects; reuse with matching ETag transfers nothing; ETag mismatch reads fully;
absent object re-uploads; corrupt object fails load before extraction; schema 1 records
still load; a schema 2 record whose plan differs fails; extractor rejects a missing, extra,
resized or altered member and a member present in two objects; the memoized bucket check
re-checks after its window.

Local, on the real payload of run 42973739468 (fake store): 42 objects (largest 14.9 MB,
head 111 KB), packing and checking 83 MB took 3.1 s, all 1,810 restored files match the
manifest, and a save with unchanged pages uploads nothing.

Real: PR CI, then two consecutive deploys on `test` with the step timings and the archive
log lines (reused / uploaded objects, bytes, ms) compared to run 42973739468.

## Expected effect

| Deploy kind | Schema 1 | Schema 2 |
|---|---|---|
| No page change (most deploys so far) | 2.3–4.5 min upload + ~35 s readbacks | ~10–20 s (a 111 KB head) |
| Product edit (a few pages) | same | ~30–60 s |
| Template change (all pages) | same | ~1.5–2 min |
| First schema 2 deploy | — | about today's cost, once |

Storage per no-change deploy: ~60 KB instead of 83 MB.

## Results on `test`

| Run | What it proved | Archive | Deploy job | Run (push → done) |
|---|---|---|---|---|
| 42973739468 (before) | schema 1 | 83 MB upload + 2 readbacks: 4.5 min | 20 min | 26.2 min |
| 43078023025 | read a schema 1 baseline (83 MB in 13.7 s); first schema 2 save | 42 objects, 83.4 MB uploaded in 98 s; object upload median 5.3 s, max 9.3 s | 14.0 min | 25.5 min |
| 43082348067 | full read of a schema 2 baseline (the restore a rollback uses); save with unchanged pages | baseline read 42 objects, 83.4 MB in 13.7 s; save reused 41, uploaded the 111 KB head: 5.1 s | 12.5 min | ~18 min (5.8 min CI and preparation + 12.5 min) |

Deploy 2's first attempt stopped before any write: the delivery's first read (the
functions' runtime health) hit a network connect timeout to the CloudBase gateway. The
failed job was re-run on the same commit.
The site delivery step went from 8.7 min (before) to 4.2 min (first schema 2 save) to
2.9 min (unchanged pages). Per no-change deploy the recovery copy now costs a 5 s save
plus the 13.7 s full read of the accepted copy, which schema 1 also did.

## Incident: the first deploy with changed pages (Nov 12)

The assistant session's deploy (release tip 13195c98, a CSS change touching every page)
was the first to upload more than the head. It failed three times in site delivery,
always before any write, so the live site was never changed:

| Run | Failure | Cause | Fix |
|---|---|---|---|
| 43212545234 (two attempts) | uploads `ETIMEDOUT` at exactly 60 s | The archive COS client ran one file at a time (`FileParallelLimit: 1`) while schema 2 handed it up to 8 uploads; each deadline started at hand-over, so queued uploads expired before starting. Deploys 1 and 2 passed only because the link drained the queue in time | #88: the delivery's client runs 8 files at once; deadlines grow with object size; one retry per object |
| 43217655741 | `Invalid archive transfer time limit` while reading the baseline | #88's sized deadline exceeded the transfer layer's 300 s maximum; its unit tests used a fake transport without that guard | #89: cap at `ARCHIVE_TRANSFER_MAX_MS`; a test through the real transfer layer and COS SDK; a dry run of the full 42-object save and restore through the real chain before deploying |
| 43221879924 | passed | | |

Run 43221879924 on a very slow link (~56 KB/s aggregate, a tenth of Nov 11): baseline read
42 objects in 21.7 s; save reused the 9 large files and uploaded 33 objects (32 packs and
the head, 33.5 MB) in 599 s, slowest object 147 s. Schema 1's single 83 MB upload under a
300 s limit could not have passed on that link.

Lessons: a deadline must start when the work starts, not while it waits in a queue below
it; a change to deadlines or limits must be tested through the real layer that enforces
them, not a fake; and a change to the delivery path should be dry-run through the real
transfer chain on the real payload before it reaches `test`.
