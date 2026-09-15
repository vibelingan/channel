# DNSPod Enterprise Activation Check

Date: 2026-09-15. Domain: `supplychainsai.com`.

## Current Result

The purchased enterprise plan is bound to the correct domain, and public NS
answers match the enterprise nameservers. CNAME flattening is not yet proven
enabled. Purchasing the plan does not by itself establish that the root-only
flattening configuration has been added.

Read-only MCP evidence:

- `DescribeDomain`, domain ID `99560006`, grade `DP_EXPERT`, title enterprise.
- Service term: 2026-09-14 16:11:40 through 2027-09-14 16:11:40 (API display).
- Required nameservers: `ns3.dnsv4.com`, `ns4.dnsv4.com`.
- API DNS status: `dnserror`; `ActualNsList` empty. This conflicts with public
  NS answers and must not be treated as proof that the site is unreachable.
- `DescribeRecordList`: 13 enabled records, including 2 system NS records.
  No records were changed, deleted or recreated.

Independent Google and Cloudflare DNS-over-HTTPS answers:

- NS: both required enterprise nameservers.
- A: root CNAME to `supplychainsai.com.tcbaccess.tencentcloudbase.com`, followed
  by destination A records. Do not replace the CNAME with those transient IPs.
- AAAA: root CNAME; no destination IPv6 answer in this check. Absence of IPv6
  alone is not a website fault.
- MX: priority 5 `mxbiz1.qq.com`, priority 10 `mxbiz2.qq.com`.
- TXT: `v=spf1 include:spf.mail.qq.com ~all`.
- DS: no published DS answer from either resolver.

The root still returning CNAME is not conclusive proof of a disabled setting:
DNSPod documents a CNAME fallback if flattening recursion exceeds 1600ms. The
configuration itself and repeated A/AAAA/MX checks must be inspected together.

## Required Console Step

The authenticated MCP supports domain/record inspection, but the inspected public
DNSPod SDK/API did not expose a documented flattening-management operation.
`CNAMESpeedup` is a separate feature and must not be toggled as a substitute.
The DNSPod console opened in this session redirects to Tencent account login.
Account login must be completed by the owner directly, without sharing a
password, token, MFA code or browser cookie in chat.

After login:

1. Open this domain's settings and inspect the CNAME flattening list and the
   global all-CNAME toggle. Save the original state before any change.
2. If absent, add **only host `@`**, with all lines selected. Leave the global
   all-CNAME toggle off. If already present, inspect its enabled state and do
   not create a duplicate.
3. Preserve every current DNS record, including `www`, mail verification,
   `_dnsauth`, `_dmarc`, `kb` and `marketagents`. No NS migration is necessary
   merely because the cached API status has not caught up.
4. Re-read the setting and record list; confirm the intended root-only rule.
5. Query both public resolvers for A, AAAA, MX and TXT; inspect the authoritative
   nameservers as needed. Account for current TTL and documented fallback.
6. Check HTTPS and the Admin login page on root/www, certificate binding and
   existing subdomains. Preserve TLS validation/renewal DNS records.
7. Verify real two-way mail with the confirmed sales mailbox and an external
   mailbox. DNS results do not prove mailbox existence, DKIM signing or delivery.

## Mail and Release Boundaries

- Existing DMARC uses monitoring (`p=none`) and a `your@` report destination;
  ownership/existence of that destination is unverified. Do not invent a
  replacement mailbox or change enforcement without mail-owner confirmation.
- No DKIM selector appeared in the inspected record list. The actual selector
  and public key must come from the enterprise mailbox console, not a guess.
- Root flattening does not enable website notifications, provision a mailbox,
  repair SMTP credentials, or validate password-reset email delivery.
- No DNS write, NS change, certificate replacement or mail configuration change
  was performed in this check. DNS closeout remains pending account access.

## Official References

- [DNSPod CNAME flattening](https://docs.dnspod.cn/dns/cname-flattening/).
- [Tencent CNAME flattening](https://cloud.tencent.com/document/product/302/115536).
- [DescribeDomain](https://cloud.tencent.com/document/api/1427/56173).
- [DescribeRecordList](https://cloud.tencent.com/document/api/1427/56166).