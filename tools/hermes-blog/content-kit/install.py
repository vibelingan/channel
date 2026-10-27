"""Install only the content assistant's scoped Blog writing skill."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(source, home):
    source, home = Path(source).resolve(), Path(home).resolve()
    relative = "skills/channel-blog-writing/SKILL.md"
    manifest = json.loads((source / "MANIFEST.json").read_text())
    expected = manifest["files"][relative]
    incoming = source / relative
    if sha(incoming) != expected or manifest.get("credentialIncluded") is not False:
        raise ValueError("Package verification failed")
    if not (home / "config.yaml").is_file():
        raise ValueError("Select the existing Hermes home; do not create another assistant")
    target = home / relative
    state_dir = home / "channel-blog/content-kit"
    for directory in (home / "skills", home / "channel-blog", state_dir):
        if directory.is_symlink():
            raise ValueError("Installation directories cannot be symlinks")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_file = state_dir / "state.json"
    if state_file.is_symlink():
        raise ValueError("Installation state cannot be a symlink")
    previous = json.loads(state_file.read_text()) if state_file.exists() else {}
    if target.exists():
        if target.is_symlink():
            raise ValueError("Existing skill is a symlink; stop")
        current = sha(target)
        if current == expected:
            return {"ok": True, "alreadyInstalled": True, "skillSha256": expected}
        if current != previous.get("skillSha256"):
            raise ValueError("Existing skill has unrecognized edits; do not overwrite")
        backup = state_dir / (current + ".SKILL.md")
        if not backup.exists():
            shutil.copyfile(target, backup)
            os.chmod(backup, 0o600)
    if target.parent.is_symlink():
        raise ValueError("Skill directory cannot be a symlink")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".channel-blog-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(incoming.read_bytes())
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temp, 0o644)
        os.replace(temp, target)
    finally:
        if Path(temp).exists():
            Path(temp).unlink()
    state_file.write_text(json.dumps({"skillSha256": expected, "version": manifest["version"]}) + "\n")
    os.chmod(state_file, 0o600)
    return {"ok": True, "skillSha256": sha(target), "configChanged": False, "mcpChanged": False, "serviceRestarted": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", default=os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    args = parser.parse_args()
    try:
        print(json.dumps(install(Path(__file__).parent, args.home)))
    except (OSError, ValueError, KeyError):
        raise SystemExit("内容技能安装未完成：请核对现有 Hermes 目录、文件摘要及是否有人工修改；不要覆盖其他配置。")
