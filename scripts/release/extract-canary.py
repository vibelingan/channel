"""Extract data only: fixed D1 members, no links, duplicates, traversal or ZIP bombs."""
import pathlib
import stat
import sys
import zipfile

archive, output, prefix = sys.argv[1:]
allowed = {"payload-manifest.json", "static-manifest.json", "compatibility.json", prefix + "index.html"}
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if len(entries) != 4 or {item.filename for item in entries} != allowed:
        raise ValueError("Unexpected archive population")
    if any(item.is_dir() or stat.S_ISLNK(item.external_attr >> 16) or item.file_size > 131072 for item in entries):
        raise ValueError("Unsafe archive member")
    root = pathlib.Path(output)
    root.mkdir(parents=True, exist_ok=False)
    for item in entries:
        path = root / item.filename
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as target:
            target.write(source.read(item))
