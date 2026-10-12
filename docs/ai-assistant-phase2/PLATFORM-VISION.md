# A reusable AI chat platform — vision and architecture notes

**Status:** discussion draft, revised 2026-10-12 after the owner's review. No
implementation. Research facts are labelled **reported** with their source;
recommendations are ours.
**Related:** [TECH-REVIEW.md](./TECH-REVIEW.md) (Stage X) ·
[PLAN.md](./PLAN.md) (the Channel sales agent) ·
[CLIENT-ANSWERS-2026-10-12.md](./CLIENT-ANSWERS-2026-10-12.md)

## 1. The idea, in plain terms

Build the Channel sales agent so that two things come out of it instead of one:

1. **The expression layer** — a chat surface we own: a web component plus a
   small client and server SDK that can render what any AI backend sends
   (text, Markdown, media, product cards, comparisons, approvals, forms,
   status) and can be dropped into any JavaScript web stack and styled to a
   client in hours. NutriBuddy, KidsBuddy and CoachFlow would use the same
   package.
2. **Agent backends** that speak one protocol to that surface. The first is
   the Channel sales agent. A plain knowledge-base assistant, a support agent,
   or the Vibelingan hub in `hermesinfra` would plug into the same surface.

Around them, a **learning loop**: a monitoring agent reads what the product
does in production, writes down what worked and what failed, and the team
turns that into two tiers of skills — a detailed internal blueprint, and a
lighter field guide that can be sold. The product stays ours; the service is
building the serious version for clients who want more than the field guide.

The rule that keeps this honest: **the surface and the brain are decoupled by
a written protocol.** The chat does not know it is talking to a sales agent.
The sales agent does not know it is being drawn in a widget rather than an
email review page. The protocol is the product boundary.

## 2. Three layers, not three competitors

The names that came up are not alternatives to each other. They sit at
different layers:

```text
UI library      what draws the chat          assistant-ui · CopilotKit · AI Elements
  ↑ consumes
Wire protocol   how events travel             AG-UI (text, tool calls, state, custom events)
  ↑ may carry
UI language     how a card is described       our block catalog now · A2UI later
```

**AG-UI** is the pipe. It defines the events an agent sends while it works —
run started, text chunk, tool call, state snapshot, custom event — and what
the UI sends back. It does not say what a product card looks like.

**A2UI** is a language for describing UI inside that pipe: the agent sends
JSON ("a card with these fields bound to this data"), the client draws it
with its own components from a trusted catalog. It is one way to fill the
"custom event" slot of AG-UI; it is not required by AG-UI.

**Our block catalog** is our own small version of that language: a handful of
typed blocks (`product_cards`, `comparison`, `quote_draft`, `suggestions`,
`status`, `citation`, `approval_request`, `form_prefill`) with JSON schemas.
"Mapping to A2UI" only means we shape those blocks so that each one could be
expressed as an A2UI component later, without changing what the agent
produces. Since assistant-ui already renders A2UI delivered over AG-UI
(reported: assistant-ui docs, "A2UI over AG-UI"), that later switch is a
renderer change, not a rewrite.

**So which one to use:** AG-UI now, as the wire protocol. Our block catalog
now, carried as AG-UI custom events. A2UI later, when it reaches 1.0 or when a
third-party renderer needs our blocks. MCP Apps is set aside: it is iframe
HTML for MCP hosts (Claude, ChatGPT, VS Code), a possible distribution channel
one day, not our surface.

| Protocol | What it is | Status (reported) | License (reported) |
|---|---|---|---|
| AG-UI | Agent ↔ app event stream; bidirectional; SSE/WebSocket/HTTP; shared state as snapshot + JSON Patch | 1.0 with JSON Schema and generated SDKs (30 Sep 2026); adopters include Google, Microsoft, Amazon, Oracle, LangChain, Mastra ([CopilotKit](https://www.copilotkit.ai/blog/ag-ui-1.0), [events](https://docs.ag-ui.com/concepts/events)) | MIT ([repo](https://github.com/ag-ui-protocol/ag-ui), 16.5k stars) |
| A2UI | Declarative UI JSON from an agent, rendered from a client catalog | v0.9.1 current, v1.0 candidate; renderers for Lit, Angular, React, Flutter ([a2ui.org](https://a2ui.org/introduction/what-is-a2ui/)) | Apache-2.0 ([repo](https://github.com/google/A2UI), 16.7k stars) |
| AI SDK UI message stream | Vercel's stream format behind `useChat` | current in AI SDK 6 ([docs](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)) | part of the AI SDK (Apache-2.0) |

On "nine days old": agreed, age alone is not the issue; adoption and a
published schema are what matter, and AG-UI has both. Pinning the schema
version and keeping the adapter thin is ordinary practice for any dependency
on a critical path, not a comment on the protocol's maturity.

## 3. The UI library: assistant-ui, CopilotKit or AI Elements

All three can draw a chat. They differ in how much they decide for you and
what they are tied to.

| | **assistant-ui** | **CopilotKit** | **AI Elements** |
|---|---|---|---|
| What it is | Unstyled React primitives (Thread, Message, Composer, ThreadList…) plus a runtime layer | The company behind AG-UI; a full front-end stack: prebuilt chat (chat, sidebar, popup), headless hooks (`useAgent`, `useCopilotKit`), generative UI, shared state, human-in-the-loop, threads | Styled shadcn/ui components (48, incl. code, voice, workflow) copied into your repo |
| Backends | AI SDK, LangGraph/LangChain, **AG-UI** (`@assistant-ui/react-ag-ui`, `useAgUiRuntime`), A2A, Google ADK, custom | Any **AG-UI** agent; LangGraph, Mastra, CrewAI, Microsoft Agent Framework, Google ADK, Pydantic AI… | AI SDK |
| Rich UI | Tool calls and JSON rendered as React components; inline approvals; **A2UI over AG-UI** supported | Static (`useFrontendTool`), declarative (A2UI, launch partner), open-ended generative UI | Tool, Reasoning, Sources, Suggestion, Confirmation, Plan… |
| Frameworks | React 18/19 | React (GA), Angular, React Native, Vue; Channels SDK for Slack/Teams | React; docs assume Next.js + shadcn + Tailwind |
| Styling | You style the primitives; optional shadcn starter theme | Prebuilt look, themeable; fully headless on all plans | Styled; you edit the copies |
| License | MIT; optional paid Assistant Cloud for persistence | MIT core; "CopilotKit Intelligence" hosted platform with a free developer tier (threads: 3-day retention, 200 cap on free), self-hosting "runtime only" on free/Pro | not visible on the pages read; roundups disagree (MIT vs Apache-2.0) |
| Weight | light | heaviest and most opinionated of the three (reported roundup); SSR of generated UI not supported (reported) | light, but AI SDK-bound |
| Community | ~12.4k stars | ~37.9k stars | smaller; Vercel-backed |

Sources: [assistant-ui](https://github.com/assistant-ui/assistant-ui),
[assistant-ui AG-UI runtime](https://www.assistant-ui.com/docs/runtimes/ag-ui/overview),
[CopilotKit](https://github.com/CopilotKit/CopilotKit),
[CopilotKit pricing](https://www.copilotkit.ai/pricing),
[AI Elements](https://github.com/vercel/ai-elements),
[2026 roundup](https://dev.to/alexander_lukashov/i-evaluated-every-ai-chat-ui-library-in-2026-heres-what-i-found-and-what-i-built-4p10),
[comparison](https://www.libhunt.com/compare-assistant-ui-vs-CopilotKit).

Two that are out: **OpenAI ChatKit** — its backend SDK is Apache-2.0 but the
chat UI itself is served from OpenAI's CDN and is not published as source
(reported community reading), which rules it out for a product we must own
and host in China. **Deep Chat / NLUX** and similar web components — fine
for a demo, no AG-UI runtime, smaller ecosystems.

**Recommendation.** Protocol: AG-UI, which both serious candidates consume.
UI base: **assistant-ui by default**, because the platform's whole point is a
surface we restyle per client and embed in different stacks (Astro here,
Next.js in the other projects); unstyled primitives plus a runtime we point at
our transport is the shape that wants. **CopilotKit is the alternative** if
the spike shows we want its batteries (sidebar/popup out of the box, the
Channels SDK for Slack/Teams) more than we want control. Both are MIT; neither
needs a paid cloud for what we do. Spike X0 builds the same three screens
(discovery cards, product-page answer, quote draft) in both over the same
AG-UI stub and decides in two days. I have not run either here; this is a
reading of their docs and licenses, not a test.

## 4. What we wrap, what we build, what we publish

"Build it or grab it" has a clean answer by layer:

| Layer | Grab | Build (ours) |
|---|---|---|
| Wire protocol | AG-UI 1.0 SDKs (`@ag-ui/core`, `@ag-ui/client`) | the profile: block catalog schemas, capability manifest, house rules, conformance tests |
| Chat runtime and primitives | assistant-ui (or CopilotKit) | theme tokens, launcher/drawer, block renderers, action handlers, the capability-driven feature switch |
| Markdown, scrolling, a11y, keyboard | the library | nothing |
| Model calls and tools | AI SDK Core (Node) | the AG-UI emitter from AI SDK streams, the per-sentence guard, the durable log adapter |
| Tracing and evals | OpenTelemetry, Langfuse, promptfoo | the dashboards and the learning loop |

Packages to publish (names indicative):

```text
@vibelingan/chat-protocol   JSON schemas (AG-UI profile, block catalog, capability
                            manifest, actions); TypeScript types; validators;
                            fixtures; conformance tests both sides must pass
@vibelingan/chat-ui         React: <ChatLauncher>, <ChatThread>, block renderer
                            registry (one renderer per block type), action
                            handlers, theme tokens, mobile drawer, i18n;
                            built on assistant-ui's runtime; works in Astro,
                            Next.js, Remix, Vite
@vibelingan/chat-client     transport (SSE/WS), resume, auth hook, analytics hook
@vibelingan/chat-server     Node: emit AG-UI from AI SDK streams; durable-log
                            adapter (PostgreSQL); per-sentence guard; rate and
                            budget middleware; OpenTelemetry
                            (a small Python emitter later, for the hermesinfra hub)
```

How another project integrates, in one afternoon: mount
`<ChatLauncher endpoint="/api/agent" theme={tokens} blocks={registry} />` in
the app, and expose an AG-UI endpoint on the backend using `chat-server`
with that app's own tools and policy. The surface, the protocol and the
guards are the same; only the brain and the theme differ.

What stays out of the packages: any client's prompts, catalog, data,
credentials, or tenant-specific policy. Those live in each backend.

## 5. The learning loop and the two tiers of skills

**Monitoring agent.** A scheduled sub-agent reads production traces
(refusals, down-votes, latency outliers, tool failures, injection attempts,
unanswered topics), writes a learnings journal entry with evidence (trace
ids, counts), and proposes changes: prompt, catalog, policy, tests. A person
approves. This reuses the engineering-craft journal and consolidation flow
already in use.

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

## 6. Where `hermesinfra` fits

Read from the local checkout on 2026-10-12 (`feat/react-router-scaffold`):
a Python hub and dispatcher on systemd, Hermes agent containers over A2A, a
React Router customer portal with SSE chat, WeCom login and group-webhook
push, MySQL, and a KB gateway in front of vibekb — the AnythingLLM instance
the Channel assistant already uses. Its frontend modernization is in progress
and lists assistant-ui as a proposal; its docs say the live state is
unverified; several September RCAs concern stream authorization and exposed
ports.

It has the pieces of a platform, but not the one thing this document is
about: a written protocol between surface and brain. The Channel work can
supply that. The order that respects both repos:

1. Channel: protocol profile + surface + sales brain (Stages X, B, C, E).
2. `hermesinfra`: when its chat module is extracted, point it at the same
   protocol; its hub becomes a second AG-UI backend. A small Python emitter in
   `chat-server` makes that cheap.
3. Only then decide whether the Channel brain should move. Moving it now
   would trade a reviewed, deployed CloudRun service for a platform whose
   security posture is still being hardened.

## 7. How this changes the Channel plan

- Stage X spike X0: assistant-ui + AG-UI first, CopilotKit as the alternative,
  same three screens in both.
- Stage X X3: the BFF emits AG-UI events; blocks catalog v1 covers the Phase 2
  blocks.
- Stage E — email consultation — after C: mailbox over IMAP/SMTP, drafts into
  the mailbox's Drafts folder, WeCom notification, approval by sending from
  the mail client, a review page in the site admin for evidence and audit
  (details in CLIENT-ANSWERS §3).
- Extraction policy: packages are **extracted from the client build** once
  two surfaces (widget, review page) use them; we do not pre-build a platform
  and then look for a client.

## 8. Email consultation: what exists and what to copy

Reported: the human-in-the-loop pattern (draft → person reviews → send, with
pricing and commitments always reviewed) is common in open-source email
agents such as [AgentSDR](https://github.com/Kandid-ai/AgentSDR) (AGPL-3.0),
[Draftly](https://github.com/almightyzeus/draftly-gmail) (MIT; drafts move
PENDING → APPROVED → SENT and become Gmail drafts),
[approveandsend](https://github.com/terryops/approveandsend) (MIT; learns
from edits) and [ai-reply-drafter](https://github.com/autonexuslabs/ai-reply-drafter)
(safety checks in code). What to copy: draft states, the visible placeholder
for anything a person must add, learning from edits, never sending without
approval. What not to copy: outbound prospecting; the client asked for inbound
consultation.

Mail mechanics for Tencent enterprise mail are in CLIENT-ANSWERS §3: IMAP and
SMTP on the shared `sales@`, because the WeCom mail API reads and sends only
through an application's own mailbox.

## 9. Risks

- AG-UI 1.0 is new; pin the schema version; keep the adapter thin.
- A2UI is pre-1.0; our block catalog is the hedge.
- assistant-ui's runtime may fight our durable-log and takeover model; the
  spike must prove resume and takeover before anything else.
- Platform ambition can slow the client. Timebox extraction; the client's
  flows ship first.
- Contract and IP: reuse of generic modules must be allowed by the client
  agreement; client data and prompts never leave the client's backend.
- `hermesinfra` convergence depends on its own refactor finishing; do not
  couple Channel delivery dates to it.

## 10. Decisions to take

| # | Decision | Recommendation |
|---|---|---|
| P1 | Wire protocol | AG-UI 1.0, pinned, with our block catalog as custom events; A2UI later |
| P2 | UI base | assistant-ui by default; CopilotKit if the two-day spike favours its batteries |
| P3 | When to extract packages | after the review page is the second surface |
| P4 | Skills tiers and what may be sold | Tier 1 internal, Tier 2 sellable, written governance |
| P5 | Who owns the monitoring loop | one named person approves weekly |
| P6 | Email as Stage E | after Stage C, gated on IMAP/SMTP access and the approval policy |
| P7 | `hermesinfra` as a second backend | after the protocol exists; the Channel brain does not move now |
