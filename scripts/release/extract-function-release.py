"""Data-only release input; scripts inside payloads are never executed by extraction."""
import json, pathlib, stat, sys, zipfile

archive, output, kind = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    names = [x.filename for x in entries]
    if not entries or len(entries) > 20000 or len(names) != len(set(names)):
        raise ValueError('Invalid archive population')
    if any(x.is_dir() or x.flag_bits & 1 or stat.S_ISLNK(x.external_attr >> 16)
           or x.compress_type not in (0, 8) or x.file_size > 67108864
           or not x.filename or x.filename.startswith('/') or '\\' in x.filename
           or any(c in x.filename for c in '%?#')
           or any(ord(c) <= 32 or ord(c) == 127 for c in x.filename)
           or any(part in ('', '.', '..') for part in x.filename.split('/')) for x in entries):
        raise ValueError('Unsafe archive member')
    if sum(x.file_size for x in entries) > 134217728:
        raise ValueError('Archive byte limit')
    if kind == 'tests':
        expected = {'test-results.json'}
        if source.getinfo('test-results.json').file_size > 4194304:
            raise ValueError('Test evidence too large')
    elif kind == 'payload':
        if source.getinfo('payload-manifest.json').file_size > 4194304:
            raise ValueError('Manifest too large')
        manifest = json.loads(source.read('payload-manifest.json'))
        if manifest.get('schemaVersion') == 1 and manifest.get('purpose') == 'function-compatibility-payload':
            expected = {'payload-manifest.json', 'compatibility.json'}
        elif manifest.get('schemaVersion') == 2 and manifest.get('purpose') == 'release-payload':
            expected = {'payload-manifest.json'} | {x['path'] for x in manifest['entries']}
        else:
            raise ValueError('Unexpected payload')
    else:
        raise ValueError('Unknown archive kind')
    if set(names) != expected:
        raise ValueError('Unexpected archive population')
    root = pathlib.Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for item in entries:
        path = root / item.filename
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as target:
            target.write(source.read(item))
