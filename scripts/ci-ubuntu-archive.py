"""Use Ubuntu's main archive without changing suites, components or signature checks."""

import argparse
import re
from pathlib import Path


def use_main_archive(directory: Path) -> int:
    if not directory.is_dir():
        raise ValueError("APT source directory is missing")
    regional = re.compile(
        r"(https?://)(?:[A-Za-z0-9-]+\.)+archive\.ubuntu\.com(?=/ubuntu(?:[/\s]|$))"
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
