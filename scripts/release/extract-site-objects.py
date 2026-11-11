"""Check, read or extract schema 2 recovery objects against their exact plan.

Usage:
  extract-site-objects.py check <plan.json>             every ZIP holds exactly its members
  extract-site-objects.py read <zip> <member>           one small member to stdout
  extract-site-objects.py extract <plan.json> <output>  a complete release, all or nothing
plan.json: [{"zip": "<path>", "members": [["<path>", <bytes>, "<sha256>"], ...]}, ...]
"""
import hashlib, json, os, pathlib, shutil, stat, sys, zipfile

REQUIRED = {'payload-manifest.json', 'static-manifest.json', 'compatibility.json',
            'product-snapshot.json', 'index.html'}


def unsafe(item, names):
    path = pathlib.PurePosixPath(item.filename)
    return (item.is_dir() or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16)
            or item.filename in names or path.is_absolute() or '\\' in item.filename
            or '%' in item.filename or any(p in ('', '.', '..') for p in item.filename.split('/')))


def checked(plan):
    """Open every ZIP and require exactly its planned names and sizes, under fixed budgets."""
    names, total, opened = set(), 0, []
    try:
        for obj in plan:
            expected = {m[0]: (m[1], m[2]) for m in obj['members']}
            if not expected or len(expected) != len(obj['members']):
                raise ValueError('Duplicate planned recovery member')
            source = zipfile.ZipFile(obj['zip'])
            opened.append((source, expected))
            items = source.infolist()
            if len(items) != len(expected) or {i.filename for i in items} != set(expected):
                raise ValueError('Recovery object members differ from its plan')
            for item in items:
                if unsafe(item, names):
                    raise ValueError('Unsafe static release member')
                if (item.file_size > 128 * 1024 * 1024 or item.compress_type not in (0, 8)
                        or item.file_size != expected[item.filename][0]):
                    raise ValueError('Unsupported static release member')
                total += item.file_size
                names.add(item.filename)
                if total > 512 * 1024 * 1024 or len(names) > 20004:
                    raise ValueError('Static release archive budget exceeded')
        return names, opened
    except BaseException:
        for source, _ in opened:
            source.close()
        raise


def verified(source, item, expected):
    body = source.read(item)
    size, digest = expected[item.filename]
    if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
        raise ValueError('Recovery object member differs')
    return body


mode = sys.argv[1]
if mode == 'read':
    with zipfile.ZipFile(sys.argv[2]) as source:
        item = source.getinfo(sys.argv[3])
        if item.flag_bits & 1 or item.compress_type not in (0, 8) or item.file_size > 16 * 1024 * 1024:
            raise ValueError('Unsupported recovery head member')
        sys.stdout.buffer.write(source.read(item))
elif mode == 'check':
    names, opened = checked(json.loads(pathlib.Path(sys.argv[2]).read_text()))
    try:
        for source, expected in opened:
            for item in source.infolist():
                verified(source, item, expected)
    finally:
        for source, _ in opened:
            source.close()
elif mode == 'extract':
    names, opened = checked(json.loads(pathlib.Path(sys.argv[2]).read_text()))
    root = pathlib.Path(sys.argv[3])
    partial = root.with_name(root.name + '.partial')
    created = False
    try:
        if not REQUIRED.issubset(names):
            raise ValueError('Incomplete static release')
        if root.exists():
            raise ValueError('Recovery output already exists')
        partial.mkdir(parents=True, exist_ok=False)
        created = True
        for source, expected in opened:
            for item in source.infolist():
                target = partial / item.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as stream:
                    stream.write(verified(source, item, expected))
        os.rename(partial, root)
    except BaseException:
        if created:
            shutil.rmtree(partial, ignore_errors=True)
        raise
    finally:
        for source, _ in opened:
            source.close()
else:
    raise ValueError('Unknown mode')
