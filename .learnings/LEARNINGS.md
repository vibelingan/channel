# Learnings

## [LRN-20260721-001] correction

**Logged**: 2026-07-21T00:00:00Z
**Priority**: high
**Status**: resolved
**Area**: docs

### Summary
Inspect user-supplied working artifacts before treating a spoken technical product name as unresolved.

### Details
The stakeholder screenshot used the Chinese phonetic name “爱马仕” for Nous Research Hermes Agent. Research over-focused on disambiguating the word and failed to identify the public project, even though the user had a working local package showing `Hermes Gateway /v1/chat/completions → DeepSeek + Tencent Lexiang MCP`. This also led to understating floating AI customer service, which remains a first-class PRD requirement despite being deferred from one earlier page-revision batch.

### Suggested Action
When terminology is ambiguous, search exact English/homophone candidates and inspect any local prototype, configuration, logs, or source package first. Distinguish “deferred from the current implementation batch” from “removed from product scope.” Re-derive architecture from the working artifact before proposing alternatives.

### Metadata
- Source: user_feedback
- Related Files: /Users/SeanCai/Downloads/ai-floating-widget/SKILL.md, /Users/SeanCai/Downloads/ai-floating-widget/widget.js, docs/AI_PLATFORM_DESIGN.md
- Tags: hermes-agent, terminology, artifact-first, scope

### Resolution
- **Resolved**: 2026-07-21
- **Notes**: Inspected every supplied file, verified the public Hermes Agent project and official API/MCP documentation, corrected the research record, and promoted Hermes + Lexiang + REST as a concrete architecture option.

---
