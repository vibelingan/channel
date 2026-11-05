import hashlib,io,json,pathlib,re,stat,sys,zipfile,zlib
stage="input"
try:
 source=pathlib.Path(sys.argv[1])
 if source.stat().st_size>15*1024*1024:raise ValueError()
 body=source.read_bytes()
 if not body or len(body)>15*1024*1024:raise ValueError()
 root=pathlib.Path(sys.argv[2]);files={};expanded=0
 stage="members"
 with zipfile.ZipFile(io.BytesIO(body)) as z:
  entries=z.infolist()
  if len(entries)>1024:raise ValueError()
  for item in entries:
   name=item.filename
   while name.startswith('./'):name=name[2:]
   name=name.rstrip('/')
   if not name and item.is_dir():continue
   path=pathlib.PurePosixPath(name)
   mode=item.external_attr>>16
   if not name or '\\' in name or '\x00' in name or path.is_absolute() or '..' in path.parts or str(path)!=name or item.flag_bits&1 or stat.S_ISLNK(mode) or item.compress_type not in (0,8):raise ValueError()
   if item.is_dir():
    if name!='vendor' and not name.startswith('vendor/'):raise ValueError()
   elif name not in ('index.js','package.json','image-decoder-manifest.json') and not name.startswith('vendor/'):raise ValueError()
   if item.is_dir():continue
   if name in files or item.file_size>32*1024*1024:raise ValueError()
   expanded+=item.file_size
   if expanded>64*1024*1024 or len(files)>=512:raise ValueError()
   files[name]=z.read(item)
 stage='root-manifest'
 for name in files:
  if any(str(parent) in files for parent in pathlib.PurePosixPath(name).parents if str(parent)!='.'):raise ValueError()
 if not {'index.js','package.json','image-decoder-manifest.json'}.issubset(files) or not files['index.js'] or len(files['package.json'])>65536 or len(files['image-decoder-manifest.json'])>1024*1024:raise ValueError()
 pkg=json.loads(files['package.json'])
 if not isinstance(pkg,dict) or pkg.get('name')!='channel-alibaba-catalog-sync' or pkg.get('main')!='index.js' or pkg.get('type','commonjs')!='commonjs' or pkg.get('dependencies',{}) or pkg.get('optionalDependencies',{}) or pkg.get('imports')!={'#catalog-image-decoder':'./vendor/image-decoder.mjs'}:raise ValueError()
 stage='decoder-manifest'
 manifest=json.loads(files['image-decoder-manifest.json'])
 if not isinstance(manifest,dict) or manifest.get('target')!='linux-x64' or not isinstance(manifest.get('packages'),list) or not 1<=len(manifest['packages'])<=64 or not isinstance(manifest.get('files'),list) or not 1<=len(manifest['files'])<=512:raise ValueError()
 names=set()
 for package in manifest['packages']:
  name=package.get('name') if isinstance(package,dict) else None
  version=package.get('version') if isinstance(package,dict) else None
  if not isinstance(name,str) or len(name)>214 or not re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*',name) or name in names or not isinstance(version,str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?',version):raise ValueError()
  names.add(name)
 for record in manifest['files']:
  name=record.get('path') if isinstance(record,dict) else None
  if not isinstance(name,str) or not name.startswith('vendor/') or '..' in pathlib.PurePosixPath(name).parts or '\\' in name or name not in files:raise ValueError()
 stage='extract'
 for name,data in files.items():
  target=root/name;target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('xb') as f:f.write(data)
 print(json.dumps({'format':'channel-native-decoder-zip-v1','files':sorted(files),'contentSha256':{n:hashlib.sha256(b).hexdigest() for n,b in files.items()}}))
except Exception as error:
 code='NATIVE_ARCHIVE_INVALID' if isinstance(error,(ValueError,zipfile.BadZipFile,zlib.error)) else 'NATIVE_ARCHIVE_UNCONFIRMED'
 sys.stderr.write(json.dumps({'code':code,'stage':stage,'kind':type(error).__name__})+'\n');sys.exit(1)
