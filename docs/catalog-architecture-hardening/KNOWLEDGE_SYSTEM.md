# Catalog Knowledge Integration

## Decision

Do not create a parallel `docs/knowledge/catalog` tree or a new knowledge validator. Reusable rules
belong in the existing `docs/ENGINEERING_CRAFT.md` trigger index/catalog; incident-specific evidence
stays in `docs/catalog-category-expansion/EXECUTION.md`, the existing incident/execution index that
observed it. Architecture and execution docs
link to those authorities rather than restating them as another canonical catalog.

## Existing Authorities

| Knowledge | Canonical owner | Planned integration |
|---|---|---|
| Optional fields never gate historical rows | `docs/ENGINEERING_CRAFT.md` -> Historical Data Compatibility | extend trigger index to Catalog normalizer/schema/card/detail files |
| Oldest production shape belongs in fixtures | `docs/ENGINEERING_CRAFT.md` -> Historical Data Compatibility | link typed fixture and parity assertions |
| Provider identity owns fallback | `docs/ENGINEERING_CRAFT.md` + `docs/catalog-category-expansion/EXECUTION.md` | add one pricing rule/evidence index entry after implementation |
| Module guards must prove behavior | `docs/ENGINEERING_CRAFT.md` -> Test & Probe Efficacy | reference MIU 01 graph/reservation/duplicate mutations and MIU 29 retirement extension |
| Targeted hosting prune + 404 | `docs/ENGINEERING_CRAFT.md` and `docs/CICD_PRODUCTION_PLAN.md` | retain `/headphones` 200, separate `/overstock` and `/overstock-item` 404s, and existing hidden/media evidence |
| Remote/pushed completion | `docs/ENGINEERING_CRAFT.md` -> Review Process & Knowledge | link manifest-approved implementation/rollback commits, separate runtime observations, and external closure equality |

## Incident Integration

The historical catalog visibility incident is already represented by the Historical Data
Compatibility rules and their teaching commits (`65ba453`, `25d06f6`, `2dcce50`, `3851c18`). The
implementation does not invent a second incident file. It amends those existing entries only when new
verified evidence adds a distinct reusable rule, such as Alibaba link ownership or module-graph
enforcement. This refactor's `EXECUTION.md` carries per-MIU evidence and links the amended authorities.

MIU 37 may modify only `docs/ENGINEERING_CRAFT.md`, `docs/catalog-category-expansion/EXECUTION.md`,
and this index. The executable duplicate-governance assertion belongs exclusively to MIU 01's
`scripts/verify-catalog-architecture.mjs` and test; knowledge documents do not become a verifier.

## Promotion Gate

A rule is added or changed only after its reproducer fails before the fix and passes after it. The
entry names user-visible impact, why prior tests missed it, exact assertion, fixing/reviewed SHA, and
the files that trigger future readers. Planning prose is not promoted as verified knowledge.

## Consistency Check

The architecture/change-impact guard verifies that packet links target existing authorities and that
no new Catalog rule catalog or duplicate active rule is introduced. Fresh-clone handoff requires only
tracked docs and Git; local agent state is never a knowledge source.

Deployment approval names independently reviewed/pushed implementation and rollback SHAs in the immutable
manifest. Runtime evidence separately records deployed and rollback release IDs and compares each with its
corresponding checked-out commit under the `CHANNEL_BUILD_SHA`/`GITHUB_SHA` contract. The later docs-only closure commit records that evidence,
is not claimed as deployed, and does not embed its own SHA. Registry/tool output after push supplies the
closure local/remote equality proof; a branch/PR status field may separately resolve to `HEAD`.
