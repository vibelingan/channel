# AI Platform — Gap Analysis & Design (CloudBase AI)

Status: **Design / proposal** (no code changes yet)
Scope: the AI capabilities the PRD positions as the product's core, none of which exist in the current build, and how to implement them on CloudBase's built-in AI + Agent stack.
Requirements source: `Diversity_Technology_Website_Upgrade_Specification.pdf` (§3, §4.1, §4.3, §4.4, §4.5). CloudBase facts from the `cloudbase` skill (`ai-model-nodejs`, `cloudbase-agent`).

> **PARTIALLY SUPERSEDED — 2026-07-21:** For customer-service runtime, anonymous-chat vs Lead conversion, email-gate policy, human-handoff consistency, and AI roadmap phasing, use [docs/ai-platform/ARCHITECTURE_AND_ROADMAP.md](ai-platform/ARCHITECTURE_AND_ROADMAP.md) and [ADR-001](ai-platform/ADR-001-HERMES-LEXIANG-CONTROL-PLANE.md). Those documents replace §2's CloudBase Agent default, §3.2, the chat portion of §3.4, §4's chat email-gate rule, and §5 A3. The deterministic estimator, content modules, Lead convergence, and general security principles here remain valid where not contradicted.

---

## 1. The gap

The PRD's headline positioning is "**AI 驅動型全球供應鏈外貿平台**" (AI-driven global supply-chain trade platform). The AI layer *is* the product. **None of it is built.** The repo has six collections (`users`, `oemProjects`, `products`, `overstock`, `images`, `files`) and pages for home/portfolio/OEM-inquiry/shop/account/admin. A full-text grep for `openai|anthropic|llm|generateText|streamText|estimator|chatbot|teardown|newsletter|langchain` across `apps/` + `packages/` returns **nothing**.

| PRD feature | § | Status | Priority |
|---|---|---|---|
| AI Instant Estimator (multi-step → price range → email-gated PDF + lead) | §4.5 | ❌ absent | **Core** (PRD calls it "重中之重" / core conversion tool) |
| AI Customer-Service chat (24/7, MOQ/Price/Lead-Time/Cert/OEM, human handoff) | §3 | ❌ absent | High |
| Teardown Lab (weekly Kickstarter teardown + BOM/cost, newsletter capture) | §4.3 | ❌ absent | High (marketing funnel) |
| Concept Incubator (concept products, 3D `.glb` viewer, partnership tiers) | §4.4 | ❌ absent | Medium |
| AI cost-matrix / trend / supplier "capability" display | §4.1 | ❌ absent | Medium (partly marketing) |
| Newsletter capture (Mailchimp/HubSpot) | §4.3 | ❌ absent | Medium |

## 2. CloudBase AI building blocks (verified)

The repo **already imports `@cloudbase/node-sdk`** (`packages/db/src/cloudbase-adapter.ts`), so the AI surface is additive on the same SDK.

- **Text generation** — `app.ai().createModel("cloudbase")` → `generateText()` / `streamText()`. `"cloudbase"` is the managed TokenHub group (multi-vendor: DeepSeek, Hunyuan, GLM, Kimi, MiniMax). The concrete model id (e.g. `deepseek-v4-flash`) goes in the **`model` field**, not in `createModel`.
- **Image generation** — `app.ai().createImageModel("hunyuan-image")` → `generateImage()` (Node SDK only).
- **AI Agent (智能体)** — **CloudBase Agent SDK** (`@cloudbase/agent-server`, TS or Python) implementing the **AG-UI** streaming protocol, with LangGraph/LangChain/CrewAI adapters. Deployed as an **HTTP function** (listens on `:9000`, `scf_bootstrap`, SSE streaming) or CloudRun. This is the right primitive for the customer-service chat (multi-turn, tool-calling, streaming UI, human handoff).
- **Prerequisites (hard gate):** an active **Token Credits resource pack** on the env, and each model **enabled** via `UpdateAIModel` (check `DescribeAIModels` / `DescribeManagedAIModelList` first). Text + image share the same pack. Without the pack, AI calls fail at runtime — verify before building.

### Where each piece runs
- Estimator report + BOM narrative + newsletter → **event/HTTP cloud functions** (reuse the existing `apps/functions/*` + `packages/db` + `packages/email` pattern).
- Customer-service chat → **CloudBase Agent (HTTP function / CloudRun, SSE)** with an AG-UI web client island in the Astro site.

## 3. Feature designs

### 3.1 AI Instant Estimator (§4.5) — core conversion funnel

Flow (PRD): Step 1 category → Step 2 feature checkboxes → Step 3 quantity/timeline → Step 4 **email gate** ("Enter your corporate email to instantly receive the PDF report") → price range + mould estimate emailed **and** pushed to the sales backend as a lead.

**Critical design decision — price is deterministic, not LLM-generated.** The PRD says the quote comes from a "**矩陣公式**" (matrix formula). The price range MUST be computed by a **deterministic, config-driven cost matrix**, never by the LLM (LLMs hallucinate numbers and would leak/mangle cost logic). The LLM's role is limited to **narrative** (the report prose, assumptions, next-steps) and localization.

Components:
- New `estimatorConfig` collection (admin-editable): per-category base cost, feature deltas (ANC/IPX7/eco-plastic/app-dev…), quantity-tier multipliers, tooling/mould cost. Pure data → the price engine is a small pure function in `packages/shared` (unit-testable, like the existing `query.ts`).
- New public action `requestEstimate` (unauthenticated, rate-limited — reuse the OEM `evaluateFixedWindowRateLimit` primitive) → validates input (zod), runs the price engine, optionally calls `generateText` for the report narrative, renders a PDF, emails it (`packages/email`), and writes a **lead** (§3.4).
- New `leads` collection: `source` (`estimator|chat|newsletter`), `email` (**encrypted per §6.3** — see role/security design), company, name, category, computed range, `assignedTo`, `status`. Leads flow into the **sales role** from the role/security design.

Security: server-side price engine (never trust client-sent prices); the estimator response must **not** expose the raw cost matrix or internal margins; PII (email) encrypted; abuse/cost controls (rate-limit + Token pack budget alarms).

### 3.2 AI Customer-Service Agent (§3)

Requirements: floating 24/7 widget; auto-answers MOQ / Price / Lead Time / Certificate / OEM-availability; syncs the conversation to a sales rep; **auto-stops when a human takes over**.

Design — **CloudBase Agent (AG-UI, streaming)**:
- Agent server (`@cloudbase/agent-server`) as an HTTP function with SSE. System prompt scoped to Diversity's OEM domain; **grounded** (RAG) on a curated `knowledgeBase` collection (FAQ, certifications, capabilities) + published `products`/`portfolio` — **never** on internal cost/margin fields (tie-in: the same fields V1 must stop leaking).
- Web client: an Astro island using the AG-UI client to stream tokens.
- **Human handoff:** persist `conversations` + `messages`; a conversation has a `handedOff` flag. When a sales rep opens it in the admin, set `handedOff = true`; the agent server checks this flag and **stops auto-replying** (PRD "一旦真人介入，AI客服自動停止接待"). Each new conversation also creates/updates a `leads` row so sales can follow up (PRD "同步給業務員跟進").
- Guardrails: prompt-injection resistance (the KB is the only authority; instruct the model to refuse to reveal system prompt / internal pricing), PII minimization in logs (log token counts, not transcripts), and per-session rate/cost caps.

### 3.3 Teardown Lab + Concept Incubator (§4.3 / §4.4)

- New content collections `teardowns` and `concepts` (registry-driven, same admin CRUD as `products`; shared editorial team per the role design). Fields: rich-text STAR/analysis, BOM table (json), Ex-work price estimate, manufacturing-pitfalls, SEO meta (title/description/OG), slug.
- **AI-assisted BOM estimation** is an **admin authoring tool**, not a public endpoint: an admin action that calls `generateText` to draft a BOM/cost breakdown from a product description, which the editor reviews and edits before publish (human-in-the-loop; no unreviewed AI output goes public).
- **3D viewer:** store `.glb`/`.gltf` via the existing media-storage package; lazy-load a Three.js viewer island (per §6.2 performance rules).
- **Newsletter capture:** `subscribers` collection + a `subscribe` public action (rate-limited, email encrypted). Sync to Mailchimp/HubSpot via a server-side function using an API key from env (never client-side). Double-opt-in for GDPR (§6.3).

### 3.4 Leads pipeline (cross-cutting)

Estimator, chat, and newsletter all converge on the `leads` collection, which is owned by the **sales role** defined in the role/security design (`assignedTo` scoping, encrypted email, redaction). This is the join point between the AI layer and the access-control layer — build `leads` + `sales` role together.

## 4. Cross-cutting concerns

- **Cost/abuse:** all public AI actions rate-limited (reuse `media-ratelimit`); per-session token caps; budget alarms on the selected model path. Estimator remains behind the email gate. Public FAQ chat may start anonymously; a Lead is created only on explicit handoff/contact submission with consent.
- **Security:** never let AI surfaces read internal cost/margin fields (depends on V1 field allowlisting); prompt-injection guardrails; PII (lead email) encrypted at rest (§6.3); no transcripts/prompts in production logs.
- **Config over code:** model ids and the cost matrix live in config/collections (a single source of truth), since the managed model roster evolves.
- **Preflight before any build:** confirm the Token Credits pack is active and enable the chosen text model (`DescribeAIModels` → `UpdateAIModel`); pick a default model (e.g. `deepseek-v4-flash` for cost, a stronger model for the report narrative) after checking `DescribeManagedAIModelList` pricing.

## 5. Phasing

| Phase | Work | Why this order |
|---|---|---|
| A0 | Preflight: Token pack + enable model; add `app.ai()` wiring to a new `packages/ai` facade (mirror `packages/db`) | Everything depends on it |
| A1 | AI Instant Estimator (deterministic matrix + narrative + email gate + `leads`) | PRD core conversion tool; highest business value |
| A2 | `sales` role + leads pipeline (shared with role/security design P4) | Makes leads actionable |
| A3 | AI Customer-Service Agent (AG-UI, RAG, human handoff) | High-value, larger surface |
| A4 | Teardown Lab + newsletter capture | Marketing funnel + SEO |
| A5 | Concept Incubator + 3D viewer | Rich media, lower urgency |

## 6. Open questions

- Model choice & budget: which managed model for the report narrative vs the chat agent, and the monthly Token Credits budget? (Needs `DescribeManagedAIModelList` pricing + a spend cap.)
- Estimator matrix ownership: who maintains `estimatorConfig` values, and how often do costs change?
- Newsletter ESP: Mailchimp vs HubSpot (PRD lists both) — pick one for the first build.
- Agent runtime: HTTP function vs CloudRun for the chat agent (CloudRun `MinNum >= 1` avoids cold starts but costs more idle).
