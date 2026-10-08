# A reusable AI chat platform — vision and architecture notes

**Status:** discussion draft, 2026-10-09. No implementation. Research facts are
labelled **reported** with their source; recommendations are ours.
**Related:** [TECH-REVIEW.md](./TECH-REVIEW.md) (Stage X) ·
[PLAN.md](./PLAN.md) (the Channel sales agent) ·
[MEETING-PREP-2026-10-10.md](./MEETING-PREP-2026-10-10.md)

## 1. The idea, in plain terms

Build the Channel sales agent so that two things come out of it instead of one:

1. **The expression layer** — a chat surface we own: a web component plus a
   small client and server SDK that can render what any AI backend sends
   (text, Markdown, media, product cards, comparisons, approvals, forms, status)
   and can be dropped into any JavaScript web stack and styled to a client in
   hours.
2. **Agent backends** that speak one protocol to that surface. The first is the
   Channel sales agent. A plain knowledge-base assistant, a support agent or a
   LangGraph pipeline would plug into the same surface.

Around them, a **learning loop**: a monitoring agent reads what the product does
in production, writes down what worked and what failed, and the team turns that
into two tiers of skills — a detailed internal blueprint, and a lighter field
guide that can be sold. The product itself stays ours; the service is building
the serious version for clients who want more than the field guide gives them.

The rule that keeps this honest: **the surface and the brain are decoupled by a
written protocol.** The chat does not know it is talking to a sales agent. The
sales agent does not know it is being drawn in a widget rather than an email
inbox. The protocol is the product boundary.

## 2. The protocol: adopt, then profile — do not invent

The industry has converged on this exact split in the last twelve months, and
the pieces are now versioned:

| Protocol | What it is | Status (reported) | Fit for us |
|---|---|---|---|
| **AG-UI** | An event stream between an agent backend and a front end: run lifecycle, streamed text, tool calls, shared state (snapshot + JSON Patch deltas), activities, custom events; bidirectional; transport-agnostic (SSE, WebSocket, HTTP streaming) | 1.0 announced 30 Sep 2026 with a JSON Schema and generated TypeScript/Python/.NET SDKs; adopters named include Google, Microsoft, Amazon, Oracle; supported by LangChain, Mastra and others ([CopilotKit](https://www.copilotkit.ai/blog/ag-ui-1.0), [docs](https://docs.ag-ui.com/concepts/events)) | **The wire protocol.** Our BFF emits AG-UI events; any backend that emits them works with our surface |
| **A2UI** | Declarative UI payloads from an agent: JSON components bound to a data model, rendered by the client from a trusted component catalog; no HTML or JS from the agent | v0.9.1 current, v1.0 candidate; renderers for React, Lit, Angular, Flutter, SwiftUI, Compose; rides over AG-UI, A2A, SSE or WebSocket ([a2ui.org](https://a2ui.org/introduction/what-is-a2ui/), [Google](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)) | **The model for rich blocks.** Pre-1.0, so we start with our own typed blocks shaped to map onto it |
| **MCP Apps** | Interactive HTML UIs served by MCP servers and rendered in sandboxed iframes inside MCP hosts (Claude, ChatGPT, VS Code, Goose) | Stable extension since 26 Jan 2026 (SEP-1865, `io.modelcontextprotocol/ui`) ([spec](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)) | **A later distribution channel**, not our surface: it is how the sales agent could appear inside ChatGPT or Claude |
| **AI SDK UI message stream** | Vercel's stream format behind `useChat`: text, reasoning, sources, tool parts, data parts | Current in AI SDK 6 ([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)) | Excellent inside an AI SDK app; vendor-specific. We keep AI SDK Core for generation and emit AG-UI from it |

**Recommendation.** Our protocol is "AG-UI 1.0 + a block catalog + house
rules":

- **Transport:** SSE over HTTPS first (what the BFF already does); WebSocket
  later if needed. Resume by replaying `MessagesSnapshot` from our durable log.
- **Core events:** AG-UI as published. Pin the 1.0 schema version; conformance
  tests in CI.
- **Rich blocks:** AG-UI `Custom` events carrying blocks from a **versioned
  catalog** we publish as JSON Schema (`product_cards`, `comparison`,
  `quote_draft`, `suggestions`, `status`, `citation`, `approval_request`,
  `form_prefill`). Each block is designed to map one-to-one onto an A2UI
  component so we can switch to A2UI surfaces when it reaches 1.0.
- **Actions back to the agent:** AG-UI is bidirectional; "buyer clicked Add to
  list" or "salesperson approved draft" travel as messages with typed payloads.
  Approvals use AG-UI 1.0 interrupts.
- **State:** session facts as `StateSnapshot`/`StateDelta`; nothing private.
- **Capability manifest:** a backend declares which blocks and actions it
  supports; the surface enables features from the manifest instead of guessing.
- **House rules** (our spec on top of the protocol): every block carries
  provenance (source ids), every number in a block comes from data the backend
  can cite, no block outside the catalog is rendered, and no action is
  executed without a human click where the manifest marks it as `confirm`.

## 3. The UI library question: assistant-ui or AI Elements

Both came up in the technical review. They are different kinds of thing.

| | **assistant-ui** | **AI Elements** |
|---|---|---|
| What it is | A React library: unstyled composable primitives (Thread, Message, Composer, ThreadList, ActionBar…) **plus a runtime layer** that owns streaming, threads, branching, attachments, tool calls | A **component set** built on shadcn/ui, copied into your repo through the shadcn registry; 48 components across chatbot, code, voice and workflow |
| Backends | AI SDK, LangGraph/LangChain, **AG-UI**, A2A, Google ADK, custom data-stream, any custom HTTP backend (reported: project README) | Deep integration with the AI SDK; the docs list Next.js, shadcn/ui and Tailwind (CSS-variables mode) as prerequisites |
| Styling | You style the primitives; the CLI can copy in a shadcn-based starter theme (Base UI or Radix flavour) | Styled shadcn components you then edit |
| Rich UI | Generative UI: tool calls and JSON rendered as React components; inline human approvals; frontend actions exposed to the model | Tool, Reasoning, Sources, Suggestion, Confirmation, Plan, Task, Inline Citation and more |
| License | MIT; optional paid Assistant Cloud for hosted persistence and analytics (reported) | Not visible on the pages read; roundups disagree (MIT vs Apache-2.0) — check the LICENSE file before adopting |
| Community | ~12.4k GitHub stars (reported) | smaller; backed by Vercel |
| Best when | the surface must outlive one backend and one framework; you need threads, branching, approvals, and a runtime you can point at a custom protocol | you are inside a Next.js + AI SDK app and want polished components with the least glue |

**Decision for the platform:** build the expression layer on **assistant-ui
primitives**, driven by its AG-UI runtime (or a custom runtime over our
transport). It gives us the runtime abstraction the protocol boundary needs,
and MIT without a required cloud. **AI Elements** stays useful as a visual
reference and as copy-in code for specific components if its license allows;
for a one-off Next.js + AI SDK job it would still be the fastest choice.

This revises Stage X in TECH-REVIEW.md: spike X0 evaluates assistant-ui +
AG-UI first, and the X3 BFF emits AG-UI events rather than the AI SDK UI
message stream.

## 4. Modules

```text
packages/
  chat-protocol/     JSON schemas: AG-UI profile, block catalog, capability
                     manifest, action payloads; TS types; validators; fixtures;
                     conformance tests both sides must pass
  chat-ui/           React: Thread, Composer, launcher/drawer, block renderer
                     registry (plugin per block type), action handlers,
                     theming tokens, a11y, i18n; usable in Astro, Next,
                     Remix, Vite
  chat-client/       transport (SSE/WS), resume, auth hook, analytics hook
  chat-server/       Node: emit AG-UI from AI SDK streams; durable-log adapter
                     (PostgreSQL); per-sentence guard middleware; rate and
                     budget middleware; OpenTelemetry tracing
backends/
  sales-agent/       the Channel brain (tools, policy, catalog index)
  kb-assistant/      plain retrieval assistant (what Phase 1 is today)
surfaces/
  web-widget/        the website chat (chat-ui + chat-client)
  inbox/             the sales email review surface — same protocol,
                     different renderer; the proof that the split is real
ops/
  tracing (Langfuse), evals (promptfoo), the learning loop
```

The email inbox surface matters beyond the client: if the inbox can render the
same `quote_draft`, `citation` and `approval_request` blocks the widget
renders, the decoupling is demonstrated, not claimed.

## 5. The learning loop and the two tiers of skills

**Monitoring agent.** A scheduled sub-agent reads production traces (refusals,
down-votes, latency outliers, tool failures, injection attempts, unanswered
topics), writes a learnings journal entry with evidence (trace ids, counts),
and proposes changes: prompt, catalog, policy, tests. A person approves. This
reuses the engineering-craft journal and consolidation flow already in use.

**Tier 1 — Blueprint (internal).** Near-product: the protocol schemas, module
layout, decision log, the full test suites, the pitfalls with their evidence,
the deployment shape. With it an agent can rebuild the product, slower than
using the product.

**Tier 2 — Field guide (sellable).** Principles and a minimal reference
architecture: the decoupling rule, the protocol choice and why, the safety
rules (facts from data, human gate, public-only knowledge), checklists for
evaluation and launch. Enough to build something that works; not the
battle-tested details. Clients who want the serious version hire us.

**Governance.** A written rule for what moves from Tier 1 to Tier 2, a review
before anything is sold, and client data, prompts and catalog never in either
tier.

## 6. How this changes the Channel plan

- Stage X spike X0: assistant-ui + AG-UI first; AI Elements fallback.
- Stage X X3: the BFF emits AG-UI events; blocks catalog v1 covers the Phase 2
  blocks.
- New **Stage E — email consultation** after C: mailbox connection,
  classification, drafts with evidence and placeholders, approval surface,
  follow-ups. Same backend, second surface.
- Extraction policy: packages are **extracted from the client build** once two
  surfaces (widget, inbox) use them; we do not pre-build a platform and then
  look for a client.

## 7. Email consultation: what exists and what to copy

Reported: the human-in-the-loop pattern (draft → person reviews → send, with
pricing and commitments always reviewed) is common in open-source email agents
such as [AgentSDR](https://github.com/Kandid-ai/AgentSDR) (AGPL-3.0),
[Draftly](https://github.com/almightyzeus/draftly-gmail) (MIT; drafts move
PENDING → APPROVED → SENT and become Gmail drafts),
[approveandsend](https://github.com/terryops/approveandsend) (MIT; learns from
edits) and [ai-reply-drafter](https://github.com/autonexuslabs/ai-reply-drafter)
(safety checks in code). Vendor products (Instantly, Salesforge) ship the same
"co-pilot" mode. What to copy: the draft states, the visible placeholder for
anything a person must add, learning from edits, and never sending without
approval. What not to copy: outbound prospecting; the client asked for inbound
consultation.

Local fact: `packages/email` sends through nodemailer with `smtp.exmail.qq.com`
as the default host. Inbound reading does not exist; IMAP or a mail API and the
client's permission are prerequisites (see the meeting questions).

## 8. Risks

- AG-UI 1.0 is days old; the schema may still move. Pin the version; keep a
  thin adapter so a change costs one file.
- A2UI is pre-1.0; our block catalog is the hedge.
- assistant-ui's runtime may fight our durable-log and takeover model; the
  spike must prove resume and takeover before anything else.
- Platform ambition can slow the client. Timebox extraction; the client's
  flows ship first.
- Contract and IP: reuse of generic modules must be allowed by the client
  agreement; client data and prompts never leave the client's backend.

## 9. Decisions to take

| # | Decision | Recommendation |
|---|---|---|
| P1 | Wire protocol | AG-UI 1.0, pinned, with our block catalog as Custom events |
| P2 | UI base | assistant-ui primitives; AI Elements as reference |
| P3 | When to extract packages | after the inbox surface exists |
| P4 | Skills tiers and what may be sold | Tier 1 internal, Tier 2 sellable, written governance |
| P5 | Who owns the monitoring loop | one named person approves weekly |
| P6 | Email as Stage E | after Stage C, gated on mailbox access and policy |
