# CUI-06D Implementation Plan

Use executing-plans, solo in the existing worktree; no delegation or new branch.

**Goal:** explicit unprocessed/processing/completed inquiry states backed by the
same business policy locally and in CloudBase.
**Current status:** local workflow accepted; cloud code deployed behind OFF gates.
Authenticated live RFQ persistence/processing acceptance is still pending. See
[rollout and incident evidence](CUI-06D-ACCEPTANCE-AND-ROLLOUT-2026-09-07.md).
**Latest user override:** no more direct deployments or cloud test writes. First
finish and verify the local release unit, commit/review it on the current branch,
pass CI, then integrate `test` and release code/resources/config/frontend through
CI/CD. The earlier proposal to separately publish the Admin entry is on hold.
**Architecture:** shared Zod DTO → server policy → transactional adapter → existing
admin/public-api functions → existing Admin shell. No OEM reuse or email dispatch.
**Tech stack:** existing TypeScript, Zod, React Query, CloudBase node-sdk 3.17.2.
**Spec:** CUI-06D-SCROLL-AND-WORKFLOW-REVIEW-2026-09-07.md, confirmed by user “可以”.

## D1 — Explicit completion and attention

Current `nextInquiryStatuses('in_progress')` permits waiting/closed only. Add
completed without rewriting historical closed records. Runtime state owns the
attention badge: `status === 'new'`, never view count or presence of a note.
Completed/closed are terminal; both require a reason and explicit reasoned reopen.
Keep existing tokens/layout/typeface; amber attention, blue progress, green
completion, neutral closed, with text labels (not color-only semantics).

- [x] RED local inquiry test: note-only save retains newCount; completion fails
  until processing starts; terminal writes need reason; retries do not duplicate.
- [x] GREEN schema, local policy and tests; extract server policy into db package.
- [x] Render shared status badge in list/detail, extend selector/filter/navigation.
- [x] Browser test using retained test fixture, preserve user's inquiry.

## D2 — Atomic server policy and CloudBase storage

Current `JsonFileAdapter.submitCatalogQuote` is file-lock only and requires a
local clone. Extract snapshot validation and inquiry processing; storage adapters
own freshness/locking, not a second business policy. Cloud transactions read
current user/record/product and write the new record in one commit.

Ports: `submitCatalogQuote(input)` and `manageCatalogInquiry(actorId,input)`.
Private collection `catalogQuoteRequests`; no generic CRUD registry exposure.
Index attention rank + createdAt + _id, and status + createdAt + _id. Public
submission has a durable global rate cap and bounded payload; no contact logs.
Keep operation ids/fingerprints server-private. Reject oversized snapshots/history
without dropping previous evidence; no unbounded cloud document growth.

- [x] RED cloud-adapter tests: authoritative snapshot, absent/mismatched SKU,
  unpublished/revision change, no forged actor, idempotency and version conflicts.
- [x] Share policy; implement node-sdk transaction callbacks and bounded paged reads.
- [x] Provision private collections/indexes through MCP before dependent UI wiring.
- [x] Verify installed SDK `get()` array shape, direct `set(data)` and callback
  return-after-commit; test rollback/failure before claiming persistence.

## D3 — Real function and UI boundaries

Current local `inquiryRequest` denies non-loopback; production admin switch has
no inquiry case. Extend the existing authenticated choke point, with an explicit
RFQ capability gate. Preserve all other auth and menu behavior. Route public
POST `/api/catalog-quote-requests` with strict origins, byte limit, JSON/schema
validation, no-store, and durable anti-abuse checks. Reject arbitrary GET/CRUD.

- [x] RED real HTTP/function tests: disabled gate, anonymous/non-admin denied,
  revoked user, malformed/oversized body, domain conflict response, no private leak.
- [x] Delegate local and cloud transports to common handlers; expose capability.
- [x] Enable UI from explicit capability, not hostname or a fabricated success.
- [x] Typecheck/test packages, cold-start packaged functions, inspect scoped diff.

## D4 — Gated cloud rollout and independent evidence

Canonical test target verified against SETUP.md and live MCP:
`diversity-123-d9grnqfux221323bb`, Shanghai. The GitHub environment name `test` is
not its CloudBase alias. **This is the same environment serving supplychainsai.com,
not an isolated staging environment.** User explicitly permitted updating the two
existing functions only after testing and protecting existing functionality.
No other function, static frontend, gateway, importer, sync or mail was deployed.
Approved detail snapshots were absent at preflight; no existing product may be
published just to manufacture a successful test, and local user contacts must
not be copied to the cloud. Keep mail off.

- [x] Package/release identity and target verified; update existing functions only,
  preserve environment variables and runtime, never delete/recreate on ambiguity.
- [ ] Test submit → persisted snapshot → admin transition → complete → second
  session/reload; test stale save and same-operation retry; verify DB independently.
- [x] Record exact deployed artifact identity, retained synthetic references,
  checks and any remaining activation gap; update README/DESIGN/registry together.

The first rollout failed on an undeclared `productVariants` dependency and was
rolled back immediately. The corrected rollout provisioned the empty private
collection, added a packaged SDK behavioral smoke and negative control, and passed
seven byte-identical old public route comparisons. Both RFQ flags remain `0`.
The offline SDK test proves the package/query path, not live RFQ persistence.

## Contract evidence

Context7 is unavailable. CloudBase MCP search found the transaction docs but its
readDoc returned 404 HTML; used the official node-sdk repository docs instead:
https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md
and installed `@cloudbase/database@1.4.3/dist/commonjs/transaction/index.js`.
The installed callback result is returned after `await transaction.commit()`;
callbacks may replay on conflict. Generate stable ids outside callbacks and do
not send mail or mutate external state inside them.
