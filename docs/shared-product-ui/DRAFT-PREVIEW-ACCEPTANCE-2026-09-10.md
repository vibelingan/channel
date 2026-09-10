# Untouched Alibaba draft acceptance — 10 September 2026

Baseline: `fix/alibaba-sync-storage-wiring@b0b0767`; live test `caf7e8d`.
This follows the customer's rejected Admin acceptance, not a new product design.

## Reproduced defects and repair

1. Live “Surround Sound Wired Headset with Microphone for Gaming Luminous Over
   Ear Headphones Gamers”, external ID `AAFNBBhgAOVTpOKZBnRh_lfS`: list showed
   unavailable / blank MOQ, while its stored source review displayed MOQ 10 and
   USD 6.00–7.89. This is a projection/read-path mismatch, not evidence that
   Alibaba returned no price. Admin now labels available source evidence when
   the legacy projection is absent; manual pricing remains authoritative.
   A second live check of the screenshot's first row, EB1 / external ID
   `AAEVBBhgAOVTpOKZBnRTvUv1`, found the same mismatch: source review already
   showed MOQ 7 and USD 2.52–4.89 while the list still showed unavailable.
2. That draft's Prepare detail review failed. Local reproduction showed the sync
   materializer omits `imageIds`, but review validation required the array. Treat
   an omitted array as an empty review gallery; null/malformed values still fail.
   Publishing without an image remains rejected by product publication validation.
3. Preview still composed the old compact grid and flattened description rather
   than the new detail component. It now uses the shared validated DTO and actual
   buyer layout in a wide, viewport-bounded native dialog. Technical preparation
   buttons are removed; source preparation happens behind Preview. Viewing does
   not approve, publish, mark reviewed, import images or submit an inquiry.

Escape cause: earlier acceptance sampled previously edited/published products,
not the untouched materialized draft state, and checked Edit rather than Preview.

Public product `0aa9d459-159c-4ffa-a5c0-db9a8e7c642f` was also reread through
`/api/products/{id}/detail?view=sections`: `websitePricing.basis=website-manual`,
MOQ 1000, one tier starting at 1000 with `unitAmountMinor=380`, currency USD.
That visible single tier is the approved manual website price, not evidence of
the renderer truncating an Alibaba three-tier response. This release preserves
the values and corrects the manual table's misleading source-price column label.

## Local evidence

- New imageIds regression was observed failing before the shared-schema fix.
- Production-build formal browser runner: 41 public checks + 19 catalog checks +
  2 real API/DB journeys passed. The added journey uses an untouched draft, three
  source tiers, 55 configurations, source gallery, pagination, injected transient
  failure/retry and 320–1440px modal geometry. It verifies no publication, approval,
  review acknowledgement or image attachment was caused by preview.
- Existing normal-route buyer RFQ and persistent Admin follow-up passed again.
- Desktop/mobile preview captures were visually inspected. Fixture image bytes
  are synthetic; real customer-image acceptance must still be done after release.
- Full workspace tests: 1,477 passed; after the additional no-referrer regression,
  the final site suite passed 365 tests. Workspace/E2E typechecks and lint passed.
- Final baseline production-build lane: 76 passed; final formal lane: 62 passed.
  Logs: `/tmp/channel-draft-unit-tests.log`, `/tmp/channel-draft-site-final.log`,
  `/tmp/channel-draft-baseline-browser.log`, `/tmp/channel-draft-formal-final.log`.
  One earlier local baseline attempt collided with the full workspace test's Astro
  build cache; the lanes were rerun sequentially. That build failure was not waived.
- Release evidence is still pending below. No direct cloud deployment is allowed.

## Release trace

- Fix commit: `18a7f3e94bb29c2745d512ba2a327162fd1637a7`.
- Feature CI [34428818272](https://github.com/vibelingan/channel/actions/runs/34428818272)
  passed: 1,478 unit assertions, 76 baseline browser checks, 62 formal-route checks.
- [PR #39](https://github.com/vibelingan/channel/pull/39) merged into **test only**
  as `9eabedab567fa41aac4a77e75f2fba0208b8a275` after that CI succeeded.
- [Deploy Test 34429504839](https://github.com/vibelingan/channel/actions/runs/34429504839)
  reruns full CI at the merge SHA before any deployment. Completion and live
  acceptance are pending; a merge alone does not establish delivery.

## Follow-up found by live browser acceptance

At `9eabeda`, both screenshot drafts opened the shared preview successfully.
The gaming headset has five loaded images, two configurations and four tiers:
10–99 / USD 7.89; 100–499 / 6.89; 500–999 / 6.57; 1000+ / 6.00.
Selecting Red and quantity 100 returned USD 6.89; quantity 9 returned below-MOQ.
EB1 has four loaded images, three configurations and four tiers:
7–99 / USD 4.89; 100–499 / 3.72; 500–999 / 3.31; 1000+ / 2.52.
The desktop preview measured 1440px wide. Close/actions remained in the viewport
after scrolling supplier notes. No product was published or marked reviewed.

Live Edit still used the old effective-price block for untouched drafts, despite
the list and Preview now showing existing source prices. A new failing regression
captured this contradiction. The follow-up reuses the same private source fallback
in Edit and presents the existing source-tier component in place of the unavailable
legacy block. Explicit manual prices and missing-source guards remain unchanged;
the fallback does not write source evidence into manual overrides or public DTOs.
The extended production-build formal lane passed all 62 checks, including Edit
price visibility and close-without-write. Follow-up release is pending.

## Domain / mailbox investigation (read-only)

TCB HTTP gateway has both `supplychainsai.com` and `www.supplychainsai.com`
enabled with normal certificates/status, and both website routes use `channel-test`.
DNSPod has 11 active records, including root CloudBase CNAME, two MX records
(`5 mxbiz1.qq.com`, `10 mxbiz2.qq.com`) and SPF `include:spf.mail.qq.com`.
The website domain is not currently replaced by a mailbox hostname.

Google and Cloudflare DNS-over-HTTPS returned the MX records. The initial local
resolver query returned only the website CNAME for MX/TXT; a later local query
returned MX correctly. This is inconsistent resolution, not proof that records
were absent or the mailbox never works. DNSPod explicitly warns that root CNAME
plus MX/TXT can be resolved differently by recursive caches:
https://docs.dnspod.cn/dns/help-type/

DNSPod's CNAME flattening is intended for this case, but the actual account is
Free and the panel requires Enterprise/Ultimate. No upgrade or DNS change was
made. A controlled change would enable flattening **only for @**, preserving
CloudBase targets and existing MX/SPF, then check HTTPS/certificates plus MX/TXT
from multiple resolvers. Its documented 1600ms fallback can still return CNAME;
it is mitigation with a provider caveat, not an absolute delivery guarantee.
https://docs.dnspod.cn/dns/cname-flattening/

If that paid option is unacceptable, plan a separate move of authoritative DNS
to an apex-flattening provider, preserving all 11 records and testing before the
NS switch. Do not hardcode a currently observed CDN IP or replace the website
CNAME with a mail hostname. Either path needs the owner's cost/migration choice.

DMARC still contains `rua=mailto:your@supplychainsai.com`; this is a placeholder,
not the verified sales mailbox. No DKIM selector appears among these 11 records.
Mailbox existence/alias, DKIM provisioning and actual send/receive remain unverified
and require QQ enterprise-mail admin access. Footer sales@ is contact content;
changing it does not create a mailbox or configure notification SMTP.
