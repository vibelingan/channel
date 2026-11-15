"""Package planned recovery objects from a verified payload, with stable ZIP metadata.

Usage: pack-site-objects.py <payload-root> <plan.json>
plan.json: [{"output": "<new zip path>", "members": ["<payload path>", ...]}, ...]
"""
import json, pathlib, sys, zipfile
root, plan = pathlib.Path(sys.argv[1]), json.loads(pathlib.Path(sys.argv[2]).read_text())
seen = set()
for item in plan:
    names = item['members']
    if not names or len(set(names)) != len(names) or seen.intersection(names):
        raise ValueError('Duplicate or empty retained payload member')
    seen.update(names)
    with zipfile.ZipFile(item['output'], 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        for name in sorted(names):
            path = pathlib.PurePosixPath(name)
            if (path.is_absolute() or '\\' in name or '%' in name
                    or any(p in ('', '.', '..') for p in name.split('/'))):
                raise ValueError('Unsafe retained payload member')
            source = root / name
            if not source.is_file() or source.is_symlink():
                raise ValueError('Non-regular retained payload member')
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, source.read_bytes(), compresslevel=3)
