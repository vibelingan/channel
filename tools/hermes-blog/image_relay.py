"""Bounded image files over the existing restricted SSH connection; no cloud key on content host."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from relay import connect_kb, fetch_document, private_json, run_json, document_id

MAX_IMAGE = 3 * 1024 * 1024
MAX_HEADER = 32768


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Private image directory required")


def atomically(path, data):
    if path.exists():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or path.read_bytes() != data:
            raise ValueError("Image job changed")
        return
    fd, name = tempfile.mkstemp(prefix=".image-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        os.link(name, path)
    except FileExistsError:
        if path.read_bytes() != data:
            raise ValueError("Concurrent image job changed")
    finally:
        os.unlink(name)


def mime(bytes_):
    if bytes_.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', 'png'
    if bytes_.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', 'jpg'
    if bytes_.startswith(b'RIFF') and bytes_[8:12] == b'WEBP':
        return 'image/webp', 'webp'
    raise ValueError("Only PNG, JPEG or WebP files are accepted")


def description(value):
    if not isinstance(value, dict) or set(value) - {'alt', 'caption', 'placement', 'filePath'}:
        raise ValueError("Image fields are invalid")
    alt, caption, placement = value.get('alt'), value.get('caption', ''), value.get('placement')
    if not isinstance(alt, str) or not alt.strip() or len(alt) > 300 or not isinstance(caption, str) or len(caption) > 500:
        raise ValueError("Image description is required")
    if not isinstance(placement, dict) or placement.get('type') not in ('start', 'end', 'before-heading'):
        raise ValueError("Explicit image placement required")
    expected = {'type', 'heading'} if placement['type'] == 'before-heading' else {'type'}
    if set(placement) != expected or ('heading' in placement and (not isinstance(placement['heading'], str) or not 0 < len(placement['heading']) <= 200)):
        raise ValueError("Image position is invalid")
    return {'alt': alt.strip(), 'caption': caption, 'placement': placement}


def prepare(config, payload):
    if set(payload) != {'documentId', 'images'} or not isinstance(payload['images'], list) or not 1 <= len(payload['images']) <= 20:
        raise ValueError("A document and 1 to 20 images are required")
    ident = document_id(payload['documentId'])
    fetch_document(connect_kb(config), ident)
    source_root = Path(config['imageSourceRoot']).resolve(strict=True)
    images, snapshots = [], []
    for value in payload['images']:
        meta = description(value)
        supplied = Path(value['filePath'])
        if not supplied.is_absolute() or supplied.is_symlink():
            raise ValueError("Image source must be a registered absolute file")
        source = supplied.resolve(strict=True)
        if not source.is_relative_to(source_root):
            raise ValueError("Image is outside the configured image directory")
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or not 0 < info.st_size <= MAX_IMAGE:
                raise ValueError("Image file ownership or size is invalid")
            with os.fdopen(fd, 'rb', closefd=False) as handle:
                data = handle.read(MAX_IMAGE + 1)
            if len(data) != info.st_size:
                raise ValueError("Image source changed while reading")
        finally:
            os.close(fd)
        kind, extension = mime(data)
        checksum = sha(data)
        if any(x['checksumSha256'] == checksum for x in images):
            raise ValueError("The same image may only be inserted once")
        images.append({**meta, 'fileName': checksum + '.' + extension, 'mimeType': kind, 'byteSize': len(data), 'checksumSha256': checksum})
        snapshots.append(data)
    manifest = {'version': 1, 'documentId': ident, 'workspaceId': '2', 'images': images}
    data = canonical(manifest)
    if len(data) > MAX_HEADER:
        raise ValueError("Image descriptions exceed the job limit")
    root = Path(config['imageOutbox']) / sha(data)
    private_directory(root)
    atomically(root / 'job.json', data)
    for image, snapshot in zip(images, snapshots):
        atomically(root / image['fileName'], snapshot)
    return root, manifest


def submit(config, payload):
    root, manifest = prepare(config, payload)
    command = ['/usr/bin/ssh', '-F', config['sshConfig'], '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', config['sshHost'], 'channel-blog-images']
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    timer = threading.Timer(240, child.kill)
    timer.daemon = True
    timer.start()
    try:
        child.stdin.write(canonical(manifest) + b'\n')
        for image in manifest['images']:
            with (root / image['fileName']).open('rb') as file:
                while block := file.read(65536):
                    child.stdin.write(block)
        child.stdin.close(); child.stdin = None
        output, _ = child.communicate(timeout=240)
        if child.returncode or len(output) > 32768:
            raise ValueError("Image handoff was not confirmed")
        result = json.loads(output)
        if result.get('documentId') != manifest['documentId'] or (result.get('ok') is not False and result.get('imageCount') != len(manifest['images'])):
            raise ValueError("Image handoff receipt differs")
        return result
    finally:
        timer.cancel()
        if child.poll() is None:
            child.kill(); child.wait()


def receive(config, stream):
    line = stream.readline(MAX_HEADER + 2)
    if len(line) > MAX_HEADER + 1 or not line.endswith(b'\n'):
        raise ValueError("Image job header exceeds limit")
    manifest = json.loads(line)
    if not isinstance(manifest, dict) or set(manifest) != {'version', 'documentId', 'workspaceId', 'images'} or manifest['version'] != 1 or manifest['workspaceId'] != '2' or not isinstance(manifest['images'], list) or not 1 <= len(manifest['images']) <= 20:
        raise ValueError("Image manifest is invalid")
    ident = document_id(manifest['documentId'])
    fetch_document(connect_kb(config), ident)
    names = set()
    for image in manifest['images']:
        if not isinstance(image, dict) or set(image) != {'fileName', 'mimeType', 'byteSize', 'checksumSha256', 'alt', 'caption', 'placement'}:
            raise ValueError("Image metadata is invalid")
        description({k: image[k] for k in ('alt', 'caption', 'placement')})
        checksum, size = image['checksumSha256'], image['byteSize']
        if not isinstance(checksum, str) or not re.fullmatch('[a-f0-9]{64}', checksum) or not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_IMAGE:
            raise ValueError("Image checksum or size is invalid")
        if not re.fullmatch(re.escape(checksum) + r'\.(png|jpg|webp)', image['fileName']) or image['fileName'] in names:
            raise ValueError("Image filename is invalid or repeated")
        names.add(image['fileName'])
    root = Path(config['imageInbox']) / sha(canonical(manifest))
    private_directory(root)
    atomically(root / 'job.json', canonical(manifest))
    for image in manifest['images']:
        data = bytearray()
        while len(data) < image['byteSize']:
            part = stream.read(min(65536, image['byteSize'] - len(data)))
            if not part:
                raise ValueError("Image transfer was interrupted")
            data.extend(part)
        if sha(data) != image['checksumSha256'] or mime(data)[0] != image['mimeType']:
            raise ValueError("Image transfer integrity failed")
        atomically(root / image['fileName'], data)
    if stream.read(1):
        raise ValueError("Unexpected bytes after images")
    return root


def publish(config, root):
    return run_json([config['python'], config['lockedInvoke'], '--node', config['node'], '--bundle', config['invokeBundle'], '--credential', config['credentialFile'], '--image-job', str(root / 'job.json')], {}, timeout=240)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--config', required=True); parser.add_argument('--receive', action='store_true'); args = parser.parse_args()
    config = private_json(args.config)
    if config.get('siteId') != 'supplychainsai.com' or config.get('workspaceId') != 2:
        raise ValueError("Image site binding differs")
    if args.receive:
        if config.get('role') != 'publisher' or os.environ.get('SSH_ORIGINAL_COMMAND') != 'channel-blog-images':
            raise ValueError("Only the restricted image command is allowed")
        result = publish(config, receive(config, sys.stdin.buffer))
    elif config.get('role') == 'content':
        data = sys.stdin.buffer.read(MAX_HEADER + 1)
        if len(data) > MAX_HEADER:
            raise ValueError("Image request exceeds limit")
        result = submit(config, json.loads(data))
    else:
        raise ValueError("Only the content image entry may initiate a handoff")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('图片交接结果未确认；请保留原文档和图片重试，不另建文章或换图。已有结果不会自动撤销。', file=sys.stderr)
        sys.exit(1)
