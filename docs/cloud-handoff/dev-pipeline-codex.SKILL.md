---
name: dev-pipeline
description: Use the pinned orocsy/dev-pipeline full development workflow as guidance for feature work, validation, review and delivery in Codex. Read requirements and project rules first, then adapt the upstream phases to the authorized scope.
---

# dev-pipeline in Codex

This entry is a project-maintained adapter. The remaining files in this installed
directory are the pinned upstream Claude Code plugin. Installation does not
register Claude slash commands, agents, hooks, launchd jobs or global settings.
Read the upstream instructions directly; do not claim those integrations ran.

Start with `CLAUDE.md`, `CHANGELOG.md` and `commands/dev-pipeline.md` in this
directory. Use the full pipeline as a checklist: requirements, repository and
skill discovery, design when needed, architecture, small implementation steps,
test plan, TDD, validation, review, authorized delivery and handoff.

The user's instructions and the consumer repository's AGENTS.md take precedence.
Reuse already approved requirements and architecture. Do not repeat approvals
already covered by the session, create branches/PRs, delegate, merge, deploy or
write external resources unless the current task permits it. In Channel's SEO
workstream, stay on `feat/seo-foundation`, work directly without sub-agents and
keep local verification separate from cloud acceptance.

Use the relevant upstream commands as readable procedures:

- `commands/validate.md`: project lint, types, tests and actual runtime builds.
- `commands/verify-contract.md`: client/server payloads when both change.
- `commands/verify-sdk-surface.md`: installed third-party APIs and official docs.
- `commands/verify-blast-radius.md`: dependent modules and sibling paths.
- `commands/verify-visual.md`: screenshots when the UI changes.
- `commands/verify-traceability.md`: each scoped requirement has evidence.
- `commands/review.md`: security, concurrency, boundaries and open findings.

Read the installed `engineering-craft/INDEX.md` and matching categories before
review. Inspect `tools/run-craft-gates.sh` before running it; run from the consumer
repository, with explicit changed-file paths including uncommitted/new files.
Record scanner limitations, baseline findings and false positives honestly.
Do not weaken working project guards to satisfy a generic scanner.

Keep a tracked plan and worklog in the feature's existing docs directory instead
of creating a second parallel set of requirements. Record applicable phases,
evidence, justified N/A items, unperformed actions and the next step. A local pass
does not establish production readiness. Preserve upstream notices; do not
commit the installed plugin snapshot into the consumer repository.
