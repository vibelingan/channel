# Homepage to OEM Development Content Sync

## Goal

Prepare an implementation-ready handoff that makes the current homepage the single narrative source for `/oem`, without changing the homepage or breaking OEM-specific media, anchors, or form behavior.

## Truth Conditions

- Branch is based on the latest fetched `origin/main`.
- Every reported difference is traceable to the current content source or page composition.
- Every implementation decision is explicit enough that the remote agent does not invent copy, anchors, component choices, or media behavior.
- No production page content is changed during this audit.

## Phases

- [x] Establish an isolated branch from latest `origin/main`.
- [x] Compare homepage and OEM content sources and rendered section composition.
- [x] Check content history and prior OEM source-material review.
- [x] Record the UI design verdict (`DESIGN_NOT_REQUIRED`).
- [x] Convert findings into fixed implementation decisions.
- [x] Produce a complete Level 1 + Level 2 MIU handoff.
- [ ] Remote agent implements the MIUs on this feature branch.

## Baseline

- Branch: `feat/oem-homepage-content-sync`
- Base: `origin/main` at `993c7c33a1cf1446b837d44502bcc57082d993f6`
- Worktree: `/Users/SeanCai/Desktop/projects/channel-oem-homepage-content-audit`

## Errors Encountered

- `pnpm typecheck` and `pnpm lint` could not run in the fresh worktree because it has no local
	`node_modules`; the root scripts attempted interactive `npx` downloads. Both prompts were
	rejected. This is the already-documented repository tooling issue `ERR-20260723-001`, not a
	content failure. Resolution: installed the lockfile-pinned dependencies with
	`pnpm install --frozen-lockfile`, then ran the direct workspace typecheck and configured lint
	successfully.
- Biome does not process Markdown in this repository. Validation for this docs-only audit uses
	patch whitespace checks, manual evidence review, branch ancestry, and changed-file scope.