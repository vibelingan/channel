# Channel Trade Platform Review Findings

> **Status:** Phase 1/5 complete (baseline and proposal audit). Phases 2–5 — official
> capability research, target operating model and architecture, phased delivery and
> economics, and adversarial review — are in progress or not started. The design
> consequences below are interim conclusions from Phase 1 only and have not been through
> the adversarial review this plan calls for; treat as a working hypothesis, not a decision.

## Request Interpretation

The decision needed is not merely “Medusa or CloudBase.” It is how Channel can operate two commercial models without building payment infrastructure, duplicating the current portal, or confusing inventory ownership and settlement liability.

## Observed Repository Baseline

- The monorepo already has an Astro public site, React admin, CloudBase functions, NoSQL persistence adapters, user authentication, role support, media storage, product and overstock catalogues, inquiry submission, rate limiting, deployment scripts, and E2E coverage.
- Product and overstock rows contain prices and inventory-like fields, but the repository has no first-class order, cart/quote, payment, supplier, distributor, commission, settlement, refund, shipment, or financial-ledger domain.
- The generic registry-driven admin is appropriate for catalogue/reference CRUD. It is not sufficient as the write boundary for money movement, stock reservations, order transitions, or commission settlement.

## Supplied Proposal Audit

### Arithmetic contradictions

- The supplied monthly sequence is GMV `50, 80, 120, 200, 300, 400, 500 x 6` (ten-thousand RMB). Applying its own revenue formula gives monthly contribution revenue `4.5, 7.2, 10.8, 20, 29, 38, 42 x 6`, totaling **RMB 3.615 million**, not RMB 3.195 million.
- RMB 3.195 million comes from a different simplified model: `50 x 3`, `200 x 3`, and `500 x 6`. The two proposals silently mix these models.
- The detailed monthly GMV sequence totals RMB 41.5 million. A 0.6% payment fee is therefore RMB 249,000, not RMB 190,000.
- The stated annual ROI subtracts the RMB 220,000 investment in “net profit” and then subtracts it a second time in the ROI numerator. Even before fixing omitted costs, the formula is internally inconsistent.
- The cash-flow table allocates RMB 280,000 of annual outflow (`7 + 3 + 3 + 2 + 2 + 2 + 1.5 x 6`) while the executive summary says RMB 220,000. It also starts collecting sales while the implementation schedule says the product is still being built.

### Missing economic drivers

- “Trade profit” is gross contribution, not platform revenue or net profit. The model omits procurement cash, freight, warehousing, inspection, returns, warranty, shrinkage, tax/invoicing, FX, bad debt, and working-capital financing.
- Distributor commissions are a core promised feature but are absent from costs.
- The model omits supplier/distributor acquisition, sales, finance operations, reconciliation, compliance, customer support growth, maintenance engineering, monitoring, and incident response.
- LTV, CAC, margin, supplier count, distributor activity, and GMV growth are asserted without cohort or transaction evidence. The 87% net-margin and two-to-three-month payback claims are therefore not decision-grade.

## Initial Architecture Hypothesis

The lowest-maintenance path is likely to keep the current Channel frontend/catalogue/admin and add a narrow transactional order service plus licensed payment-provider integration. A full Medusa adoption would duplicate current catalogue, identity, admin, and deployment surfaces while still requiring custom supplier contracts, marketplace settlement, distributor commissions, and B2B quotation workflows. This remains a hypothesis pending current official capability research.

## Confirmed Operating Context (2026-08-05)

- There is no transaction history yet. The first-year launch starts below 10 orders per month and exists to validate buyer demand and the operating model, not to automate high volume.
- Diversity Innovations Limited (Hong Kong) is the main contracting, collection, and invoicing entity for overseas and most cross-border business. A Dongguan entity is an auxiliary path for domestic procurement/trades requiring a mainland VAT invoice.
- Roughly 70% of target buyers are overseas small wholesalers and 30% are mainland e-commerce sellers. USD is primary; RMB is secondary.
- Suppliers are mainly inventory-holding SMEs in Guangdong, with some in Hong Kong and Henan. Their IT capability is generally low, so supplier operations must work through assisted onboarding and simple mobile links rather than a mandatory complex portal.
- Two commercial paths are desired: supplier-direct collection for pure matching, and Channel collection with about a 3% service charge plus optional inspection, tracking, and inventory grading.
- Mainland domestic transactions are intended to use a licensed payment institution's split-settlement model and should be treated as a separate later payment channel.

## Immediate Design Consequences

- The first release should be an **assisted trade desk with a system of record**, not an open self-service marketplace. The system should remove spreadsheet ambiguity while retaining human approval at quote, stock confirmation, supplier acceptance, refund, and payout steps.
- `DIRECT_MATCH` and `CHANNEL_MANAGED` must be immutable order contract types. A supplier preference may choose the default, but it must not retroactively change who is seller, who receives funds, or who owes a refund for an accepted order.
- For `DIRECT_MATCH`, Channel records the referral and service-fee entitlement, but supplier and buyer settle directly. The system must not mark an order paid from an unverified chat message.
- For `CHANNEL_MANAGED`, the safest initial structure is for the Hong Kong company to contract as principal/reseller, collect from the buyer, contract separately to purchase from the supplier, and own the refund/fulfillment obligation. Calling the same funds flow “collection on behalf” without changing the legal contracts may create payment/remittance risk and needs Hong Kong legal/payment-provider confirmation.
- “No invoice” must be split into tax and trade documents. Not issuing a mainland VAT invoice does not remove the need for a commercial invoice, pro forma invoice, packing list, payment evidence, and other customs/shipping records in a cross-border B2B sale.
- A flat 3% managed-service charge is not yet proven viable. It must cover or separately pass through acquiring fees, FX spread, chargebacks, refunds, inspection labor, support, and financing time; card acceptance may itself consume most or all of 3%.
- With fewer than 10 monthly orders, supplier payout should begin as a dual-approved bank-transfer workflow exported from an immutable payable ledger. Automated payouts and supplier self-service become earned complexity only after volume and exception rates justify them.

## Provenance Labels

- Repository statements above are observed from current source files.
- Financial corrections are derived directly from the formulas and monthly values in the supplied documents.
- Operating-context statements are reported by the project owner on 2026-08-05.
- Legal/payment risk statements are preliminary architecture constraints, pending jurisdiction-specific counsel and payment-provider confirmation.
