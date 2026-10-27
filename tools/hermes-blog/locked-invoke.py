"""Run the website connector with one OS lock for credential rotation and delivery."""
import argparse
import fcntl
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path


def run(args):
    for value in (args.credential, args.bundle, args.node):
        if not Path(value).is_absolute():
            raise ValueError("Absolute paths required")
    credential = Path(args.credential)
    info = credential.lstat()
    parent = credential.parent.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & 0o077
            or not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode)
            or parent.st_uid != os.getuid() or parent.st_mode & 0o077):
        raise ValueError("Owned private credential path required")
    fd = os.open(str(credential) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        lock = os.fstat(fd)
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid != os.getuid() or lock.st_mode & 0o077 or lock.st_nlink != 1:
            raise ValueError("Invalid credential lock")
        deadline = time.monotonic() + 25
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if args.maintain:
                    print(json.dumps({"ok": True, "publishingOwnsLock": True}))
                    return 0
                if time.monotonic() >= deadline:
                    raise TimeoutError("Connector is busy")
                time.sleep(0.1)
        if args.get_import and not re.fullmatch(r"article-import-[a-f0-9]{64}", args.get_import):
            raise ValueError("Invalid import identity")
        if args.maintain and args.get_import:
            raise ValueError("One operation required")
        payload = b"" if args.maintain or args.get_import else sys.stdin.buffer.read(256001)
        if len(payload) > 256000:
            raise ValueError("Source exceeds size limit")
        command = [args.node, args.bundle, "--credential", str(credential)]
        if args.maintain:
            command.append("--maintain")
        elif args.get_import:
            command.extend(["--get-import", args.get_import])
        result = subprocess.run(command, input=payload, capture_output=True, timeout=150,
                                env={k: v for k, v in os.environ.items() if k not in ("NODE_OPTIONS", "NODE_PATH")})
        if result.returncode or len(result.stdout) > 32768:
            raise ValueError("Connector result unconfirmed")
        json.loads(result.stdout)
        sys.stdout.buffer.write(result.stdout)
        return 0
    finally:
        os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--credential", required=True)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--maintain", action="store_true")
    parser.add_argument("--get-import")
    try:
        sys.exit(run(parser.parse_args()))
    except (ValueError, OSError, TimeoutError, subprocess.TimeoutExpired):
        print("网站草稿操作尚未确认，请保留原任务检查此专用连接。", file=sys.stderr)
        sys.exit(1)
