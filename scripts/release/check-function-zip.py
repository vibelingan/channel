import hashlib, io, json, pathlib, stat, sys, zipfile

try:
    body = sys.stdin.buffer.read(1572865)
    if not body or len(body) > 1572864:
        raise ValueError()
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        entries = archive.infolist()
        if len(entries) != 2 or {x.filename for x in entries} != {'index.js', 'package.json'}:
            raise ValueError()
        if any(x.is_dir() or x.flag_bits & 1 or stat.S_ISLNK(x.external_attr >> 16)
               or x.file_size > 16 * 1024 * 1024 or x.compress_type not in (0, 8) for x in entries):
            raise ValueError()
        if sum(x.file_size for x in entries) > 16 * 1024 * 1024:
            raise ValueError()
        files = {x.filename: archive.read(x) for x in entries}
        package = json.loads(files['package.json'].decode('utf-8'))
        if not isinstance(package, dict) or package.get('main') != 'index.js' or package.get('type', 'commonjs') != 'commonjs':
            raise ValueError()
        if package.get('dependencies', {}) or package.get('optionalDependencies', {}):
            raise ValueError()
        if not files['index.js'] or len(files['package.json']) > 65536:
            raise ValueError()
        if len(sys.argv) == 2:
            root = pathlib.Path(sys.argv[1])
            for name, value in files.items():
                with (root / name).open('xb') as f:
                    f.write(value)
        print(json.dumps({'format': 'channel-bundled-zip-v1', 'files': sorted(files), 'contentSha256': {name: hashlib.sha256(value).hexdigest() for name,value in files.items()}}))
except Exception:
    sys.stderr.write('Invalid bundled function ZIP\n')
    sys.exit(1)
