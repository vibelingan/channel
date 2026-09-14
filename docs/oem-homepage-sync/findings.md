# Evidence Notes

## Current Content Ownership

- Homepage copy: `apps/site/src/i18n/content/en-US.md`
- Homepage composition: `apps/site/src/pages/index.astro`
- OEM copy: `apps/site/src/i18n/content/oem/en-US.md`
- OEM composition: `apps/site/src/pages/oem.astro`

## Observed Version Relationship

- The OEM page core was introduced in early commit `99c0356` as a conventional one-stop OEM page.
- The homepage later received multiple content revisions covering the AI-assisted workflow, factory/team positioning, quality assurance, certifications, and global reach.
- Commit `c1fdc1c` introduced the shared Traditional-versus-AI workflow.
- The current OEM page already renders that shared homepage workflow through `ServiceGridSection`; this section is synchronized today.
- Commit `fb9b5a3` normalized two OEM claims: experience changed from `15+` to `20+`, and enquiry response changed from one business day to 24 hours. It did not synchronize the rest of the OEM page.

## Material Differences

1. The homepage positions the company as an AI-powered product-development and supply-chain partner. The OEM page hero and its remaining sections use a conventional one-stop-manufacturer narrative.
2. The homepage documents a detailed 10-step development flow. The OEM page separately describes a generic 6-step flow.
3. Homepage evidence is `20+` years, `40+` engineers, `5000+ m²`, and `40+` countries. The OEM page instead claims `100+` supply-chain partners and Flexible MOQ; those claims are not supported by the active homepage content.
4. The homepage contains dedicated people/global-trade, Pre-QC/final-inspection, and certifications/client sections. The OEM page omits these newer proof points.
5. The OEM page retains six broad product-family claims. The active homepage no longer presents those families as its capability model, so their current strategic and factual status is unclear.
6. Both pages promise a 24-hour response, but with different scope: the homepage promises an "OEM solution" within 24 hours, while the OEM form promises that the team will "get back to you" within 24 hours.
7. The OEM process says inspection follows agreed AQL standards. The homepage does not make that specific contractual/process claim.

## Prior Source-Material Boundary

The earlier OEM material review identified the homepage PPTX as the newer homepage direction and documented its sequence: hero, services, 10-step process, factory/team, product capability, reasons to choose the company, certifications/clients, and CTA. The current homepage has since evolved further into an AI-assisted version of that structure. This supports using the homepage as the current narrative baseline, but it does not independently prove every quantitative or operational claim.

## Implementation Constraints Discovered

- `/oem#submit` is consumed by the Portfolio primary CTA, OEM upload E2E, mutation E2E, and public form E2E. It must remain valid.
- `/oem#process` is consumed by Portfolio. It must remain valid.
- `FactorySection` currently hardcodes homepage media, while the OEM page has a distinct video/poster pair with intrinsic poster dimensions. Reuse requires an optional media override that carries source, poster, width, height, caption/label, and unchanged homepage defaults.
- `CTASection` currently hardcodes `id="oem-inquiry"`. Reuse on `/oem` requires an optional section ID with `oem-inquiry` as the unchanged default.
- `OemProcessSection` has no section ID or fixed-header scroll margin. Reuse on `/oem` requires both so `#process` resolves below the header.
- Existing reveal E2E tests target the legacy `#capabilities` section. They must be retargeted to a retained below-fold shared section, not deleted.
- `IconCard`, `WorkflowStep`, `ProcessStep`, and `Reason` remain imported by preserved legacy components; remove old `OemContent` fields but retain these exported interfaces in this task.
- The inquiry form category options are operational routing taxonomy. Removing the old six-family marketing section does not authorize changing those form values.

## UI Verdict

`DESIGN_NOT_REQUIRED`: the homepage already defines the target UI. The work is existing-pattern composition. Responsive checks are still required for 390, 768, 1024, and 1440 px, especially workflow cards, the ten-step process, factory gallery, Why Choose Us visuals, certification wall, and file input.