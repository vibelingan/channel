"""Extract the isolated Blog payload: no links, traversal, duplicates or ZIP bombs."""
import pathlib
import stat
import sys
import zipfile
archive, output = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    names = set()
    total = 0
    for item in entries:
        path = pathlib.PurePosixPath(item.filename)
        if item.is_dir() or stat.S_ISLNK(item.external_attr >> 16) or item.filename in names or path.is_absolute() or any(p in ('', '.', '..') for p in item.filename.split('/')) or '\\' in item.filename or '%' in item.filename:
            raise ValueError('Unsafe archive member')
        if item.filename not in ('payload-manifest.json', 'static-manifest.json', 'compatibility.json') and not item.filename.startswith('__blog-dummy/'):
            raise ValueError('Foreign payload member')
        names.add(item.filename)
        total += item.file_size
        if item.file_size > 4 * 1024 * 1024 or total > 72 * 1024 * 1024 or len(names) > 515:
            raise ValueError('Archive budget exceeded')
    if not {'payload-manifest.json', 'static-manifest.json', 'compatibility.json', '__blog-dummy/index.html'}.issubset(names):
        raise ValueError('Incomplete payload')
    root = pathlib.Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for item in entries:
        target = root / item.filename
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(source.read(item))
