# Channel Trade Platform Review Plan

## Goal

Review the two supplied 2024 proposals against the current Channel repository and current official platform capabilities, then produce a maintainable, cost-first implementation design for small-batch B2B orders, payments, order follow-up, supplier self-service, and distribution commissions.

## Deliverable

An evidence-backed decision report and phased implementation blueprint under this directory. This is a design and research task only; it does not change production code or cloud resources.

## Phases

1. **Baseline and proposal audit** — complete
   - Inventory reusable capabilities in the current repository.
   - Recalculate the supplied financial model and identify unsupported assumptions.
   - Separate trading-principal and marketplace-agent obligations.
2. **Official capability research** — in progress
   - Verify current Medusa architecture and extension requirements.
   - Verify current CloudBase relational, runtime, scheduling, and operational capabilities.
   - Verify payment-provider constraints for merchant onboarding, split settlement, refunds, and reconciliation.
3. **Target operating model and architecture** — pending
   - Define bounded contexts, data ownership, state machines, payment flows, ledgers, and integration boundaries.
   - Compare build, Medusa, and managed-service options with explicit decision criteria.
4. **Phased delivery and economics** — pending
   - Define step-by-step rollout, acceptance gates, staffing, estimates, operating costs, and KPI instrumentation.
   - Replace the false-precision ROI claim with a driver-based scenario model.
5. **Adversarial review and finalization** — pending
   - Test the recommendation against compliance, concurrency, refunds, disputes, partial fulfillment, and low-volume failure cases.
   - Publish final report with assumptions and unresolved business decisions.

## Working Decisions

- Reuse current Channel capabilities unless a replacement demonstrably removes more maintenance than it adds.
- Treat `trading` and `platform` as different legal and accounting flows, not a mutable supplier flag.
- Do not design Channel as an unlicensed holder or redistributor of supplier funds.
- Financial amounts, inventory reservations, commissions, and settlements require transactional, auditable records; generic admin CRUD is not the owning write path.
- No production build should begin until jurisdiction, seller-of-record, invoice, refund, and payment-provider contracts are confirmed.
- Design for a validation-stage business: fewer than 10 monthly orders initially, no historical GMV, USD-first cross-border B2B, and deliberately assisted supplier operations.
- Keep domestic RMB/payment-institution splitting as a separate later channel; do not let its identity, ledger, tax, or payment assumptions leak into the Hong Kong cross-border path.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| Repository memory reads requested ranges beyond the files' lengths | 1 | Use exact available ranges on the next read; no evidence was lost. |
