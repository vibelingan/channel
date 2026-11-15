# Measured costs (US GitHub-hosted runner → ap-shanghai)

All from the `channel` project, November 2026. Re-measure before relying on a number:
`gh api repos/OWNER/REPO/actions/jobs/JOB_ID --jq '.steps[]'` for step times, and the
step log's JSON lines for per-call `elapsedMs`.

## Hosting (static site) uploads

- Run 41850270700: 555 files in 47 journaled batches of ≤12, 4-way → ~31 min of a
  43.7-min delivery. Per batch ~37 s: uploads ~22 s, public before/after GETs ~10 s,
  journal calls ~6.8 s.
- In `@cloudbase/manager-node` 5.9.1, `HostingService.uploadFiles` → `getHostingBucket`
  (one API call), then `StorageService.uploadFilesCustom` → `uploadFilesParallel`,
  which builds `getCos(parallel)` per call. Failed parallel files get one serial retry.
- `onFileFinish(error, result, file)` reports `file.cloudFileKey` as the logical path;
  require one success callback per file — SDK counts alone are not proof.

## Large objects

- 83 MB private archive: 143–228 s at 8 parts, 157 s at 32 parts (~325–365 KB/s).
- 9 MB function ZIP through `cloudbase.manageStorage upload`: 4.7 min and 2.1 min
  on two runs.

## Deploy-step calls

- 40 collections × 6 MCP spawns (~2.9 s each) = 11.5 min; after re-read-only-after-write
  and 4-way checks: ~1.4 min (run 41972333945).
- Function update via CLI zip: ~30–35 s per small function including activation.

## Consistency

- A deleted temporary Event function was still listed after six checks over ~8 s
  (run 41878896329); a ~58 s bounded backoff has been sufficient since.
