"""Extract only regular renderer sources, after the caller has verified the package hash."""
import pathlib, sys, tarfile
archive, output = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as source:
    items = source.getmembers()
    names, total = set(), 0
    for item in items:
        name = item.name.rstrip('/')
        path = pathlib.PurePosixPath(name)
        if (not name or name in names or path.is_absolute() or '\\' in name
            or any(p in ('', '.', '..') for p in name.split('/'))
            or not (item.isfile() or item.isdir())):
            raise ValueError('Unsafe renderer member')
        names.add(name)
        total += item.size
        if item.size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024 or len(names) > 24000:
            raise ValueError('Renderer archive budget exceeded')
    if not {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/site/astro.config.ts'}.issubset(names):
        raise ValueError('Incomplete renderer')
    root = pathlib.Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for item in items:
        target = root / item.name
        if item.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(item) as reader, target.open('xb') as writer:
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
            target.chmod(0o700 if item.mode & 0o111 else 0o600)
