#!/usr/bin/env python3
"""Install only pinned GitHub skills; never overwrite an existing different tree."""
import argparse
import hashlib
import io
import json
import pathlib
import re
import shutil
import tarfile
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAX_ARCHIVE = 80 * 1024 * 1024
MAX_SELECTED = 128 * 1024 * 1024


def checked_path(value):
    path = pathlib.PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or '\\' in value:
        raise ValueError('Unsafe archive or skill path')
    return path


def select_files(data, source, skill):
    if hashlib.sha256(data).hexdigest() != source['archiveSha256']:
        raise ValueError('GitHub archive checksum does not match the reviewed lock')
    selected = {}
    prefix = checked_path(skill['path'])
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        roots = {checked_path(m.name).parts[0] for m in members if checked_path(m.name).parts}
        if len(roots) != 1:
            raise ValueError('Expected one GitHub archive root')
        for member in members:
            path = checked_path(member.name)
            if len(path.parts) < 2:
                continue
            relative = pathlib.PurePosixPath(*path.parts[1:])
            if not relative.is_relative_to(prefix):
                continue
            output = relative.relative_to(prefix)
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                raise ValueError('Non-regular file in selected skill')
            if not output.parts or output.as_posix() in selected:
                raise ValueError('Invalid or repeated output path')
            total += member.size
            if total > MAX_SELECTED or len(selected) >= 10000:
                raise ValueError('Selected skill exceeds size budget')
            selected[output.as_posix()] = archive.extractfile(member).read()
        if 'codexEntry' in skill:
            entry = ROOT / checked_path(skill['codexEntry'])
            if not entry.resolve().is_relative_to(ROOT.resolve()):
                raise ValueError('Codex entry must stay inside the repository')
            if 'SKILL.md' in selected:
                raise ValueError('Codex bridge must not replace an upstream SKILL.md')
            bridge = entry.read_bytes()
            if len(bridge) > 64 * 1024:
                raise ValueError('Codex entry exceeds size budget')
            selected['SKILL.md'] = bridge
        if 'SKILL.md' not in selected:
            raise ValueError('Selected skill has no SKILL.md')
        notice = source.get('noticeFile')
        names = (checked_path(notice).as_posix(),) if notice else ('LICENSE', 'LICENSE.md', 'LICENSE.txt')
        for name in names:
            license_member = next((m for m in members if m.name == next(iter(roots)) + '/' + name), None)
            if license_member:
                if not license_member.isfile() or license_member.size > MAX_SELECTED:
                    raise ValueError('Upstream notice must be a bounded regular file')
                selected['UPSTREAM-NOTICE' if notice else 'UPSTREAM-LICENSE'] = archive.extractfile(license_member).read()
                break
        else:
            raise ValueError('No upstream license or explicit notice found')
    return selected


def tree_hashes(folder):
    found = {}
    for path in folder.rglob('*'):
        if path.is_symlink():
            raise ValueError('Existing skill contains a symlink')
        if path.is_file():
            found[path.relative_to(folder).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def install_files(destination, name, files):
    if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
        raise ValueError('Invalid skill name')
    destination.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError('Skill destination must not be a symlink')
    target = destination / name
    expected = {p: hashlib.sha256(b).hexdigest() for p, b in files.items()}
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_dir() or tree_hashes(target) != expected:
            raise ValueError(f'Refusing to overwrite existing skill: {name}')
        return 'unchanged'
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.install-', dir=destination))
    try:
        for relative, data in files.items():
            path = temporary / checked_path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return 'installed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=pathlib.Path, default=ROOT / '.agents/skills')
    parser.add_argument('--archives', type=pathlib.Path, help='Offline cache of <source-id>.tar.gz')
    args = parser.parse_args()
    lock = json.loads((ROOT / 'docs/cloud-handoff/skills.lock.json').read_text())
    if lock['schemaVersion'] != 1:
        raise ValueError('Unknown lock version')
    for source in lock['sources']:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', source['repository']):
            raise ValueError('Invalid GitHub repository')
        if not re.fullmatch(r'[a-f0-9]{40}', source['commit']):
            raise ValueError('Expected a full commit SHA')
        if args.archives:
            data = (args.archives / (source['id'] + '.tar.gz')).read_bytes()
        else:
            url = f"https://codeload.github.com/{source['repository']}/tar.gz/{source['commit']}"
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read(MAX_ARCHIVE + 1)
        if len(data) > MAX_ARCHIVE:
            raise ValueError('Archive exceeds download budget')
        for skill in source['skills']:
            result = install_files(args.destination, skill['name'], select_files(data, source, skill))
            print(f"{skill['name']}: {result} ({source['commit'][:12]})")


if __name__ == '__main__':
    main()
