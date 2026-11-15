"""Package only the verified manifest members, with stable ZIP metadata."""
import json, pathlib, sys, zipfile
root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
manifest = json.loads((root / 'payload-manifest.json').read_text())
names = [x['path'] for x in manifest['entries']] + ['payload-manifest.json']
if len(set(names)) != len(names):
    raise ValueError('Duplicate retained payload member')
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
    for name in sorted(names):
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or '\\' in name or any(p in ('', '.', '..') for p in name.split('/')):
            raise ValueError('Unsafe retained payload member')
        source = root / name
        if not source.is_file() or source.is_symlink():
            raise ValueError('Non-regular retained payload member')
        info = zipfile.ZipInfo(name, date_time=(1980,1,1,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        archive.writestr(info, source.read_bytes(), compresslevel=3)
