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

## Attempt 2: the caller timed out at 60 seconds

- Tag: `ai-cloudrun-deploy-20260915-2`, commit `a2e87d2`.
- [Deployment run](https://github.com/vibelingan/channel/actions/runs/34933670912).
- Full test job and authenticated KB probe passed. Local script tests also
  passed (197/197).
- The working-directory rejection was resolved. `manageCloudRun` then exceeded
  mcporter's default 60-second call timeout. The outer Node child-process
  timeout was five minutes, but did not configure the nested MCP client.
- MCP 2.34.3 uploads the code and waits up to 45 seconds for task registration,
  in addition to its other API requests; it does not wait for the full build.

Correction: set the MCP request timeout explicitly to 240 seconds, below the
300-second enclosing process timeout. Before submitting another upload, query
the existing service and wait for any prior task to settle. A timeout is not
proof that the cloud task was canceled. Never use force deployment or recreate
a service to work around an ambiguous response. Focused tests: 40/40 passed.

Local MCP device authorization also needs a persistent MCP process: the tool
returns the login URL before its background credential polling finishes. A
one-shot process cannot complete that flow. Keep the login process alive until
authorization succeeds; CI deployments use the existing GitHub secrets and do
not depend on this local session.

## Attempt 3: both builds succeeded; network read-back gate failed

- Tag: `ai-cloudrun-deploy-20260915-3`, commit `38bfd44`.
- [Deployment run](https://github.com/vibelingan/channel/actions/runs/34934166974).
- `ai-bff`: build `2604485285`, deployment `001`, `normal` at 05:55:43 UTC.
- `ai-worker`: build `2604485296`, deployment `001`, `normal` at 05:56:33 UTC.
- The post-deployment contract could not read the desired VPC/subnet from
  `ServerConfig.VpcConf`. This is not yet proof of either successful database
  connectivity or an actual missing binding. Do not bypass the gate.

A tag named `ai-cloudrun-deploy-inspect-*` now uses the same credential-scoped
workflow for **read-only** service metadata, liveness/readiness and process-log
inspection. It skips the billable KB probe and returns before the deployment
path. This lets the CI credential inspect the live state without rebuilding or
requiring local login. An inspection run finishing is not a deployment PASS.

## Inspection 1: missing VPC binding confirmed

- Tag: `ai-cloudrun-deploy-inspect-20260915-1`, commit `ead7972`.
- [Read-only inspection](https://github.com/vibelingan/channel/actions/runs/34935095119)
  succeeded; this is not deployment acceptance.
- Both services have a present `ServerConfig.VpcConf` with all four fields
  empty: `VpcId`, `SubnetId`, `VpcCIDR`, `SubnetCIDR`.
- BFF URL: `https://ai-bff-298020-11-1443560658.sh.run.tcloudbase.com`.
  Independent local HTTP requests confirm liveness 200 and readiness 503
  (`starting`). The worker retains VPC-only ingress; public egress remains
  enabled for the external KB.

Correction: resolve the configured VPC and subnet through read-only
`DescribeVpcs` / `DescribeSubnets`, validate that the subnet belongs to that
VPC, and supply the complete four-field binding. The
[official deployment CLI](https://docs.cloudbase.net/cli-v1/cloudrun/deploy)
requires both IDs and CIDRs. CIDRs are taken from cloud inventory, never guessed.
A dedicated `ai-cloudrun-deploy-network-*` tag updates only `VpcConf` on the
existing services: no image rebuild, no environment replacement, no change to
public/private access controls. Normal future deployments also use the complete
binding. Read-back and runtime acceptance remain mandatory.

The network-only run is
[34935924769](https://github.com/vibelingan/channel/actions/runs/34935924769),
tag `ai-cloudrun-deploy-network-20260915-1` at `4e90b7c`. Its complete test job
and authenticated KB probe passed. The configuration update's final outcome
failed: the API accepted both updates and BFF version `002` appeared, but its
VPC remained empty for the entire ten-minute read-back window. Supplying CIDRs
alone did not fix the binding. Read-only inspection additionally queries
[`DescribeServerManageTask`](https://cloud.tencent.com/document/product/1243/76021)
for the exact management-task state and failure reason; it does not retry a
mutation or expose environment values.

Inspection `34936764277` confirmed BFF `002` is normal but still returns
readiness 503. Its new task-diagnostic helper then hit a local script bug
(`env` was scoped inside `main`). This diagnostic failure did not mutate cloud
state. A VM execution regression reproduces that exact ReferenceError; the
helper now reads the explicit process environment and inspection includes
`InternalAccess` as well as the VPC fields.

## Inspection 3: the network switch is closed

[Inspection 34937282796](https://github.com/vibelingan/channel/actions/runs/34937282796)
completed successfully at 06:34 UTC. Both services are on version `002`.
Management tasks `2155706` (BFF) and `2155710` (worker) are `finished`, with no
failure reason, but both configurations show `InternalAccess: "close"` and
empty `VpcConf`. This was not an unfinished background update.

The [official API schema](https://cloud.tencent.com/document/product/1243/75713)
defines `InternalAccess` as the `open | close` intranet switch. Correction:
submit `InternalAccess: "open"` **together with** the complete VPC binding,
and require that switch in read-back acceptance. Keep `OpenAccessTypes`
unchanged (public BFF, VPC-only worker) and retain public egress for the KB.
Three regression assertions failed before this correction and passed after it.
The live result is still to be recorded below.

## MCP transport defect: CIDRs stripped before the API call

While the switch update ran, inspection of the pinned CloudBase MCP 2.34.3
input schema found a concrete transport defect: `serverConfig.VpcConf` declares
only `VpcId` and `SubnetId`. Its Zod object strips unknown keys. Executing the
extracted schema with a four-field fixture returned **only the two IDs**.
The update implementation can handle CIDRs, but its input boundary removes
them first. The earlier conclusion that the closed switch alone explained
the failure was therefore incomplete.

Correction: route the network patch through `callCloudApi` using the official
`tcbr / SubmitServerConfigChangeDiff / 2022-02-17` contract. The reviewed Items
contain only `InternalAccess` and the full `VpcConf`; credentials, images and
public ingress are untouched. Normal source deployments also repair a missing
binding through this route before acceptance, so the next deployment cannot
silently regress. Focused tests: 28/28 passed. Live result remains pending.

The current production website was inspected separately in a real browser:
it contains neither the assistant island nor its launch button. Backend release
does not automatically enable the website widget.

## Acceptance still to record

Both remote builds have completed. The next attempt must verify the deployed VPC and
access configuration, confirm BFF readiness, and receive a real answer through
BFF → PostgreSQL → worker → hosted KB. A started workflow or CloudRun `normal`
status alone is not completion. Website-widget activation is a separate check;
it has not been claimed from an API-only test.
