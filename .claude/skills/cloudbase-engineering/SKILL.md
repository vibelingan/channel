---
name: cloudbase-engineering
description: |
  Tencent CloudBase (TCB) deploy and runtime facts measured in production: what each
  SDK/MCP/CLI call really costs from outside mainland China, how @cloudbase/manager-node
  uploads hosting files and function code, how to skip unchanged function code safely,
  how to provision NoSQL collections cheaply, and the cleanup/consistency timings that
  make deploys fail red after succeeding. Use when writing or speeding up a CloudBase
  deploy, a hosting upload, a function code update, a regional (in-Shanghai) helper
  function, or `npx mcporter` calls against CloudBase MCP.
  Trigger keywords: CloudBase, TCB, tcloudbase, @cloudbase/manager-node, cloudbase-mcp,
  mcporter, hosting.uploadFiles, uploadFilesCustom, getFunctionUploadUrl, updateFunctionConfig,
  readNoSqlDatabaseStructure, ap-shanghai, SCF, COS from GitHub runners.
license: MIT
metadata:
  version: "0.1.0"
  source-project: channel (2026-11-05 deploy speed-up, PRs #73–#75)
  general-rules: engineering-craft/categories/deploy-performance
---

# CloudBase engineering

General speed and safety rules live in engineering-craft (`deploy-performance`,
`deploy-delivery`). This skill holds only CloudBase-specific facts, each with the run
it was measured in. Project-specific values (environment ids, domains, accounts) stay
in each project's own `docs/agents/cloudbase.md`.

## Before changing a CloudBase deploy

1. Read the last real run's step timings and per-call log lines
   (see `references/measured-costs.md` for what normal looks like).
2. Count calls: from US runners every CloudBase API or gateway request costs 0.6–3 s,
   and every `npx mcporter call` costs ~2.9 s including process start.
3. Find the byte movers: a US→ap-shanghai link carries ~350 KB/s in total, whether
   8 or 32 connections are used.

## Facts (details and sources in references/)

| Topic | Fact | Consequence |
|---|---|---|
| Hosting upload | `hosting.uploadFiles` does a bucket lookup (~0.3–0.5 s) and builds a new COS client each call; one ~100 KB file then takes 4–5 s | Upload a whole batch in one call with `parallel` = batch size |
| Link speed | ~22–40 KB/s per connection, ~350 KB/s aggregate to ap-shanghai | Parallelize to the cap; large transfers cost ≥4 min per 83 MB |
| MCP storage upload | `cloudbase.manageStorage upload` is a single stream inside cloudbase-mcp (9 MB ≈ 2–5 min) | Use the COS SDK `uploadFile` with `AsyncLimit` for big objects |
| Function bundles | Builds that `define` the commit/time differ on every commit | Prove equality after restamping against the running package before uploading |
| Function config | `updateFunctionConfig` replaces env vars wholesale | Any marker you add must be written on every deploy |
| NoSQL provisioning | Each `checkCollection`/`listIndexes`/`getResourcePermission` is one MCP spawn | Re-read only after a write; check 4 collections at once |
| Function deletion | `deleteFunction` can stay listed > 8 s | Poll to ~60 s before calling cleanup unconfirmed |
| mcporter | `npx mcporter` without a pin runs whatever is latest | Pin the version in the project |

## References

- `references/measured-costs.md` — the numbers above, with run ids and how to re-measure.
