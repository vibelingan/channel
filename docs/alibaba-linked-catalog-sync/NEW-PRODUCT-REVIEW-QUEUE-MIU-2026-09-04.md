# Alibaba New Product Review Queue MIU — 2026-09-04

## Outcome

An admin-triggered Alibaba incremental sync may create unpublished Channel
products. Those first-seen products must be immediately visible as a review
queue: pending items sort first, product-family tabs show a notification dot,
and each pending row carries a `New` badge. Publishing or an explicit
`Mark reviewed` action consumes the notification once.

## Actor, value, and boundary

- **Actor:** an authenticated user whose current `users` row has role `admin`.
- **Value:** the admin can see which newly synced products still require
  curation without confusing later supplier price/stock refreshes with new
  catalog entries.
- **External boundary:** Alibaba ICBU TOP remains the source of observations;
  sync never publishes a Channel product.
- **Storage boundary:** `products` is the canonical admin-visible draft. Raw
  provider evidence and source observations remain separate and private.
- **Security boundary:** `runNow`, review summary, and review acknowledgement
  revalidate the live user row and reject non-admin roles. The browser cannot
  forge server-owned review fields through generic CRUD.

## State contract

`products.alibabaReviewPending` is a concrete server-owned boolean.

- `true`: this Alibaba-linked product was first materialized and has not been
  acknowledged by an admin.
- `false`: the product has been reviewed, either explicitly or by publishing.
- missing: legacy compatibility only. Existing Alibaba drafts are backfilled to
  `true`; ordinary non-Alibaba products do not enter this queue.

`products.alibabaReviewedAt` and `products.alibabaReviewedByUserId` record the
acknowledgement. A later incremental refresh preserves `false`; it must never
resurrect a reviewed product as New. Unlinking clears the Alibaba review state.

## UI contract

- The All products tab shows a dot when the total pending count is non-zero.
- A mapped family tab shows a dot when that family has pending products.
- Unmapped pending products contribute to All products only.
- Pending rows sort before non-pending rows on entry; user-selected column
  sorting remains secondary.
- The thumbnail's top-left corner shows `New` for pending rows.
- The preview offers `Mark reviewed`; publishing also acknowledges review.
- Mobile family options include a concise pending marker because the desktop
  dot is not visible inside the collapsed selector.

## Data flow

1. Admin clicks **Run now**. The Alibaba function revalidates the live admin
   role and starts/resumes the bounded incremental run.
2. A first-seen source product materializes an unpublished product with
   `alibabaReviewPending: true`.
3. Existing linked products retain their current review state. The catch-up
   materializer sets `true` only when the field is absent, enabling an
   idempotent one-time backfill without reopening reviewed products.
4. The Products view reads an admin-only review summary and lists products with
   pending-first ordering.
5. `Mark reviewed`, or a transition to `published: true`, atomically writes
   `alibabaReviewPending: false` plus reviewer/time metadata.

## Failure and rollback behavior

- A failed sync creates no false notification merely because a run started.
- A failed acknowledgement leaves the item pending and displays the API error.
- Review summary failure never hides the product list; it omits dots and keeps
  the queue rows available.
- Deployment can be rolled back without losing products or raw evidence. The
  additive review fields and indexes are safe to leave in place.

## Acceptance checks

1. Contributor and stale/demoted sessions cannot invoke manual sync or review
   actions.
2. New drafts are unpublished and pending; retries preserve reviewed state.
3. Pending-first order works for All and for a selected product family.
4. Family summary totals match persisted pending products.
5. Desktop and mobile controls expose pending state accessibly; rows show New.
6. Publishing consumes pending state but never happens during sync.
7. Production-like CloudBase indexes exist before enabling the UI query.
8. Browser verification confirms real data, notification dots, New badges, and
   no public publication side effect.
