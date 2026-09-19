# AI assistant — technical experience review

**Date:** 2026-09-19 · **Base:** `origin/main` at `b0015c0`
**Companion to:** [PLAN.md](./PLAN.md) (what the assistant should do). This
document is about how it should feel: speed, streaming, interface quality, and
what to build on instead of hand-rolling.

Evidence labels: **observed** (code or recorded evidence), **reported** (named
source), **assumed** (not yet checked; the step that checks it is named).

---

## Short answers

**What framework does the assistant use?** None. The widget is React 19
`useState` + `fetch` + a hand-written SSE parser
(`apps/site/src/islands/ai/AssistantWidget.tsx`). The BFF is a raw Node `http`
server (`apps/ai-bff/src/server.ts`). The event protocol is our own eight-type
union (`packages/ai-contracts/src/index.ts`). No AI SDK, chat UI kit or Markdown
renderer appears anywhere in the repo (observed: no match in `apps/`,
`packages/`, `docs/`).

**Why?** Three reasons, visible in the docs:

1. Every review round spent its effort on correctness: the human-takeover fence,
   ordered events, fail-closed grounding, credential isolation. Those parts are
   good. The chat interface was never given a build-versus-buy review; the
   architecture only says "implement as an Astro/React client island"
   (`CHANNEL_AI_ASSISTANT_ARCHITECTURE.md` §10).
2. ADR-002 treated the interface as solved: "We already have the chat
   interface. The widget and the BFF exist by design." It evaluated engines
   (AnythingLLM, Dify, RAGFlow), not front ends.
3. The knowledge-base product decided the delivery shape. Its stream sends the
   sources in a separate frame **after** the last text chunk (ADR-002 §6).
   The safety check needs the sources, so the worker must wait for the whole
   answer before it can release anything (`worker.ts:361-365`). Review Round 4
   made that hold-back a P1 fix after an invented "$12 each" briefly reached the
   browser (`packages/ai-policy/src/grounding.ts` header).

**Was that wrong?** The safety core is right and worth keeping. The mistake was
letting a vendor's stream format decide the user experience, and never checking
whether the interface could be built on existing open-source parts. ADR-002 §4
itself preferred "retrieve first, then call the model ourselves"; the code uses
the vendor's all-in-one `/stream-chat` instead
(`packages/ai-engine-anythingllm/src/engine.ts:372`). That one choice causes
the whole-answer delay.

**The progressive-reveal branch** (`feat/ai-widget-progressive-reveal`,
`6a2376e`, local only, not merged) changes presentation, not speed. It also
adds up to 1.5 s of animation *after* a wait that is already about 15 s.
Its "Checking approved sources…" waiting state is worth keeping; the word-by-word
replay is not a substitute for real streaming.

---

## Ten questions an architect would ask

### 1. Why does the buyer wait about 15 seconds before seeing anything, and do we measure it?

- **Observed:** the 2026-09-02 run of 35 real questions shows median 14.9 s and
  maximum 25.2 s from sending to the finished answer. One of the 35 finished
  under 5 s; six took over 20 s. Nothing appears on screen until the end.
- **Missing:** a time-to-first-word metric. Only send-to-finish is recorded.
- **What good looks like:** ChatGPT, Claude and Intercom Fin show the first words
  within about a second and stream the rest. A useful target here: a visible
  status within 300 ms and first words within 1.5 s at p50 (assumed; B0
  measures what the model allows).

### 2. Why does the whole answer have to be held back to be safe?

- **Observed:** the sources arrive last, so publishability cannot be judged
  earlier (ADR-002 §6, `worker.ts:361-365`).
- **The fix, well established elsewhere:** retrieve first, then generate. The
  worker calls the knowledge base's `/vector-search` (already probed, about
  100 ms, no model call; ADR-002 §6 table), applies the approved-source rule
  **before** the model writes a word, then streams. The remaining check, "does
  this sentence state an unsupported price, date or certificate?", runs per
  sentence: hold each sentence until it ends, check it, release it. NVIDIA NeMo
  Guardrails and Guardrails AI both validate streamed output this way.
- **Result:** real streaming with about one sentence of delay. A sentence with
  an invented price is still stopped before it reaches the browser. Phase 2
  moves product numbers into cards built from data, so fewer sentences need
  holding at all.

### 3. Why is the system prompt inside a vendor product?

- **Observed:** the answer policy (`apps/ai-bff/policy/public-sales-v1.txt`) is
  pushed into the AnythingLLM workspace as `openAiPrompt` and generation runs
  there (`scripts/ai-configure-workspace.mjs:35`). Retrieval settings (`topN` 4,
  threshold 0.25) are also the vendor's.
- **ADR-002 §4 said the opposite:** "Handing an external product control of the
  system prompt would put our highest-stakes rule … inside a component we do
  not review."
- **Better:** generation in our worker with a model SDK. The prompt, model
  choice, temperature, tools and retrieval parameters become versioned code.
  This is the same move that fixes question 2 and that ADR-003 proposes.

### 4. Why a reasoning model for a sales chat?

- **Reported (ADR-002 §7):** both configured models are reasoning models that
  spend hidden "thinking" tokens inside the answer budget. They returned empty
  answers at small limits, and the adapter has a state machine just to strip
  `<think>` tags (`reasoning.ts`).
- **Cost of that choice:** silent seconds before any answer text, and tokens
  billed for reasoning the buyer never sees.
- **Better:** a fast model (or low reasoning effort) for ordinary chat turns;
  deeper reasoning only when a turn needs it. B0 should measure first-word
  latency and cost per turn for at least one fast model alongside the current
  pair.

### 5. Why is the stream delivered by polling the database?

- **Observed:** the worker polls its queue every 250 ms (`AI_WORKER_POLL_MS`),
  and each open chat stream queries PostgreSQL every 250 ms
  (`AI_SSE_POLL_MS`, `server.ts:424`), for up to 55 s per connection. That is
  four queries a second per open panel, plus up to half a second of added
  delay per hop.
- **Keep:** the durable, ordered event log. It is the reason a reload can
  resume, and the reason a human takeover can stop old AI text. That is more
  than Vercel's Redis-based `resumable-stream` offers: an independent review
  by Ably describes a page reload during generation as the one case it handles
  reliably, and it has no takeover fence.
- **Change:** push instead of poll. PostgreSQL `LISTEN/NOTIFY` wakes the stream
  when a row lands, and the worker writes text in small batches (for example
  every 50–100 ms) instead of one final block.

### 6. Why our own event protocol instead of a standard one?

- **Observed:** eight event types, text and links only
  (`packages/ai-contracts/src/index.ts`). Adding product cards needs a database
  migration, a contract change, a BFF switch and a new parser.
- **Standard available:** the AI SDK UI message stream protocol already carries
  streamed text, sources, tool-call lifecycle, typed data parts (product cards),
  message metadata and finish reasons. `useChat` handles send, stop, status,
  reconnect and resume on the client, and accepts a custom transport, so it can
  talk to our BFF with our credential.
- **Better:** the BFF speaks that protocol over our event log. Cards become
  typed parts, and the front end gets a maintained client instead of a
  hand-written parser.

### 7. Why is the chat interface hand-built, and what is it missing?

Observed gaps in the current widget:

| Expected in a modern chat UI | Current widget |
|---|---|
| Streaming Markdown (lists, bold, links) | Plain text with `whitespace-pre-wrap`. 1 of 33 recorded answers used Markdown and would show raw `**` |
| Full-height drawer on phones (required by architecture §10) | Fixed box `min(38rem, 100svh−7rem)` |
| Focus containment (required by §10) | Non-modal dialog, no focus trap |
| History after reload | Blank panel (no transcript route) |
| Copy, retry, thumbs up/down, suggested questions | None |
| Scroll that respects a reader who scrolled up | Always jumps to the bottom |
| Loads only when needed | `client:load` on every page, even when never opened |
| Browser tests | No Playwright spec for the widget |

- **Open-source options that already solve these:** Vercel AI Elements (a
  shadcn/ui-based component set: Conversation, Message, Response with the
  Streamdown streaming-Markdown renderer, Sources, Suggestion, PromptInput,
  Tool); assistant-ui (React primitives with a runtime that can wrap a custom
  backend); shadcn/ui's June 2026 chat components (MessageScroller, Message,
  Bubble, Marker; these don't need a specific AI library).
- **Next.js is not required.** All of these are React components. They run in an
  Astro React island (assumed until spike X0 confirms it with this site's
  Tailwind 4 tokens and bundle budget).

### 8. When an answer is bad in production, how would we find out?

- **Observed:** the worker logs its start and its failures (three log
  statements; failure logging was added after the 2026-09-02 run found failures
  visible only in the database, defect D3). A successful turn leaves no record
  of what was retrieved, which prompt version ran, tokens used, cost, or time
  per step. There is no way for a buyer to say an answer was wrong.
- **Better:** OpenTelemetry traces per turn (the AI SDK emits them) into a
  self-hosted, open-source LLM observability tool such as Langfuse. Add thumbs
  up/down from the widget, attached to the trace. A weekly review of refused,
  down-voted and slow turns feeds the knowledge brief and the eval set.

### 9. Is quality checked on every change, or only in one-off runs?

- **Observed:** a 35-question content run happened once (2026-09-02). The
  29-case security battery was written but has never run: the readiness review
  of 2026-09-07 still lists it as "NOT RUN". There is no widget browser test.
  The progressive-reveal change was checked by hand.
- **Better:** evals in CI. Golden questions, the security battery and the Phase
  2 product-discovery set run on every change to the prompt, model, retrieval
  settings or corpus, with a pass threshold that blocks merge. Open-source tools
  such as promptfoo run this from the command line. Playwright covers the widget
  journeys.

### 10. When human takeover is built, will we hand-build a sales inbox too?

- **Observed:** LLD-001 designs a takeover state machine plus sales routes and a
  queue. None of the sales side is built.
- **Open-source option:** Chatwoot is a self-hostable support inbox. Its Agent
  Bot API lets our assistant answer first and hand the conversation to a human
  with the full transcript. Sales get an inbox, assignment, notifications and a
  mobile app without us writing them.
- **Question to settle in an ADR before any takeover code:** our takeover fence
  and data residency on Chatwoot, or a hand-built console? At a 100-person
  company, the inbox is the kind of product not worth rebuilding.

---

## What to keep, what to replace

| Keep (it is good) | Replace or add |
|---|---|
| Durable ordered event log in PostgreSQL; resume by sequence | Poll loops → `LISTEN/NOTIFY` push |
| Takeover fence (LLD-001) | Vendor all-in-one generation → retrieve first, generate in our worker |
| Fail-closed approved-source rule | Whole-answer hold → per-sentence check while streaming |
| Commercial-value check (`grounding.ts`) | Private eight-type protocol → AI SDK UI message stream |
| Credential isolation, evidence-gated deploys | Hand-built widget → `useChat` + AI Elements (or assistant-ui), restyled to DESIGN.md |
| Knowledge base as the content store and editing UI | No tracing or feedback → OpenTelemetry + Langfuse + thumbs |
| | One-off eval runs → CI evals and widget Playwright tests |

## Proposed stack

| Layer | Choice | Why this one |
|---|---|---|
| Chat state and transport (browser) | AI SDK UI `useChat` with a custom transport to our BFF | Maintained client for send, stop, status, reconnect, resume, message parts |
| Chat components | AI Elements, copied into the repo and restyled with site tokens | Same message-parts model as the AI SDK; the code is ours to edit; includes Streamdown for streaming Markdown |
| Fallback component option | assistant-ui | If AI Elements fights Astro or Tailwind 4 in spike X0 |
| Model calls and tools (worker) | AI SDK Core `streamText` + `@ai-sdk/openai-compatible` for the current provider, tools with zod schemas, step limit | One API for streaming, tool calls and telemetry; provider stays swappable |
| Retrieval | Knowledge base `/vector-search` + PostgreSQL catalog index (PLAN.md §6) | Sources known before generation |
| Streaming safety | Per-sentence commercial-value check before each append | Real streaming without releasing an unchecked claim |
| Delivery | Existing event log + `LISTEN/NOTIFY`; BFF emits UI message stream parts | Keeps resume and the takeover fence |
| Observability | OpenTelemetry → self-hosted Langfuse | Per-turn traces, cost, latency, feedback |
| Evals | promptfoo (or Langfuse datasets) in CI; Playwright for the widget | Quality gates on every change |
| Human inbox (later) | Chatwoot via Agent Bot API, subject to an ADR | Avoids building a support product |

## Targets

| Measure | Today | Target (assumed until B0/X0 measure) |
|---|---|---|
| First visible status | none until the end | ≤ 300 ms |
| First words, p50 | ≈ 15 s (same as finish) | ≤ 1.5 s |
| Full answer, p50 | 14.9 s | ≤ 6 s |
| History after reload | blank | 100 % in e2e |
| Widget JS on pages where it is never opened | full widget at load | launcher only; panel loaded on first open |
| Security battery | never run | runs in CI, blocks merge |

## How this changes the Phase 2 plan

A **Stage X — chat foundation** goes first and absorbs parts of Stages A and C,
because rebuilding the widget later would redo A's work:

| Step | What | Done when |
|---|---|---|
| X0 | Spike: `useChat` + AI Elements in an Astro island with site tokens; lazy-loaded panel; custom transport against a stub | renders, streams from the stub, bundle measured; go/no-go between AI Elements and assistant-ui |
| X1 | Worker: retrieve first, generate with AI SDK Core, approved-source rule before generation (includes B0's model measurements) | first words stream in local e2e; unapproved-source case still produces zero text |
| X2 | Per-sentence commercial-value check on the stream | eval: invented price never appears in any committed event |
| X3 | BFF emits UI message stream parts; `LISTEN/NOTIFY`; transcript route (was A1) | contract tests; resume after reload mid-answer |
| X4 | New widget on `useChat` + components: Markdown, mobile drawer, focus trap, history (was A2), New chat (was A4), feedback, suggestions | Playwright journeys; accessibility checks from DESIGN.md |
| X5 | Tracing and feedback into Langfuse | a test turn visible with retrieval, tokens, latency, score |
| X6 | CI evals: golden set, security battery, widget Playwright | merge blocked on failure |

Stages B, C and D keep their order. Product cards (C4/C6) become typed message
parts rendered by our own card component inside the new widget.

**What X1–X3 require from the existing docs:** the same ADR-003 amendments PLAN.md
§3 lists (generation moves into the worker; new provenance kind; new event
types), plus an LLD-001 update so streamed text commits in fenced batches rather
than one final transaction. The Review Round 4 rule, that no unchecked claim
reaches the browser, stays; its unit of checking becomes the sentence.

---

Sources:
[AI SDK 6](https://vercel.com/blog/ai-sdk-6) ·
[AI SDK stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) ·
[useChat reference](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat) ·
[AI SDK resume streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams) ·
[resumable-stream coverage (Ably)](https://ably.com/vercel/vercel-ai-sdk-resumable-stream-what-it-covers-and-what-it-doesnt) ·
[AI Elements](https://github.com/vercel/ai-elements) ·
[assistant-ui](https://github.com/assistant-ui/assistant-ui) ·
[shadcn/ui chat components](https://ui.shadcn.com/docs/changelog/2026-06-chat-components) ·
[NeMo Guardrails output streaming](https://docs.nvidia.com/nemo/guardrails/configure-guardrails/yaml-schema/streaming/output-rail-streaming) ·
[Guardrails AI streaming](https://guardrailsai.com/guardrails/docs/concepts/streaming) ·
[Chatwoot Agent Bots](https://www.chatwoot.com/features/chatbots)
