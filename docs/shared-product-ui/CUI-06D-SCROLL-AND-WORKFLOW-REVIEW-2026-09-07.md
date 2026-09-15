# CUI-06D — Native preview scroll repair and inquiry workflow review

Status: browser-session repair verified; workflow extension and CloudBase RFQ
implementation are proposed, not implemented or deployed by this review.
Branch remains `fix/alibaba-sync-storage-wiring@60b051b`. Existing uncommitted
CUI implementation and user records are preserved.

## Scroll incident: cause and verified repair

The headed `cui06c` preview retained a fixed Playwright viewport of 1440 × 1100
after the earlier responsive tests. The actual native browser window was only
1459 × 930, including its chrome. The browser therefore considered content below
the physically visible window to be visible already. At its emulated bottom,
scrollY was 230 and the last price row ended at y=1022. A whole-page screenshot
and a no-horizontal-overflow assertion had not tested physical reachability.

Inspection found no height clipping in the inquiry summary's ancestors. No
application CSS workaround or blank spacer was added. Clearing metrics on a
separate CDP session did not remove the original override. Explicit zero width,
height and deviceScaleFactor in `Emulation.setDeviceMetricsOverride` restored
native metrics. A Playwright screenshot can subsequently restore its remembered
viewport, so the final screenshot used the measured native size and the native
override was restored again after capture.

Final observed browser dimensions: inner 1459 × 843, outer 1459 × 930; document
height 1330; wheel scrolling reaches scrollY=487. The last visible price row
(`1000+ / USD 3.80`) ends at y=765, inside the real 843px content area. No
horizontal overflow. The actual-viewport image was visually inspected:
[bottom reached](../../output/playwright/cui06d-actual-viewport-bottom.png).

For future human handoff, launch a dedicated headed preview with
`browser.contextOptions.viewport: null`. Keep fixed responsive sizes in a
separate test session. Check the bottom by wheel/keyboard in the actual window,
and recheck metrics after screenshots; do not claim a full-page capture alone
proves scroll reachability. The repaired session remains open on the inquiry.
No services were restarted, no authentication was bypassed and no inquiry was
changed by this repair.

## What is real today

Observed code path: inquiry UI → POST `http://127.0.0.1:3013/api/admin` → restricted
authenticated local router → `JsonFileAdapter.manageCatalogInquiry` → serialized
mutation lock and persisted `db.json`. Zod validates input/output. Current-admin
checks, legal transitions, reasons, expected version and operation-id retry
semantics are implemented on the server, not merely in React.

The user's retained inquiry `b8c567da-2ce2-4238-ba23-5e1e918291ec` now has version
1 and one note-only event, still `new`. The user added the note after CUI-06C's
earlier version-0 acceptance; that historical record must not be read as current.
Opening or adding a note does not count as processing. Note wording is never
interpreted as a workflow instruction.

Current schema: `new | in_progress | waiting_customer | closed`. There is no
distinct `completed` state. New records already have a blue text badge and new
count; the requested stronger attention styling is still pending. The UI
transport is explicitly DEV + loopback-only. The deployed admin/public-api
handlers and CloudBase adapter have not gained this RFQ submission/management
path. Local persistence must not be represented as a deployed cloud function.

Re-ran the two local inquiry suites: **6/6 passed**, including real HTTP
login/authorization, read-without-processing, transitions, persistence/restart,
concurrent-version rejection and idempotent retries. No full build or cloud
acceptance was run for this browser-only repair.

## Proposed next boundary for user confirmation

This is a contract/backend extension, not a status-color-only UI change.

- Keep `new` until an admin explicitly starts processing. Use amber “Unprocessed”
  text and badge in list/detail/navigation; viewing and note-only saves do not
  clear it. Use blue for processing, a separate waiting label, green for completed
  and neutral styling for closed. Text accompanies color everywhere.
- Add `completed` separately from `closed`; do not migrate old closed records
  into completed. A processed inquiry can complete with an outcome note. Closing
  without completion and reopening also require a reason. Record actor, server
  time, previous/next status and version. Completion means the inquiry follow-up
  is finished, not an order/payment/invoice/fulfillment assertion.
- Extract the reusable server-side inquiry policy from the local adapter and
  expose dedicated database ports. Keep local and CloudBase behind one schema
  and policy. Reuse the existing public-api/admin entrypoints and auth; no new
  generic CRUD access to buyer contact data and no repurposed OEM action.
- Cloud submission revalidates approved product/revision/SKU and creates an
  immutable server snapshot. Cloud follow-up atomically checks the current admin,
  expected version and operation id with the status/audit write. Paginated
  list/detail and new counts come from persisted state, not browser storage.
  Set explicit payload/history budgets and verify CloudBase transaction and
  index contracts before implementation; do not copy an unbounded local array
  into a growing cloud document.
- Verify contract/policy negatives locally, then use a small synthetic inquiry
  in the **test** environment to check buyer submission → DB readback → admin
  processing/completion → reload/second-session readback, including stale writes,
  response-loss retries and denied anonymous/non-admin reads. Do not copy the
  user's local contact data to the cloud for this test.
- Actual email, recipients, commercial quotations, invoices, orders and payments
  stay outside this activation. Email status must remain explicitly disabled,
  not pretend a notification was sent. No production deployment is implied.

After this boundary is confirmed and implemented, resume CUI-07 list/detail
navigation and CUI-08 full journey checks. The current document records a proposal
and incident evidence; it is not deployment authorization or completion evidence.
