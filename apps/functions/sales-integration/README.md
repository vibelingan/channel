# Sales integration read API

Private server-to-server access to stored Channel inquiries, approved product details, and finalized OEM attachments. The entry uses the shared sales access controller; it does not use an admin token or the public website assistant's identity.

This is a **standalone HTTP Function**, Nodejs20.19, listening on port 9000. It is excluded from the existing admin/public-api/sync deployment manifest. Build with `pnpm --filter @vibelingan-channel/fn-sales-integration build`, then `package:artifact` and `check:artifact`; `dist/package` contains index.js, an executable scf_bootstrap, and a minimal CommonJS package.json. No deployment is performed by these commands.

## Configuration

The runtime is closed unless SALES_INTEGRATION_ENABLED=1. When enabled it requires TCB_ENV, SALES_CLIENT_ID, SALES_BUSINESS_LINE, SALES_INSTALLATION_ID, SALES_ENVIRONMENT (test or production), and SALES_STORAGE_HOSTS (comma-separated exact HTTPS storage hostnames; no wildcard). CATALOG_DETAIL_APPROVAL_ENABLED=1 is also required for current-product queries. Saved inquiry snapshots do not change when current products change.

One service process uses one customer installation and one CloudBase environment. Do not change the global DB adapter per request to multiplex customers. The environment must belong to that installation. Legacy records have no tenant column; this implementation must not be enabled on a database containing unattributed records from multiple customers.

Provision a private NoSQL collection channelSalesBindings, with document ID equal to SALES_INSTALLATION_ID and a registry field containing the shared client-bindings schema. Application users and public assistants must have no direct access to it. The runtime rereads this document on every authorization check; it does not cache authorization configuration. Connection credential references resolve only to env:UPPERCASE_VARIABLE_NAME, containing distinct random service tokens of 32 to 512 base64url characters. Registry revocation/disable takes effect on subsequent calls and prevents release of in-flight read results. Advance control_epoch on authorization changes. Runtime, storage hosts and gateway limits require live verification before enablement.

## Request protocol

Every business request includes Authorization: Bearer <service token>, X-Sales-Connection-Id, and X-Sales-Context. The context is base64url of JSON containing client_id, business_line, source_installation_id, runtime_id, environment and control_epoch. These are consistency checks against the authenticated binding, never a source of permission. Customer/installation/environment/business must also match the fixed service configuration.

| Method and path | Behavior |
|---|---|
| GET /integrations/sales/inquiries/oem/:id | Allowlisted stored OEM requirements and contact; finalized attachment references |
| GET /integrations/sales/inquiries/product/:id | Stored buyer fields and original approved product snapshot; current-product changes do not replace it |
| POST /integrations/sales/products/query | JSON `{ "ids": [{ "id": "product-id", "revision": "approved-revision" }], "page": 1, "page_size": 20 }`; at most 5 products, 50 variants per page |
| GET /integrations/sales/assets/:ref | Authenticated OEM file bytes for the exact inquiry revision, never a storage URL |

The /api prefix and stripped gateway prefixes are supported. Unknown paths return 404; unsupported methods return 405. There is no list cursor, task creation, inquiry mutation, approval or sending route in this module. Product queries return the existing approved reader's ApiResult for each requested ID; callers must handle unavailable/stale results. Free-text product search remains with the existing catalog tools.

Private JSON responses are no-store and vary by connection and context. References are opaque addresses, not bearer credentials. Attachment access verifies the owning inquiry, active/purpose/owner metadata, environment/path, exact size and SHA-256, and rereads the source after download. Pending, failed, legacy inline or foreign-owner files are unavailable. The provider-signed URL stays inside the server; downloads use only configured HTTPS hosts, reject redirects, enforce a 10-second timeout and stop reading after the existing 10MiB OEM limit. Content-Disposition forces download, with nosniff and CSP sandbox.

[SCF limits each HTTP response body to 6MB](https://cloud.tencent.com/document/product/583/56124). This API returns at most 4MiB of attachment bytes per response. Files up to 4MiB support a normal GET; larger files return 413 ASSET_RANGE_REQUIRED with max_range_bytes and total_bytes. Use a single closed Range header, for example `Range: bytes=0-4194303`, then consecutive ranges on the same ref. A valid range returns 206 with Content-Range and Accept-Ranges; oversized ranges return 413, invalid/suffix/open/multiple ranges return 416. Each request repeats authorization and full-object integrity checks. Assemble the ranges and compare the complete SHA-256 with the inquiry asset metadata; a changed source/ref returns 409 and must be reread. The actual CloudBase gateway still requires deployed verification.

A successful read does not authorize task dispatch or email sending. OEM finalization markers and reliable handoff belong to SG1.2. Real Hermes runtime/connection testing and isolated mail delivery are separate acceptance stages, recorded in the sales design evidence.


## Mandatory task gate (SG1.3)

Every private read now also requires `X-Sales-Lease` and `X-Sales-Task`. The lease is canonical base64url of 32 random bytes (43 characters); the server uses SHA-256 of the decoded bytes to look up the record. The task header is canonical base64url UTF-8 strict JSON with protocol `sales-auth/1`, task_id, run_id, task_revision and a request_id of 16-128 safe characters. Identity and permission still come from the authenticated connection and server stores. Caller-supplied permits are ignored.

Required control configuration: `SALES_HERMES_AUTH_URL` must point to the fixed HTTPS `/sales/authorize-read` endpoint; `SALES_HERMES_AUTH_TOKEN` is a separate customer/control-purpose server credential. HTTP is permitted only for 127.0.0.1 in the test environment. The client refuses redirects, bounds responses to 16KiB, rejects duplicate JSON keys and has a 3-second deadline.

Additional server-owned records (SDK `_id` metadata stays outside the `record` payload):

| Collection and document key | `record` value |
|---|---|
| channelSalesInstallations / fixed installation ID | exact client_id, business_line, source_installation_id, environment, cloud_env_id and state=active |
| channelSalesTaskLeases / SHA-256 of decoded token bytes | validated TaskReadLease |
| channelSalesSourceHandoffs / handoff_sha256 | validated SourceHandoff |

No public route creates or edits these records. Source/lease issuance, their storage provisioning and the authenticated Hermes control endpoint belong to subsequent modules; they are not created or deployed by this unit. Missing records or an unavailable control service fail closed. Production remains disabled until those components and target-environment acceptance are complete.

The reader validates local records before and after the remote permit roundtrip, and repeats authorization after data preparation/source revalidation. It rejects stale task/run/revision, changed source facts, revoked records and out-of-task attachments. Business closure blocks preparation even if Hermes has not observed it yet. No positive permission is cached across requests. As in D1, already returned data cannot be recalled; this is not a cross-service atomic revocation guarantee.

Legacy records lacking explicit client/business/installation ownership are no longer implicitly accepted. A later verified ownership mapping may support them; this unit does not migrate or relabel existing rows. OEM reads also require server-written salesSubmissionState=finalized and salesSubmittedRevision matching the projected source revision; the producer hook is still pending. Existing website/admin routes and original data are unchanged.

Default product queries continue to use the current approved reader, without an old revision. Submitted product facts remain historical. Range download limits and integrity checks are retained; malformed Range syntax fails the strict task contract with 403, while syntactically valid but unsatisfiable ranges still return 416 after authorization.
