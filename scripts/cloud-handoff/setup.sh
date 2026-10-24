#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
if [[ "$(node --version)" != v22.13.0 ]]; then
  echo 'Select Node 22.13.0 in the cloud environment, then rerun setup.' >&2
  exit 1
fi
command -v python3 >/dev/null
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required"'
command -v git >/dev/null
npm ci --prefix tools/cloud-handoff --ignore-scripts --no-audit --no-fund
export PATH="$root/tools/cloud-handoff/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile --ignore-scripts
python3 scripts/cloud-handoff/install-skills.py
printf '%s\n' 'Dependencies and pinned GitHub skills installed. No cloud login or deployment was attempted.'
printf '%s\n' 'Next: bash scripts/cloud-handoff/check.sh'
