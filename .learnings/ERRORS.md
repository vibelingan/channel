# Resolved Errors

## [ERR-20260821-002] WebKit project assumed but not configured

**Logged**: 2026-08-21T13:27:00Z
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

A final validation command selected `--project=webkit`, but `playwright.config.ts` exposes only the
`chromium` project.

### Resolution

Read the configuration, did not retry an invented environment switch, and corrected the handoff so
historical WebKit results are not presented as final-code evidence.

### Metadata

- Reproducible: yes
- Related Files: `playwright.config.ts`, `docs/form-select-refactor/progress.md`
- Source: error

---

## [ERR-20260821-001] independent review provider capacity

**Logged**: 2026-08-21T13:15:00Z
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

The first independent review agent failed before producing a result because its upstream provider
was at capacity.

### Resolution

Retried with the dedicated review agent, which completed and found actionable regressions before
delivery.

### Metadata

- Reproducible: unknown
- Related Files: `apps/site/src/components/form/Select.tsx`
- Source: error

---

## [ERR-20260820-002] push command blessed SHA from wrong persistent cwd

**Logged**: 2026-08-20T04:18:00-07:00
**Priority**: high
**Status**: resolved
**Area**: tooling

### Summary

The push reached the correct remote ref but the persistent terminal had drifted to the main checkout, so `.last-reviewed-sha` was written from an unrelated branch.

### Resolution

Re-entered the absolute feature worktree, rewrote the marker from its HEAD, and verified local HEAD, remote-tracking HEAD, and blessed SHA all equal `9c380360a4bfdad62875ee94825ec937e6784f9c`.

### Suggested Fix

Every bless/push command must begin with an absolute `cd` and assert `$PWD`, even when the immediately preceding command ran in the intended worktree.

### Metadata

- Reproducible: yes
- Related Files: `.claude/.last-reviewed-sha`
- Source: error

---

## [ERR-20260820-001] ripgrep unavailable in linked worktree terminal

**Logged**: 2026-08-20T03:12:00-07:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary

The linked worktree terminal could not resolve `rg` even though repository searches were needed.

### Resolution

Used a narrowly scoped recursive `grep` over the intended source extensions and retained the absolute-worktree guard.

### Metadata

- Reproducible: environment-dependent
- Related Files: `apps/site/src/`
- Source: error

---

## [ERR-20260726-001] Playwright reused another checkout's server

**Logged**: 2026-07-26T01:50:00-07:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

A focused E2E test targeted the default localhost port, which was occupied by a server from another checkout and returned a misleading 404.

### Error

```text
404: Not Found — Path: /electronics-toys/
```

### Context

- The Playwright config defaults to `http://localhost:4321` and does not own a web server.
- The active server on that port served a different checkout without the new route.

### Suggested Fix

Start the intended worktree's server on an isolated port and set `E2E_SITE_URL` explicitly for focused browser runs.

### Metadata

- Reproducible: yes
- Related Files: `playwright.config.ts`, `tests/e2e/catalog-hub.spec.ts`
- Source: error

---

## [ERR-20260729-002] worktree-playwright-module-resolution

**Logged**: 2026-07-29T12:00:00Z
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary

A standalone Node measurement script in the isolated worktree could not resolve the `playwright`
package even though repository E2E and shared browser tooling are available elsewhere.

### Error

```text
Error: Cannot find module 'playwright'
Require stack:
- /Users/SeanCai/Desktop/projects/channel-ui-headphones-fix/[stdin]
```

### Context

- The command attempted a read-only deployed gallery measurement with `require('playwright')`.
- The isolated worktree does not expose that package through Node's local resolution path.
- Installing or changing dependencies merely for this design review would have changed scope.

### Suggested Fix

Use the repository's configured Playwright command/package boundary or the shared browser tool for
future measurements. Do not assume a package used by repository tooling is directly require-able
from every worktree.

### Metadata

- Reproducible: yes
- Related Files: `playwright.config.ts`, `tests/e2e/public.spec.ts`
- Source: error

### Resolution

- **Resolved**: 2026-07-29T12:00:00Z
- **Notes**: Did not repeat the command or alter dependencies. Used the existing shared-browser
	18/18 interaction evidence and persisted exact viewport/style/network checks for implementation.

---

## [ERR-20260729-001] biome-project-context-eof

**Logged**: 2026-07-29T02:14:11Z
**Priority**: low
**Status**: resolved
**Area**: config

### Summary

Biome rejected the generated project context after its visible JSON formatting was corrected because the file retained a missing final newline.

### Error

```text
.claude/project-context.json format
Formatter would have added an empty final line after the closing brace.
```

### Context

- `corepack pnpm exec biome check .` found one formatting error.
- `apply_patch` corrected the array layout but retained the file's no-newline EOF attribute.
- A second patch that touched the closing brace still did not change the EOF byte state.

### Suggested Fix

When a formatter reports only a missing EOF newline and `apply_patch` preserves it, use the repository formatter on that single file, then immediately rerun its focused check.

### Metadata

- Reproducible: yes
- Related Files: `.claude/project-context.json`
- Source: error

### Resolution

- **Resolved**: 2026-07-29T02:14:11Z
- **Notes**: `corepack pnpm exec biome format --write .claude/project-context.json` rewrote the EOF correctly; the subsequent focused Biome check passed.

---# Errors

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

## [ERR-20260723-009] heredoc-failure-masked-by-following-command

**Logged**: 2026-07-23T00:00:00Z
**Priority**: critical
**Status**: resolved
**Area**: tooling

### Summary
A Node heredoc validation failed, but later shell commands still ran and printed a misleading final PASS.

### Error
The heredoc terminator was followed by another command on a new line without `&&` or an explicit exit-status guard. zsh continued after Node exited non-zero, so the overall terminal command returned success from the final check.

### Suggested Fix
Run high-risk validators as separate terminal calls, or explicitly capture and assert the heredoc exit code before any following command. Never accept a final PASS line without checking every preceding command result. Keep semantic scans carrier-specific: generic marketing terms may also appear in metadata, and raw Markdown may split one phrase across lines.

### Metadata
- Reproducible: yes
- Related Files: docs/oem-phase-1-5/PHASE8_TEST_PLAN.md
- Tags: heredoc, shell, exit-code, false-green, validation

---

## [ERR-20260730-001] independent-review-agent-network-abort

**Logged**: 2026-07-30
**Priority**: medium
**Status**: pending
**Area**: process

### Summary
Both final read-only MIU review agents aborted with a network error before returning analysis.

### Error
```text
Agent error: Sorry, there was a network error. Please try again later.
Error Code: aborted.
```

### Context
- Two parallel review requests failed through the same service path.
- Local editor diagnostics and the complete executable validation suite remained green.
- The failed calls were not treated as approval or as code findings.

### Suggested Fix
Use independent local mutation probes and the cross-file checklist as the immediate fallback, then retry one review agent after the service recovers.

### Metadata
- Reproducible: unknown
- Related Files: `scripts/runtime-contract.test.mjs`, `.github/workflows/deploy-test.yml`
- Tags: subagent, network, review-gate

---