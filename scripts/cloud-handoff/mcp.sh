#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="$root/tools/cloud-handoff/node_modules/.bin:$PATH"
# No credentials, default environment, authentication, or writes are added here.
exec "$root/tools/cloud-handoff/node_modules/.bin/mcporter" \
  --config "$root/docs/cloud-handoff/mcporter.json" --root "$root" "$@"
