# Site assistant and public knowledge (agent reference)

Facts an agent needs before changing or debugging the "Ask our AI" assistant on
supplychainsai.com. Each cost an investigation; read this first. Deploy
mechanics are in `docs/agents/cloudbase.md`.

## What runs where

- The widget on the site talks to **ai-bff**; **ai-worker** runs the model.
  Both are CloudRun services in the one CloudBase environment. They deploy by
  pushing a tag `ai-cloudrun-deploy-<date>-<n>` (workflow *Deploy AI
  CloudRun*), not by pushing `test`.
- The worker reads company knowledge from the VibeKB server
  (`kb.supplychainsai.com/mcp`) with a **read-only key** (`VIBEKB_PUBLIC_API_KEY`,
  prefix `kbpub_`). That key is bound, on the KB server, to one workspace:
  `diversity-public`. A document is public exactly when it sits in that
  workspace; nothing on this side can widen it. Moving a document in or out
  takes effect at once.
- The KB searches the public workspace by meaning (embeddings and rerank
  through OpenRouter); every other workspace stays literal and sends nothing
  out. Design: `docs/ai-platform/PUBLIC-KNOWLEDGE-WORKSPACE.zh-CN.md`.

## Ask the live assistant without a browser

One conversation, several turns, event types per turn:

1. `POST {bff}/api/ai/conversations` with `{"locale":"en"}` and an `Origin:
   https://supplychainsai.com` header → `conversationId`, `credential`.
2. `POST …/conversations/{id}/messages` with `{"message", "idempotencyKey"}`
   and `Authorization: Bearer {credential}`.
3. `GET …/conversations/{id}/events` with `Last-Event-ID: <last sequence>`;
   read the stream until `final`, `error` or `run.failed`.

The BFF address is printed at the end of every deploy run ("AI BFF address").
Always test **at least four turns in one conversation**; single questions hid
the worst bug below for a day. For about a minute after a deploy the worker is
cold: runs queue and streams end empty. Wait, then test.

The browser widget keeps its conversation in `sessionStorage` under
`channel.ai.conversation.v1`; a reload continues the same conversation. Remove
that key to start clean.

## Replay with the real model, locally

`scripts/assistant-real-smoke.mts` drives the engine against the real model and
the public workspace through an SSH relay on the content machine; no key leaves
that machine.

```bash
ASSISTANT_SSH_CONFIG=<ssh config> ASSISTANT_SSH_HOST=<host alias> \
  node --experimental-transform-types scripts/assistant-real-smoke.mts
```

Node 22.13 needs `--experimental-transform-types` (plain strip-types rejects
the engine's parameter properties). Wrap `fetch` to log each call and the
model's raw text when a turn throws: that is how the blank reply was found.

## Symptoms seen, and what they were

| Visitor sees | Events | Cause | Fix |
|---|---|---|---|
| "I could not ground an answer" and the input box disappears, from about the third or fourth turn | `run.failed(transient)`, no knowledge call | In JSON mode the model returned only whitespace. Our own past replies were sent back as prose while the prompt demands one JSON object | Past assistant turns are sent as `{"kind":"answer","text":…}`; a blank reply is asked for again once (`7ca42d83`) |
| "Our team needs to confirm that detail" for a question the public documents answer (samples, lead time) | `final`, no citations | The model answered from general knowledge with no knowledge step; the publication gate refuses an answer that cites nothing | The engine looks the visitor's question up once and asks again (`ebd2c03c`) |
| A whole-sentence question finds nothing | search returns "无命中" | Literal search needs the exact words | Semantic search for the public workspace (KB side) |
| Real-model probe dies with `provider_request_rejected` | relay answers 502 | The relay only allowed `stream:false`; the engine streams | Relay accepts the streaming form (`a576091d`) |

When a turn fails, find out which of three it is before touching code: the
knowledge base (search it directly with the read-only key), the model (replay
and print its raw text), or the worker (cold start, deploy in progress).
