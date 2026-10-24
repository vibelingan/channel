# Alibaba Wiring Closeout: Verification and Merge Hold

Date: 2026-09-15

## Decision

R1-R3 fixes are implemented locally, with focused-test evidence reported in the
September 15 handoff. The user approved fixing, publishing and merging on September 15.
Full final validation is still running; those authorized delivery actions remain
conditional on passing validation and review, and have not been performed yet.
The remaining gate is final-tree validation and independent review, not a new
request to approve the already implemented R1 design. The earlier cloud acceptance
applies only to the previously deployed release, not these final fixes.

The implementation and evidence record is
[EXECUTION-2026-09-15.md](EXECUTION-2026-09-15.md). This documentation update read
current source and selected saved logs; it ran no commands, tests or cloud calls.
Branch/index, approval, DNS and PR state below are the caller's September 15
handoff facts, not fresh Git or API inspection by this documentation pass.

## Branch Authority

- Feature branch: `feat/alibaba-wiring-closeout`.
- Worktree: `.claude/worktrees/alibaba-wiring-main`.
- Starting HEAD: `78506d525eefcd6410ff0d85a1a020d834f4ab02` (`origin/main`).
- The reported reconstruction contains 471 staged files, not a new commit. It
  excludes test-branch history; do not merge `test` into this feature or main.
- Subsequent changes are closeout fixes only. Preserve existing staged and
  unstaged work; do not reconstruct again or reset the index.
- No test-to-main merge, push, PR creation or main update has been performed.
- Before closeout fixes, the staged tree differed from accepted `9e3de08` and
  wiring `bcee8f2` in only four files: the gate baseline and three SEO documents.
  Those four files retain main's content. Runtime code, fixtures, dependencies,
  workflows and tests matched the accepted version.
- The shared catalog-import and product UI packages are necessary dependencies
  of the accepted Alibaba implementation. This is a large coherent promotion,
  not only the original raw-storage initializer fix.
- AI PR [#53](https://github.com/vibelingan/channel/pull/53), latest reported head
  `5f6099f`, is active and separate. Do not merge it, absorb its changes or treat
  its review/CI as evidence for this feature.

## Executed Cloud Acceptance

Accepted release: `9e3de081180d51494cad3dffb674bef2911387b9`.

| Scope | GitHub Actions run | Result |
| --- | --- | --- |
| Full catalog/Admin/inquiry | [34820973421](https://github.com/vibelingan/channel/actions/runs/34820973421) | 1 selected test passed; 4 media-scope cases intentionally excluded |
| Four-product variant media | [34823965208](https://github.com/vibelingan/channel/actions/runs/34823965208) | 4 selected tests passed; full scope intentionally excluded |

Both workflows passed same-SHA CI and the selected `catalog-acceptance` job.
Deployment was intentionally skipped. The full scope verified zero pending
category assignments, two published six-image galleries, unchanged manual
values/public membership, and a TEST ONLY inquiry completed through Admin with
email disabled. The variant scope verified 3/4/2/1 mapped SKUs and 6/5/5/6
general images across four explicitly audited products; publication membership
and manual values were preserved, with no inquiry or email created.

Additional anonymous live requests independently passed the exact sync release
identity and the exact 404/NOT_FOUND response for both retained draft samples.
Those assertions are now included in the full live acceptance spec.

## Completed Local Implementation

"Implemented" below means present in the current source, not deployed, blessed
or fully validated. Focused passes are reported by the caller; inspected output
and the limits of that evidence are recorded in the execution log.

| Work | Current behavior | Release status |
| --- | --- | --- |
| R1: product/link writes | One shared transaction checks product revision, primary source and exact link identities; unlink clears only Alibaba-owned fields and removes links together. Cloud and local adapters use the same decision logic. | Implemented; final validation pending |
| R1: all source writers | Link, unlink, draft creation/repair, pin, reconciliation and promotion participate. Promotion also checks the lease, the current run's exclusive permission to write. | Implemented; final validation pending |
| Late source snapshot fix | Product/link expectations are captured before source and observation reads, so a newer promotion cannot be overwritten by stale data combined with a newer revision. | Implemented; focused regression present |
| Late frozen-quarantine fix | Approval hashes include product identity, keep the verified expectations through each write, reject legacy source-only hashes and changed identities, and fence the final run-status write. | Implemented; final cloud validation pending |
| Late Admin ACK fix | Acknowledgement, including publish/archive acknowledgement, checks current source identity inside the atomic product save and preserves the first reviewer's acknowledgement. Ordinary edits do not acknowledge a new source. | Implemented; broader final tests pending |
| R2: deploy result checks | Gateway/timer helpers reject negative tool results and malformed readback; final timer comparison includes name, type and schedule. | Implemented with mocked regressions; no live mutation |
| R3: shared test environment | E2E and Deploy Test use `cloudbase-deploy-test` with `cancel-in-progress: false`; YAML regression tests detect partitioning or cancellation. | Implemented; final workflow checks pending |

Quarantine approval is atomic per product, not across the whole batch. If a later
product is rejected, an earlier promotion can remain committed, but the run must
not report approval or send a success alert. Its unchanged old hash then rejects
retry as superseded. Run fresh synchronization and review the resulting candidate;
do not rewrite an old hash to force approval. Approval never applies tombstones,
the proposed removals of supplier listings; a fresh full run must confirm them.

## Validation Boundary

- The earlier handoff recorded passing baseline package/script tests, sync tests,
  typechecks, Biome and SDK checks. Those results predate the latest fixes and
  are historical only. Earlier files named "final" are not final-tree evidence.
- The inspected Admin log demonstrates only its selected acknowledgement cases;
  current tests include additional cases. The inspected quarantine red log
  demonstrates the original stale-approval failure, not a green final run.
- The caller reports focused tests for the implemented fixes and full final
  tests still running. Do not infer completion from a started command, a shell
  wrapper exit code, test source, or an older passing subset.
- Full final static checks, all tests, packaged function runtime checks,
  production build and isolated browser acceptance remain unconfirmed here.
  The final fixes have not been cloud validated.

## DNS and Mail Handoff

These are the caller's read-only inspection results, not changes made here.

| Item | Established result or remaining uncertainty |
| --- | --- |
| DNSPod domain | `DomainId=99560006`, `Grade=DP_EXPERT`; reported service term 2026-09-14 through 2027-09-14 |
| Required nameservers | `ns3.dnsv4.com` and `ns4.dnsv4.com`; public Google and Cloudflare resolver results match them |
| API discrepancy | API still reports `dnserror`; matching public nameservers do not establish why this flag remains |
| Flattening | Public A lookups still return a CNAME chain. Flattening is not proven enabled; plan entitlement and nameserver delegation are not activation evidence |
| Console/API access | Console page `50813` requires the user's login. No documented public flattening API was found in the inspection; do not assume `CNAMESpeedup` is equivalent |
| Preserved records | 13 records: 11 business records plus 2 system NS records. MX priority 5 `mxbiz1`, priority 10 `mxbiz2`, and SPF preserved; no DNS mutation |
| Mail operations | Automatic RFQ (request for quotation) email is deliberately disabled. Manual inquiry handling in Admin can operate; mailbox access and DKIM, the outgoing-mail signature configuration, remain unknown |
| Password reset | Live mail delivery and a usable reset link must still be verified. The deploy script derives `RESET_PASSWORD_URL` from `siteUrl` as `/reset` and passes it into the Admin manifest; the earlier absence claim was false |
| Certificate | Previously recorded expiry was October 18; certificate validity, expiry and renewal need a fresh check. Do not present the earlier record as current verification |

Do not change MX/SPF, enable RFQ notifications, toggle a similarly named DNS
option, or alter console-managed environment ownership to close a documentation
gap. The earlier blanket claim that Alibaba overrides and WECOM configuration
were absent was also withdrawn; manifest-only environment behavior is not a new
reconstruction defect.

## Launch Criteria and Next Action

1. Finish the currently running validation on the final source, including the
   late fixes. Record commands, actual exit/results and source boundary for
   package/E2E typechecks, Biome, all script/package tests and the SDK check.
   The project uses Biome, not an assumed ESLint command. Confirm every intended
   test executed; optional live cases skipped for a chosen scope are not passes.
2. Verify function builds/packaging and artifact runtime smoke, the production
   site build, and isolated local browser acceptance for catalog/Admin and the
   formal inquiry flow. Shared import dependencies must be included. Do not
   substitute unit mocks for a real build or browser run.
3. Obtain independent review of the final source and resolve any findings. Only
   after authorization, commit and bless the exact feature SHA before pushing;
   require same-SHA CI, mergeability and approval on the feat-to-main PR. Preserve
  main ancestry and keep AI PR #53 separate. Delivery is authorized after the gates pass.
4. Use the existing gated test
   delivery path. Verify the actual deployed release identity, then repeat the
   full and variant-media live acceptance scopes on that release. Confirm the
   public catalog, private draft 404s, manual values, media membership and a
   TEST ONLY RFQ handled through Admin with email still disabled. The old runs
   `34820973421` and `34823965208` cannot satisfy this final-release criterion.
5. Before calling the launch operationally ready, verify Admin login and the
   manual inquiry handling owner, and exercise a controlled live password-reset
   email through receipt, correct-host link and successful reset. Record mailbox
   and DKIM status, recheck HTTPS/certificate expiry and renewal, and explicitly
   resolve or accept the DNS API discrepancy/flattening uncertainty. Login to
   page `50813` requires the user; do not guess an API or mutate DNS meanwhile.
6. Keep the separate September 14 Tencent image-delivery/Lighthouse report as
   a serious, owned performance follow-up: long first-screen request chains,
   full-size images, cache behavior and layout shift need measured remediation.
   No image/CDN/performance implementation is included here. Define and approve
   that work separately; functional RFQ acceptance does not prove performance.

Next action: collect the real final-validation results and review the final
tree. Do not repeat already completed R1-R3 implementation or promote an older
passing run into a release blessing.

## Final Review Delta

The multi-source quarantine compatibility fix retains the full frozen identity
check but promotes only the source recorded as primary for that product. Both
source orderings approve exactly once; relinking a secondary source still rejects
the old batch. The focused sync-function suite passed 168 tests. Two independent
final source reviews reported no remaining concrete P1/P2 findings. This is not
a substitute for the frozen full validation or final deployed release checks.

## DNS Account Boundary

DNSPod MCP confirmed the enterprise package is bound and both public resolvers
return ns3.dnsv4.com/ns4.dnsv4.com. Root A requests still include the CNAME chain;
flattening is not proven active. Official public SDK inspection did not expose
a supported flattening-management method; CNAMESpeedup is a different function.
The opened DNSPod console requires interactive account login. No DNS write has
been made, and all 13 returned records are preserved. The account owner must log
in before the narrowly scoped root-only flattening setting can be applied and
verified; no password or login token should be sent through chat.