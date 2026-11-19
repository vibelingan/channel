"""Prefer Ubuntu's main archive while keeping the runner's mirror failover."""

import argparse
import re
from pathlib import Path


def use_main_archive(directory: Path) -> int:
    if not directory.is_dir():
        raise ValueError("APT source directory is missing")
    regional = re.compile(
        r"(https?://)(?:[A-Za-z0-9-]+\.)+archive\.ubuntu\.com(?=/ubuntu(?:[/\s]|$))"
    )
    main_entry = re.compile(
        r"\s*https?://archive\.ubuntu\.com/ubuntu/?(?:\s+priority:\d+)?\s*"
    )
    paths = [directory / "sources.list", directory / "apt-mirrors.txt"]
    paths += sorted((directory / "sources.list.d").glob("*.list"))
    paths += sorted((directory / "sources.list.d").glob("*.sources"))
    changed = 0
    for path in paths:
        if path.is_symlink():
            raise ValueError("Unexpected linked APT source file")
        if not path.is_file():
            continue
        original = path.read_text()
        if path.name == "apt-mirrors.txt":
            entries = original.splitlines(keepends=True)
            updated = original
            if any(regional.match(line.lstrip()) for line in entries):
                # Rewriting hostnames in this list collapses distinct runner mirrors.
                # Change the priority and keep the original fallback.
                other_entries = "".join(line for line in entries if not main_entry.fullmatch(line))
                updated = "https://archive.ubuntu.com/ubuntu/\tpriority:0\n" + other_entries
        else:
            updated = regional.sub(r"\1archive.ubuntu.com", original)
        if updated != original:
            path.write_text(updated)
            changed += 1
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apt-dir", type=Path, default=Path("/etc/apt"))
    args = parser.parse_args()
    print(f"Ubuntu main archive selected; source files updated: {use_main_archive(args.apt_dir)}")
