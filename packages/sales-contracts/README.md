# Sales contracts and access

Server-only sales metadata validation, canonical JSON, an offline mail fake, and connection authorization. No network transport or customer secret is included.

The six JSON schemas under schemas/ are the source for generated TypeScript types and Python metadata validation. The access policy is a TypeScript server component exported as `@vibelingan-channel/sales-contracts/access`; Hermes calls the authenticated Channel endpoint rather than treating Python schema validation as authorization.

`SalesAccessController.execute(request, operation)` loads the current registry, resolves one connection credential, checks the customer/business/installation/runtime/environment/control epoch, then runs the supplied operation. Read results are checked again before release. A registry change during authentication fails closed. Loaders must read authoritative server configuration on every invocation; never capture an unchanging process-local registry for production. No credential or other customer's binding is passed to the operation.

Each connection has a distinct credential reference and explicit actions. Runtime actors only read assigned business data or create artifacts. Mapped operators may perform explicitly granted human actions. A publisher can only pass the mail.send permission check; sender, inbox and test To/CC/BCC are bound. **This is only the authorization prerequisite:** a future sending gateway must also enforce the exact approved snapshot, task state, idempotency and send ledger. This package does not implement approval, pause/takeover state, or send email. A permission callback must not be wired directly to a provider send API.

Revocation blocks new executions and discards reads whose authorization changed in flight. It cannot retract a provider request already accepted. Deployment configuration changes that alter authorization must advance control_epoch; operations that require atomic state transitions need a transactional gate in their owning module.

The configuration validates declared customer ownership of runtimes, knowledge scopes and provider identities. It cannot verify that external credentials actually belong to the configured provider account, or isolate Hermes memory, files or processes. Those require onboarding and live integration tests.

Run this package's `test`, `test:python`, `test:conformance`, `typecheck`, and `check:generated` scripts. Fixtures use synthetic identities and contain no usable credentials.

## Sales task-read authorization (SG0.3)

The additive `sales-auth-*` contracts use `protocol: sales-auth/1`. The six original business schemas are unchanged. TypeScript uses `./task-access`; Python uses `task_access.py`. `authorizeTaskRead` / `authorize_task_read` check a lease, source handoff, per-request permit and exact read request. `issueTaskPermit` / `issue_task_permit` reject an unverified source, paused task, stale run/revision or unavailable action.

All records and permits must come from authenticated server storage/transport. These functions do not authenticate callers, issue lease tokens, query current task storage or send email. Passing model-generated records into them is not an authorization boundary. The Channel reader must load the real records and authenticate its fixed Hermes control connection before calling them.

Time is integer Unix seconds: lease TTL <= 300, request permit TTL <= 10. Task/run identifiers cannot contain path syntax. Client revocation (`control_epoch`) and task controls (`task_revision`) are distinct. Product reads allow only the customer's approved catalog projection; private inquiries and attachments stay within the task's source.

Run `test:task-conformance` with the Python requirements installed to compare the same authorization vectors across both languages. Existing `test:conformance` still validates the original 58 schema/strict-JSON/hash vectors. Neither command proves deployed service identity or account isolation.
