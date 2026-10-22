#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
export PATH="$root/tools/cloud-handoff/node_modules/.bin:$PATH"
[[ "$(node --version)" == v22.13.0 ]] || { echo 'Node 22.13.0 required' >&2; exit 1; }
[[ "$(pnpm --version)" == 11.5.0 ]] || { echo 'pnpm 11.5.0 required' >&2; exit 1; }
# Detached HEAD is normal on some cloud hosts. Do not silently switch branches.
branch="$(git branch --show-current)"
if [[ -n "$branch" && "$branch" != feat/seo-foundation ]]; then
  echo 'Wrong branch; select feat/seo-foundation in the cloud task UI.' >&2
  exit 1
fi
git merge-base --is-ancestor c9b1046cd631f59c3b116aa5fb1560babf46ce01 HEAD || {
  echo 'Checkout predates this handoff; select the SEO branch containing it.' >&2; exit 1;
}
printf 'Checkout: %s (%s)\n' "$(git rev-parse HEAD)" "${branch:-detached}"
python3 - <<'CHECK_SKILLS'
import json
from pathlib import Path
lock = json.loads(Path('docs/cloud-handoff/skills.lock.json').read_text())
for source in lock['sources']:
    for skill in source['skills']:
        path = Path('.agents/skills') / skill['name'] / 'SKILL.md'
        if not path.is_file():
            raise SystemExit('Missing GitHub skill: ' + skill['name'] + '; rerun setup')
print('All 9 pinned GitHub skill entry files are present.')
CHECK_SKILLS
python3 scripts/cloud-handoff/test_install_skills.py
pnpm --filter @vibelingan-channel/articles test
pnpm verify:cloudbase-sdk
pnpm lint
if [[ "${1:-}" == --full ]]; then
  pnpm test
fi
printf '%s\n' 'Local checks passed. No live CloudBase acceptance or production restoration was performed.'
