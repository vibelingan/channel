# AI CloudRun deployment execution — 2026-09-15

## Scope and preserved work

Deploy `ai-bff` and `ai-worker` from `feat/ai-assistant-platform-design` into
customer environment `diversity-123-d9grnqfux221323bb` in Shanghai. PostgreSQL
and CloudRun networking are already provisioned; no database purchase or
resource recreation is part of this run. The remote KB remains external at
`https://kb.supplychainsai.com`.

The local checkout was fast-forwarded from `7ffe723` to
`5f6099fafa716d88df87fbabe380ee2eb684b348` (110 commits). Existing uncommitted
human-support design documents were preserved and are not part of the deploy.

## Verified before deploying

- GitHub environment `test` permits the **tag** pattern `ai-cloudrun-deploy-*`;
  this is a deployment permission, not an HTTP path-routing rule.
- Required secret names and deployment variables exist in that environment.
  Secret values were not retrieved or printed.
- The branch's [CI run](https://github.com/vibelingan/channel/actions/runs/34929418978)
  succeeded.
- HTTPS KB `/api/ping` returned 200. The deployment job's authenticated KB probe
  also succeeded before it attempted to upload the application.

## Attempt 1: failed before the remote image build

- Tag: `ai-cloudrun-deploy-20260915-1`, commit `5f6099f`.
- [Deployment run](https://github.com/vibelingan/channel/actions/runs/34933157614).
- Test job passed, including PostgreSQL-backed AI tests.
- Deploy failed in `manageCloudRun`: the allowed working directory was the
  repository's `config/` folder, so the staged build directory was outside it.

Root cause: mcporter 0.13.13 defaults a stdio server's working directory to the
configuration file's directory. The deploy's `--root` argument does not override
that server working directory. This was independently reproduced using the
installed mcporter normalizer, not inferred solely from the CI error.

Fix: declare `cwd: ".."` in `config/mcporter.infra.json`. This keeps CloudBase's
path-containment protection enabled and puts its boundary at the repository
root. The functions/site MCP configuration is unchanged. Added a regression
contract test that failed before the change and passed afterward.

Related correction: MCP errors may contain URL-encoded issue links with supplied
parameters. Redact URI-encoded secret values as well as plain/JSON forms, and
redact **before** truncating diagnostics. A failing regression test confirmed the
encoded-value gap. No secret-bearing issue link was opened or submitted.

Verification after these corrections: 38 deployment/manifest tests passed;
the real installed mcporter normalizer now selects the repository root.

## Acceptance still to record

The next attempt must complete both remote builds, verify the deployed VPC and
access configuration, confirm BFF readiness, and receive a real answer through
BFF → PostgreSQL → worker → hosted KB. A started workflow or CloudRun `normal`
status alone is not completion. Website-widget activation is a separate check;
it has not been claimed from an API-only test.
