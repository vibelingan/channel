"""Verify the pinned SG1.0 source inventory; does not execute product code."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO, stderr=subprocess.PIPE)


def verify(manifest):
    pins = manifest["commits"]
    for name, sha in pins.items():
        if git("rev-parse", f"{sha}^{{commit}}").decode().strip() != sha:
            raise ValueError(f"Unexpected commit: {name}")
    ancestry = manifest["ancestry"]
    base = git("merge-base", pins["main"], pins["phase2"]).decode().strip()
    if base != ancestry["main_phase2_merge_base"]:
        raise ValueError("Main/Phase 2 ancestry changed")
    counts = git("rev-list", "--left-right", "--count", f'{pins["main"]}...{pins["phase2"]}').decode().split()
    if list(map(int, counts)) != ancestry["unique_commits_main_phase2"]:
        raise ValueError("Main/Phase 2 divergence does not match the inventory")
    for name in ("main", "phase2"):
        git("merge-base", "--is-ancestor", pins["formal_inquiry_origin"], pins[name])
    git("merge-base", "--is-ancestor", pins["worktree_source_base"], pins["phase2"])

    files = manifest["files"]
    indexed = {item["id"]: item for item in files}
    if len(indexed) != len(files) or len(files) != manifest["expected_file_count"]:
        raise ValueError("Missing or duplicate source files")
    required_chains = {"oem", "product", "product_admin", "legacy", "assistant", "storage", "switches"}
    if set(manifest["coverage"]) != required_chains:
        raise ValueError("Missing route/storage coverage group")
    covered = {key for chain in manifest["coverage"].values() for key in chain}
    if covered != set(indexed):
        raise ValueError("Source inventory and coverage groups disagree")

    marker_count = 0
    for item in files:
        raw = git("show", f'{pins[item["ref"]]}:{item["path"]}')
        if hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError(f'Source hash mismatch: {item["id"]}')
        lines = raw.decode("utf-8").splitlines()
        if len(lines) != item["line_count"] or not item["markers"]:
            raise ValueError(f'Source line inventory mismatch: {item["id"]}')
        for marker in item["markers"]:
            actual = [i for i, line in enumerate(lines, 1) if marker["text"] in line]
            if actual != marker["lines"] or not actual:
                raise ValueError(f'Source marker mismatch: {item["id"]}: {marker["text"]}')
            marker_count += 1

    for path in manifest["identical_main_phase2"]:
        if git("show", f'{pins["main"]}:{path}') != git("show", f'{pins["phase2"]}:{path}'):
            raise ValueError(f'Expected shared inquiry implementation differs: {path}')
    return {
        "status": "passed",
        "files_checked": len(files),
        "markers_checked": marker_count,
        "coverage_groups": len(required_chains),
        "identical_files_main_phase2": len(manifest["identical_main_phase2"]),
        "scope": "pinned source hashes, line markers and ancestry only; no runtime or live validation",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "evidence/SG1.0-source-inventory.json")
    args = parser.parse_args()
    try:
        result = verify(json.loads(args.manifest.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Source verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
