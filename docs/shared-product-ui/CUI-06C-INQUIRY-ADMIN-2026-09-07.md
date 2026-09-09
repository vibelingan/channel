# CUI-06C — Local product inquiry processing

Later user verification on 2026-09-07 found the headed preview retained a viewport
taller than its native window. The session has been repaired; see
[CUI-06D review](CUI-06D-SCROLL-AND-WORKFLOW-REVIEW-2026-09-07.md). Earlier screenshot
acceptance below did not establish physical bottom reachability. Its version-0
record observation is historical: the user subsequently saved a note-only event.

Approved by the user on 2026-09-07: implement the local buyer → admin loop,
including existing saved inquiries. This extends CUI-06B, before CUI-07 routing.

## Scope and business contract

- Product Inquiries is distinct from OEM Requests; reuse the existing Admin shell
  and authentication. Only current, active admins can read or change inquiries.
- List newest `new` inquiries first; status filter, pagination, new count, explicit
  refresh. Viewing does not change processing status.
- Detail is the immutable submitted product/SKU/quantity/contact/offer snapshot.
  Display current product availability/revision separately, including deletion.
- Status: `new → in_progress → waiting_customer → in_progress`; any open status
  can close with a reason; closed can reopen to in_progress with a reason.
  Notes are append-only; actor and server time are recorded. Closed inquiries
  must reopen before adding notes. No deletion or buyer-field editing.
- Every mutation has expected version and an operation UUID. Same operation
  retries return its accepted result without duplicating notes; conflicting
  payload reuse or stale versions fail closed. No last-writer-wins.
- Print inquiry summary / browser Save as PDF, NOT a quote, invoice or order.
  Internal notes and processing history are excluded from the printable summary.
- Notification is separate: existing records show `disabled-local`. No actual
  mail, SMTP connection, cloud database writes or production activation.
- Buyer receipt says “Inquiry saved” + reference. A separate local-mode notice
  states no email/order/payment is sent. Existing records are not removed.

## Runtime and security

The existing sample API remains loopback-only. `--enable-local-quote-admin`
requires `--enable-local-quotes`. It exposes only login, me and dedicated inquiry
actions at `/api/admin`; never generic CRUD, account registration/recovery, OEM
submission or cloud sync. Reuse the hardened admin handler for login/me, then
revalidate the current admin row inside the same file mutation lock as inquiry
reads/updates. Origin allowlist, JSON body cap, no-store and request throttling
apply before dispatch. No public inquiry reads or URLs containing buyer PII.

A local-only admin credential file (0600, ignored sample directory) is created
once with random password and signing secret. Restart preserves credentials and
all existing sample records; no general seed or guessed cloud credentials.

Frontend capability is dev + loopback sample API only. The real `/admin` route
uses its normal login gate and shell, with the sample-only inquiry navigation.
No extra router, UI kit or PDF service. React Query retains loading/error states
and clears private cached data on logout; React escapes all submitted text.

## Deferred boundaries

Production CloudBase transactional adapter, durable email outbox and approved
recipients require a separate activation phase. CUI-07 list/detail routing,
country-picker lazy loading and targeted dependency remediation remain separate
tasks; this phase must not silently claim them done.

## Implementation plan

**Goal:** allow the user to process their saved RFQ in local Admin.
**Architecture:** shared schema/policy → atomic local adapter → restricted HTTP
actions → existing authenticated Admin shell → inquiry list/detail/print.
**Tech stack:** existing Zod, Express, React, TanStack Query, native print CSS.
**Spec:** this document's approved contract above.
Execute inline (no delegation), using executing-plans and TDD.

### 1. Persistence and policy

Files: `packages/shared/src/catalog/inquiry.ts`,
`apps/local-server/src/catalog-inquiry-store.ts`, `json-adapter.ts`,
`catalog-inquiry.test.ts`.

- [x] RED: read existing v1 records with version 0, preserve snapshots; unauthorized
  actor returns FORBIDDEN; invalid transition and missing close reason fail.
- [x] Add strict input/output schemas and `processCatalogInquiry(store, actorId,
  input)` result union. Invoke only inside `withMutationLock`; persist on success.
- [x] GREEN: concurrent version-0 updates yield one success and one conflict;
  retry the accepted operation with same body yields no duplicate event. Reject
  changed payload with same operationId; survive adapter restart.

### 2. Authenticated local HTTP

Files: `catalog-inquiry-routes.ts`, `catalog-inquiry-bootstrap.ts`,
`catalog-detail-cli.ts`, `catalog-inquiry-routes.test.ts`.

- [x] RED: actual HTTP login then list/get/update; anonymous/expired/demoted/
  suspended user, forged actor, evil origin and oversized JSON denied.
- [x] Implement `registerLocalInquiryRoutes(app, db, config)` and explicit CLI
  opt-in. `me` derives identity, adapter checks current row before each operation.
- [x] GREEN: no hash/signing secret in response; generic CRUD cannot bypass the
  workflow; bootstrap twice preserves credential file and saved requests.

### 3. Admin UI and print

Files: `inquiries/*`, `DashboardShell.tsx`, buyer success i18n, existing docs.

- [x] RED: rendered inquiry snapshot escapes hostile text; print summary contains
  reference/configuration/quantity, excludes internal notes and action controls.
- [x] Add paginated query, status controls, notes and version-conflict recovery.
  List summaries omit contact details; full detail is authenticated.
- [x] GREEN: browser login → existing record → follow up → refresh → close/reopen
  on the retained acceptance fixture; user record remains unmodified. Check mobile overflow,
  print media, real PDF output and user sample visibility. No credential traces.

### 4. Verification and handoff

- [x] Run local-server full tests, shared/site tests, typechecks, site build and
  existing RFQ regressions. Review actual scoped diff for spec and security.
- [x] Update README, MIU plan and task registry with exact evidence/limitations.
  Keep current branch/worktree and unrelated pre-existing changes untouched.

## Acceptance — 2026-09-07

Working branch remains `fix/alibaba-sync-storage-wiring@60b051b`. Changes are local,
on top of the existing uncommitted CUI work. No commit, push, merge or deployment.
No changes to the parallel Excel worktree, source replay, published data or email configuration.

### Actual browser and persisted records

- Normal Admin login at `http://127.0.0.1:4328/admin` succeeded with the generated
  local-only account. No JWT export or authentication bypass.
- User inquiry `b8c567da-2ce2-4238-ba23-5e1e918291ec` is visible in the list and
  detail. Final disk read: `new`, version 0, zero events, `disabled-local`.
  Opening it does not mark it processed; no resubmission was necessary.
- Retained test inquiry `038e137e-300e-4cfa-a7fe-fd6465622943` was followed up,
  moved to waiting, closed with a reason, and reopened. It now has version 7
  and seven append-only events. Test contacts use `.test`, not a client inbox.
- The new count changed from 2 to 1; New-only filtering excludes the processed
  fixture. All-status filtering restores it. Returning restores focus to the
  selected inquiry. Reload preserves data. Pagination/filtering are additionally
  covered by multi-record store tests (the interactive sample has only two rows).
- A real request was committed by the server and its response deliberately
  aborted in the browser test. Retry created no duplicate event. Two real tabs
  then edited the same version: the stale write returned 409, displayed the
  specific conflict and disabled save. Reload latest cleared the stale draft
  and showed the accepted version. The rejected stale note is absent on disk.
- Desktop and 390px mobile detail were inspected; no horizontal overflow.
  The final fresh list/detail/back cycle produced no page or console errors.
  Deliberate failed-network/409 probes are not counted as unexpected errors.

### Findings corrected during acceptance

1. After the dependency manifest update, the dev server retained an obsolete
   optimized dependency URL (504). Restarting the exact local site process fixed it.
2. The shared Select already adds its placeholder option. Supplying a second
   empty option created duplicate keys/options; both inquiry selects now use
   only the component's placeholder contract, verified in the browser.
3. The generic API decoder only accepts the existing global error codes. New
   inquiry domain codes were therefore hidden behind a generic uncertain-result
   message even though the server correctly rejected the write. A dedicated
   strict shared inquiry envelope now covers these codes; unknown/malformed
   envelopes still fail closed. Added decoder negative tests and real HTTP
   conflict/reason/idempotency assertions, then repeated the two-tab test.

### Verification and artifacts

- Local server: 74/74 tests; site: 321/321; shared: 129/129.
- Shared/local-server typechecks and site test typecheck passed. Astro check:
  0 errors, 0 warnings, 8 pre-existing hints (including the CountryPicker
  deprecated portal prop). These hints are not claimed resolved in this phase.
- Site production build passed. The inquiry module is lazy-loaded and its
  workspace activation is DEV + loopback-only; this is not a cloud release.
- Existing shared-detail/legacy-SKU Chromium regressions: 22/22 passed, excluding
  the opt-in test that creates another inquiry in the retained sample database.
- Focused Biome checks and `git diff --check` passed. Scoped code review covered
  current-role checks, atomic writes, private projections, retry/version semantics,
  snapshot preservation and print isolation. No independent agent review was run.
- [List screenshot](../../output/playwright/cui06c-inquiry-list.png),
  [desktop detail](../../output/playwright/cui06c-inquiry-desktop.png),
  [mobile detail](../../output/playwright/cui06c-inquiry-mobile.png).
- [Actual inquiry PDF](../../output/pdf/cui06c-inquiry-summary.pdf): one A4 page,
  visually inspected after rendering. Text verification confirms the inquiry
  reference/quantity/disclaimer and excludes internal notes/history. This uses
  browser Print / Save PDF, not a PDF service or commercial quotation engine.

## Local operator entry and restart

Open [Admin](http://127.0.0.1:4328/admin). The account is `rfq-admin@channel.local`;
its password is the `password` field in the private, ignored file
`apps/local-server/data/shared-ui/ui05/local-admin.json`. Do not publish that file
or its signing secret. The automation browser is already signed in; other browser
profiles use the same normal login page with this local account.

Both services are left running. If restarting, first stop only the verified old
process for the matching port/cwd. Never reseed this directory or start a second
API writer against the same database. From `apps/local-server`:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec tsx src/catalog-detail-cli.ts --serve --directory ./data/shared-ui/ui05 --port 3013 --enable-local-quotes --enable-local-quote-admin
```

From `apps/site`:

```sh
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm exec astro dev --host 127.0.0.1 --port 4328
```

The Node option is a local Node 25 test/runtime workaround, not a cloud runtime
change or an application feature. The local sample database contains contact
data and is not encrypted at rest; use test contacts and keep it private.
Cloud persistence, actual mail delivery, approved recipients, orders, invoices
and payment remain unimplemented/unactivated by this local phase.
