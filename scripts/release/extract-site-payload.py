"""Extract a complete static release, with fixed file/count/byte budgets."""
import pathlib, stat, sys, zipfile
archive, output = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    names = set()
    total = 0
    for item in entries:
        path = pathlib.PurePosixPath(item.filename)
        if (item.is_dir() or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16)
            or item.filename in names or path.is_absolute() or '\\' in item.filename
            or '%' in item.filename or any(p in ('', '.', '..') for p in item.filename.split('/'))):
            raise ValueError('Unsafe static release member')
        if item.file_size > 128 * 1024 * 1024 or item.compress_type not in (0, 8):
            raise ValueError('Unsupported static release member')
        total += item.file_size
        names.add(item.filename)
        if total > 512 * 1024 * 1024 or len(names) > 20004:
            raise ValueError('Static release archive budget exceeded')
    if not {'payload-manifest.json','static-manifest.json','compatibility.json','product-snapshot.json','index.html'}.issubset(names):
        raise ValueError('Incomplete static release')
    root = pathlib.Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for item in entries:
        target = root / item.filename
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(source.read(item))
