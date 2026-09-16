# Source image fetch policy

The workbook hands us URLs a supplier controls, and the importer runs
server-side. That combination is a server-side request forgery primitive, and a
resource-exhaustion one, unless every hop and every byte is checked.

Implementation: `apps/functions/admin/src/catalog-import-media.ts`.
Tests: `catalog-import-media.test.ts` (25 tests), each supplying an input that
actually violates the control under test.

## Address validation — every redirect hop, not just the first

| Control | Behaviour | Test |
|---|---|---|
| Scheme | only `https:`; `http:` refused | "refuses plain http" |
| DNS resolution | every returned address inspected; **any** private address refuses the host | "resolves to any private address" |
| Unresolvable host | refused, not retried blindly | "does not resolve" |
| Redirects | followed **manually**, max 3, with the full address check re-run on **each hop** | "re-checks the address on every redirect hop" |
| Redirect without `Location` | refused | covered by `http-error` |

Blocked ranges: `0/8`, `10/8`, `127/8`, `100.64/10`, `169.254/16` (cloud
metadata), `172.16/12`, `192.168/16`, `192.0/24`, `198.18/15`, everything from
`224/4`; IPv6 `::`, `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, and
IPv4-mapped forms such as `::ffff:169.254.169.254` judged as the IPv4 they
carry. Anything that is not a parseable IP is refused.

The redirect check is the one that matters most: a filter that validates only
the original URL is defeated by a public host that 302s to `127.0.0.1`. The
test asserts exactly that scenario is refused.

## Transfer limits — streamed, not buffered

`Content-Length` is a claim, not a guarantee. A hostile or broken server can
declare 1 KB and stream forever, so:

| Control | Behaviour | Test |
|---|---|---|
| Declared length over 10 MiB | refused before any transfer | "declared" branch |
| Actual stream over 10 MiB | **connection aborted mid-transfer**, chunk by chunk | "aborted mid-transfer" |
| Lying `Content-Length` | caught by the streamed cap | "lying Content-Length" |
| Request timeout | 10 s, `AbortController` | `timeout` reason |
| HTTP error status | reported, never thrown | "reports an HTTP error" |
| Network failure | reported, never thrown | "reports a network failure" |

The body is read through the stream reader with a running total; exceeding the
cap aborts the request rather than draining it. Buffering first and checking
afterwards would mean the memory was already spent.

## Content validation — bytes, never headers

| Control | Behaviour | Test |
|---|---|---|
| Content type | determined by **magic number**; the supplier's `Content-Type` is never trusted | "trusts magic bytes, not the header" |
| Accepted | JPEG, PNG, WebP only | "three catalog image types" |
| Refused | SVG, HTML, PDF, GIF, BMP, ZIP, ICO — each served as `image/png` in the test | "vector, document and markup payloads" |
| Pixel dimensions | read from the **file header**, no decode | "dimensions are read from the header" |
| Max pixels | 40,000,000 | "a pixel bomb is refused" |
| Max single side | 20,000 | "a single oversized side" |
| Zero/negative dimensions | refused | "a zero-dimension image" |
| Dimensions not locatable | refused, not assumed safe | "cannot be located is refused" |
| Content hash | SHA-256, used to store identical bytes once | "hashes the bytes" |

Dimension limits exist because byte limits are not sufficient: a 300 KB PNG can
declare 30,000 × 30,000, which is 900 megapixels and gigabytes of RAM for
anything that later resizes it. The header is read directly — PNG `IHDR`, the
JPEG SOF marker chain, and all three WebP frame encodings (`VP8 `, `VP8L`,
`VP8X`) — so nothing is decoded to find out.

SVG is refused even though it is an image format: it is a document that can
carry script, and it has no place in a product gallery.

## Failure is per-image

One unreachable, oversized or wrong-type URL costs that image and nothing else.
The product still imports, the URL stays retryable, and the failure is counted
in the job summary. That was verified on the real workbook: a bounded publish
migrated 12 real images with zero failures, and a separate run against
unreachable fixture URLs produced 6 failures with all products still imported.

## Bounded by default

Nothing downloads the whole catalog implicitly. The publish path takes an
explicit image budget, and `--probe-images <n>` (max 25) performs a
reachability check that stores no bytes and prints no URL — only a per-host
label, the sniffed type, the byte count and a hash prefix, so the output is
safe to attach to a review.

## Real-world result

Six distinct source images probed through the full policy: 6/6 reachable,
64–292 KB, one host. All six were served as **PNG or WebP regardless of the
URL's extension**, which is precisely the case magic-byte sniffing exists for.

## Not in scope for this phase

Migration into the CloudBase private media lifecycle. Images are written to the
local media directory through the same `MediaStorageAdapter` seam production
uses; swapping the adapter is the production step, tracked in
`REMAINING-PRODUCTION-STEPS.md`.
