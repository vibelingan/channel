# Tencent service authentication

Server-only transport helpers for Tencent SCF Function URLs and request-local
runtime credentials. This package does not choose a customer, task, database or
business permission. Callers must retain those checks in their own services.

The TypeScript source is a workspace package, bundled into each consumer. Another
project can vendor this package or consume a packed copy with a TypeScript-aware
bundler; it is not yet published to a package registry. There are no Channel
environment IDs, tokens or tenant rules in the package.

`createScfCamFetch` signs only requests to the configured native SCF host and
refuses redirects. `scfRuntimeCredential` is only suitable for a server behind
SCF, where the platform replaces common runtime headers. Do not use it as
authentication on an arbitrary Internet-facing server.

Protocol: https://cloud.tencent.com/document/product/583/96100
Runtime headers: https://cloud.tencent.com/document/product/583/56124
