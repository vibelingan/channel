# Taxonomy Menu Investigation: 2026-09-21

## Verdict

The CI trace confirms that the desktop catalog menu closes during the full-page
screenshot, before the child-link click. The exact event that closes it is not
proven. No production fix, readiness wait, forced click, menu reopening, or
business-assertion change was retained.

This remains an unresolved intermittent failure, not a fixed or waived gate.

## Scope and Provenance

- Worktree: `.claude/worktrees/catalog-price-repair`.
- Local HEAD: `cab8a89da6dce82a7bcc50f06e633017dd37369d`.
- Failed run: `35533458803`, push at
  `23e7e1f14f4cfb91e27bc26afbe365b31d908034`, conclusion `failure`.
- Artifact API: `repos/vibelingan/channel/actions/runs/35533458803/artifacts`.
- Only downloaded artifact:
  `catalog-local-browser-23e7e1f14f4cfb91e27bc26afbe365b31d908034`,
  ID `10611969085`, 18,293,147 bytes, not expired.
- Ignored evidence directory:
  `output/catalog-price-repair/ci35533458803`.
- Extracted the taxonomy `trace.zip` with `unzip`; parsed JSON with Node.
  Compressed DOM references were resolved using the installed Playwright 1.61.1
  snapshot decoder. No Python, credential output, or network-body dumps.
- No commit, push, branch change, deployment cancellation, cloud configuration,
  global configuration, or live catalog mutation. Run `35535390022` was not touched.

## Current Release Snapshot

The implementation owner's latest snapshot reports two successful PR #60 CI checks
at pushed feature `cab8a89` (Build 18m59s). Release
`5a6317e62df4388bccf076dcd214e4ce65d71c35` is active: independent public health
returned HTTP 200 and that exact SHA for all three services. In
[Deploy Test 35535390022](https://github.com/vibelingan/channel/actions/runs/35535390022),
CI AI/Build, deployment and smoke steps succeeded; final public E2E is still running
at this snapshot. The whole workflow is not yet complete.

These current results and the unchanged 135-test full browser rerun below do not
fix or waive the confirmed intermittent menu closure. Failed taxonomy CI
`35533458803` is a distinct historical run from Deploy Test `35533459007`, which
was cancelled on its job time limit and skipped deployment. Neither is the latest
Deploy Test run. The exact menu-closing event remains unproven; no fix was retained.

Full raw price replay and summary apply have NOT RUN. PR #60 remains unmerged until
full incident acceptance per the handoff, an acceptance gate rather than a claim
that the code cannot merge. This note remains untracked; the tracked
[release record](RELEASE-2026-09-21.md) carries the portable status, health build
times, residual finding and authorized operator path. This documentation update
did not rerun CI/browser checks or access cloud data.

## Confirmed Failure Sequence

The relevant file is `1-trace.trace`. Times below are trace-relative milliseconds,
not wall-clock times. Viewport snapshots are 1440 x 900.

| Time | Trace checkpoint | Confirmed state |
| --- | --- | --- |
| 9179.174 | `input@call@482` | Click target is the desktop catalog summary; menu closed. |
| 9185.599 | `after@call@482` | Desktop disclosure has `open`; header mode is desktop. |
| 9219.627 | `after@call@488` | Child-link scroll finished; desktop disclosure still open. |
| 9265.467 | `before@call@492` | Immediately before screenshot: disclosure still open, mode desktop. |
| 9269.086 | Screenshot log | `fonts loaded`. Recorded font requests after reload had completed before the summary click. |
| 9561.003 | `after@call@492` | Immediately after screenshot: disclosure no longer has `open`, mode still desktop. |
| 9564.884 | `before@call@494` | Before child-link click: disclosure remains closed. |
| 9600.091 | Click action log | Child anchor resolves, but `element is not visible`. |
| 24566.192 | Click completion | `Timeout 15000ms exceeded.` |

The actual attribute is `data-header-mode`, not `data-nav-mode`. Every sampled
snapshot in this interval says desktop. Snapshots do not exclude a transient
desktop-to-mobile-to-desktop transition between samples.

The failure accessibility snapshot marks the account button active. Its dropdown
has `aria-expanded="false"` throughout the decoded interval. The white rectangle
in the screencast is not evidence of an open account dropdown.

The pre-click screenshot, inspected directly, already shows the catalog menu
closed:
[headphones-1440-header.png](../../output/catalog-price-repair/ci35533458803/test-results/catalog-taxonomy-local-tax-ecf74--drive-all-four-storefronts-chromium/headphones-1440-header.png).

## Owning Code and Unproven Hypothesis

[SiteHeader.astro](../../apps/site/src/components/SiteHeader.astro) owns the
responsive mode measurement, focus transfer, and deferred `focusout` dismissal.
Its focus-transfer functions can fall back to an account control when the
previously focused element has no anchor URL, as a catalog summary does.
Desktop focus restoration is scheduled for a later animation frame.

This makes a responsive focus transfer followed by deferred dismissal a concrete
candidate. It is not proof that a stale callback caused this CI failure. The
trace has no focus-event chronology, mode-mutation chronology, or callback stack
inside the screenshot interval. The final focused account button alone cannot
establish which of those events ran first.

A font-readiness wait is also not justified by this evidence: font requests had
completed before the summary click, and screenshot font readiness completed
before the closure was observed. The data does not demonstrate a test click
before header stability.

The neighboring unit tests cannot resolve the timing question: some check source
structure, while the taxonomy lifecycle harness exercises fetching and BFCache
restoration rather than browser focus, resize, and screenshot interleaving.

## Local Reproduction and Checks

A temporary, credential-free `addInitScript` recorded focus events, programmatic
focus stacks, disclosure toggles, resize events, and header-mode mutations.
The production runner still built its disposable site and API, and ran the
original taxonomy journey with all business assertions intact. Unrelated suites
were skipped only for that diagnostic invocation.

That run passed all four product families at desktop and mobile sizes in 35.5s.
It did not reproduce an account focus transfer during the screenshot. Logging
can perturb timing, and macOS is not the CI browser host; this pass does not
disprove the CI failure.

Temporary diagnostics and their launcher were removed. The taxonomy spec was
verified identical to HEAD with `git diff --exit-code` before the final checks.

| Directly verified command or suite | Result |
| --- | --- |
| `pnpm --dir apps/site exec tsx --test src/components/SiteHeader.test.ts src/components/SiteHeader.taxonomy-lifecycle.test.ts` | 7 passed, 0 failed |
| `E2E_CATALOG_FORMAL=1 node scripts/run-catalog-admin-local-e2e.mjs` | Exit 0; disposable server and DB cleaned up |
| Public browser tests within formal runner | 41 passed |
| Catalog/header browser tests within formal runner | 87 passed |
| Formal catalog journey | 6 passed |
| Exact original taxonomy journey, without diagnostics | 1 passed |
| Workspace packages/apps type checks | Exit 0 |
| E2E type check | Exit 0 |
| Site test type check | Exit 0 |
| `pnpm exec biome check .` | Exit 0; 754 files checked, no fixes |

Total final browser checks: 135 passed. The repository uses Biome, not an ESLint
gate. These results were obtained directly; an earlier execution-helper summary
without corresponding logs was discarded.

Raw local logs are under `output/catalog-price-repair/`:
`taxonomy-diagnostic-20260921.log`, `taxonomy-full-formal-20260921.log`, and
`taxonomy-{typecheck,e2e-types,test-types,biome}-20260921.log`.
They are ignored evidence, not committed deliverables.

## Next Discriminating Check

Capture the same failure with in-memory event recording on the CI-matching Linux
Chromium environment, keeping the original open/scroll/full-page-screenshot/click
sequence and business assertions unchanged. Do not cancel or modify the current
deployment to do this.

The existing disposable baseline command is:

```sh
E2E_CATALOG_FORMAL=1 E2E_RECORD_ARTIFACTS=1 node scripts/run-catalog-admin-local-e2e.mjs
```

Before the journey, add a temporary init-script ring buffer, without per-event
console I/O. Around the original screenshot, collect only:

1. `focusin`/`focusout` source, related target, active-element role, and timestamp.
2. Every header-mode mutation, with old/new mode and width-fit inputs.
3. Calls to `HTMLElement.focus`, including caller stack but no account text.
4. Disclosure `open` writes and the scheduled/executed timestamps of the owning
   focus-restoration and dismissal callbacks.

Attach the buffer on failure. If a callback from an earlier focus transition
closes a newly opened menu, turn that exact ordering into a focused regression
test, prove it fails on this HEAD, and change only the owning handler. If instead
the trace proves an early test interaction before readiness, test that readiness
condition explicitly. Without either observation, retain no speculative patch.

## Final Changes and Risk

From the diagnostic work, only this investigation note is retained. The later
documentation-only status update also refreshes the tracked release record.
Production and test code are unchanged; HEAD remains `cab8a89`. There is no
mutation-test proof and no root-cause fix to claim. The original CI failure can
recur despite the 135 passing local browser checks and current successful CI;
it is not fixed or waived.