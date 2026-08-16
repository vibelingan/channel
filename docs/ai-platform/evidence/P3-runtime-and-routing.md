# P3 — Runtime and routing evidence (MIU 0)

**Recorded:** 2026-08-16
**Environment:** `diversity-123-d9grnqfux221323bb` (ap-shanghai), 标准版
**Method:** deployed a throwaway CloudRun service (`ai-probe`, helloworld
template) and measured. Not inferred.

---

## R1 — CloudRun availability

| | |
|---|---|
| Before activation | `manageCloudRun deploy` → **`云托管资源未开通`** |
| Note | `queryCloudRun list` returned an empty list *successfully* while the feature was off. An empty list does NOT mean "available and unused" — it meant "never switched on". |
| After activation by the owner | Deploy succeeded |

**Deployed service URL:** `https://ai-probe-298020-11-1443560658.sh.run.tcloudbase.com`
**Service type:** `function` (function-type CloudRun; the helloworld template
ships no Dockerfile)
**Time from deploy trigger to first HTTP 200:** ~120 seconds
(3 polls returned `SERVICE_VERSION_NOT_FOUND` first — the service object exists
before its first version is built, so a 404 immediately after deploy is normal.)

**Verified:** `GET /` → `HTTP 200`, body `Hello world!`

---

## R2 — Server-sent events survive the gateway ✅

This was the riskiest unproven assumption in the design: streaming that dies
quietly behind a buffering proxy (TEST_STRATEGY §5, MIU 7).

Request: `GET /sse` with `Accept: text/event-stream`

Response headers:

```
content-type: text/event-stream; charset=utf-8
transfer-encoding: chunked
cache-control: no-cache
```

Events arrived incrementally, multi-line frames intact, UTF-8 and emoji
preserved.

**Conclusion:** CloudBase CloudRun streams SSE correctly end to end. The
assistant's token-by-token delivery works on this platform. `context.sse()` is
the platform API (`sse.send({data})`, `sse.on('close')`).

---

## R3 — The `/api/ai/*` route collision is REAL, and CloudRun resolves it

Website API base: `https://diversity-123-d9grnqfux221323bb.service.tcloudbase.com`

| Request | Result | Handled by |
|---|---|---|
| `GET /api/products?pageSize=1` | `HTTP 200` | `public-api` function |
| `POST /api/admin` | `HTTP 401` | `admin` function (auth required — correct) |
| `GET /api/ai/healthz` | `{"ok":false,"error":{"code":"NOT_FOUND","message":"Route not found"}}` | **`public-api` function** — that is this repo's own error envelope |
| `GET /ai-probe/` on the same domain | `HTTP 404` | nothing — CloudRun is not mounted here |

**Two findings:**

1. **The collision is confirmed.** `/api/ai/*` is swallowed by the `public-api`
   function today. Mounting the assistant at that path on this domain would put
   it behind the storefront catalog handler.
2. **It does not matter, because CloudRun does not use that domain.** A CloudRun
   service gets its **own hostname**
   (`<service>-<id>.sh.run.tcloudbase.com`). It is not reachable as a path under
   the environment's service domain.

**Therefore the architecture's `/api/ai/*` path scheme is superseded by
reality:** the assistant's server lives on a separate origin. This is the
"separate origin" resolution the MIU 0 runbook listed as Option B, and CloudRun
chooses it for us.

### Consequence that must propagate into the design

The widget will call a **different origin** from the website. That makes CORS a
real requirement rather than a formality, and the short-lived conversation
credential travels cross-origin.

Surfaces to update (per README's Normative Surface Index):
- `CHANNEL_AI_ASSISTANT_ARCHITECTURE.md` §6 route table — the paths are on the
  assistant's own host, not the website's `/api`.
- `MIU_BREAKDOWN.md` MIU 2a — the gateway-precedence probe is answered; the
  remaining work is CORS origin configuration and recording the frontend API
  origin the widget compiles against.
- `SECURITY.md` §2 — the trust-zone diagram gains a cross-origin hop.

---

## Cleanup

The `ai-probe` service is still deployed. It is a throwaway and can be removed:

```
manageCloudRun action=delete serverName=ai-probe
```

Its generated source was removed from the repo after the evidence was taken.
