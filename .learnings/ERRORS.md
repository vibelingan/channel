# Errors

## [ERR-20260723-001] npx-pnpm-version-switch

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: tooling

### Summary
Root scripts wrapping `npx pnpm` attempted a pnpm version switch and interactive install.

### Error
The command appeared to hang or proposed reinstalling dependencies instead of running the requested check.

### Context
The repository declares pnpm 11 while a different global pnpm was active. `npx pnpm` resolved another CLI path.

### Suggested Fix
Use direct `pnpm --filter`, `pnpm -r`, and `pnpm exec` commands. Do not use root aliases that shell through `npx pnpm` during automated work.

### Metadata
- Reproducible: yes
- Related Files: package.json
- Tags: pnpm, npx, interactive-prompt

---

## [ERR-20260723-002] zsh-special-name-colon-modifier

**Logged**: 2026-07-23T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
zsh special variables and colon modifiers broke loop commands and interpolated image options.

### Error
Using `path` as a loop variable replaced `$PATH`; unbraced `commit:path` and `$color:similarity` expressions were parsed as zsh modifiers; mixed quotes could leave a `dquote>` prompt.

### Suggested Fix
Avoid zsh-reserved names, use `${value}:suffix`, and move complex logic into structured scripts rather than dense one-liners.

### Metadata
- Reproducible: yes
- Related Files: docs/oem-phase-1-5/LESSONS.md
- Tags: zsh, shell, quoting, path

---

## [ERR-20260723-003] image-tool-capability-mismatch

**Logged**: 2026-07-23T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
Assumed image CLI features were unavailable or used different syntax in the installed environment.

### Error
Sharp was not installed; `sharp-cli` expected global `--format webp`; ffmpeg lacked the needed WebP encoder/drawtext and rejected attempted `lutrgb` expressions.

### Suggested Fix
Probe tool/version capabilities before designing the pipeline. Use pinned ephemeral tools only after checking syntax; use Pillow when pixel-level alpha and WebP output are required.

### Metadata
- Reproducible: yes
- Related Files: apps/site/public/media/portfolio/customers/
- Tags: sharp, ffmpeg, pillow, webp

---

## [ERR-20260723-004] http-smoke-body-lifecycle

**Logged**: 2026-07-23T00:00:00Z
**Priority**: critical
**Status**: resolved
**Area**: infra

### Summary
Deployment smoke passed every assertion but retained unread response bodies and did not exit.

### Error
GitHub Actions run `29761700772` remained alive until its sole job was canceled at 27m50s.

### Suggested Fix
Use `fetchFully()` to drain/cancel the body, bound header/body/control-plane/step time, cap bytes, and test process-lifecycle cases. Resolved by `e55b4a1` and verified in run `29801125323` with a 23-second smoke exit.

### Metadata
- Reproducible: timing-sensitive
- Related Files: scripts/smoke-http.mjs, scripts/smoke-http.test.mjs
- Tags: fetch, undici, response-body, ci-hang

---

## [ERR-20260723-005] retry-excluded-response-body

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
The live-asset retry wrapper covered `fetch()` but not `arrayBuffer()`.

### Error
Headers returned successfully, then the body timed out outside the retry block on a CDN object.

### Suggested Fix
Retry status validation and complete body consumption as one operation. The corrected verifier matched all 21 deployed assets to local SHA-256.

### Metadata
- Reproducible: intermittent
- Related Files: docs/oem-phase-1-5/LESSONS.md
- Tags: fetch, retry, cdn, body-timeout

---

## [ERR-20260723-006] incomplete-delegated-audit

**Logged**: 2026-07-23T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: process

### Summary
Delegated audits reported broad confidence without complete tool access or coverage.

### Error
One report covered 23/35 commits; another read only an early transcript slice; two commit shards lacked terminal access. Some still used “complete” language.

### Suggested Fix
Mechanically enumerate the expected set in the parent session, require each shard to return exact coverage, and reject incomplete reports. Parse large JSONL structurally instead of relying on long-field `read_file` previews.

### Metadata
- Reproducible: yes
- Related Files: docs/oem-phase-1-5/LESSONS.md
- Tags: subagent, audit, truncation, coverage

---

## [ERR-20260723-007] persistent-terminal-cwd-drift

**Logged**: 2026-07-23T00:00:00Z
**Priority**: critical
**Status**: resolved
**Area**: tooling

### Summary
A repository-wide lint command passed in the shared checkout instead of the isolated delivery worktree because the persistent terminal reused a different cwd.

### Error
The first green result checked 166 files on `fix/enhance-features-vip`; the intended worktree contained 187 files and still had two JSON formatting errors.

### Suggested Fix
For every build, lint, test, commit, and push in a multi-worktree session, explicitly enter the absolute worktree and assert `$PWD` before the command. Include the branch/worktree name in accepted validation evidence.

### Metadata
- Reproducible: yes
- Related Files: docs/oem-phase-1-5/LESSONS.md
- Tags: terminal, cwd, worktree, false-green

---

## [ERR-20260723-008] tsx-import-meta-resolve

**Logged**: 2026-07-23T00:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: tooling

### Summary
`import.meta.resolve()` was unavailable when `tsx --test` transformed the test through its CommonJS register path.

### Error
The test failed at startup with `TypeError: define_import_meta_default.resolve is not a function`.

### Suggested Fix
Resolve workspace package exports in these tests with `createRequire(import.meta.url).resolve(packageName)`, which works under the repository's current tsx transform and still validates the package export boundary.

### Metadata
- Reproducible: yes
- Related Files: apps/functions/admin/src/oem-email-content.test.ts
- Tags: tsx, import-meta, create-require, package-resolution

---