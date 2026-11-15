"""Install only the content assistant's scoped Blog writing skill."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def content_identity():
    with urllib.request.urlopen('http://127.0.0.1:9876/health', timeout=3) as response:
        payload = response.read(4097)
    if len(payload) > 4096:
        raise ValueError("助手健康接口返回异常，未安装")
    health = json.loads(payload)
    if health.get("status") != "ok":
        raise ValueError("助手服务尚未就绪，未安装")
    return health.get("agent")


def install(source, home, identity_check=content_identity):
    source, home = Path(source).resolve(), Path(home).resolve()
    relative = "skills/channel-blog-writing/SKILL.md"
    manifest = json.loads((source / "MANIFEST.json").read_text())
    expected = manifest["files"][relative]
    incoming = source / relative
    if sha(incoming) != expected or manifest.get("credentialIncluded") is not False:
        raise ValueError("安装包摘要或范围不符，未安装")
    if manifest.get("targetAgentId") != "xianqu-agent1" or identity_check() != manifest["targetAgentId"]:
        raise ValueError("当前机器不是已核对的内容工厂助手，未安装")
    if not (home / "config.yaml").is_file():
        raise ValueError("找不到现有 Hermes 配置，未安装；不要新建助手实例")
    target = home / relative
    state_dir = home / "channel-blog/content-kit"
    for directory in (home / "skills", home / "channel-blog", state_dir):
        if directory.is_symlink():
            raise ValueError("技能或安装记录目录是符号链接，未安装")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_file = state_dir / "state.json"
    if state_file.is_symlink():
        raise ValueError("安装记录指向其他文件，未写入")
    previous = json.loads(state_file.read_text()) if state_file.exists() else {}
    if target.exists():
        if target.is_symlink():
            raise ValueError("同名技能是符号链接，未覆盖")
        current = sha(target)
        if current == expected:
            return {"ok": True, "alreadyInstalled": True, "skillSha256": expected}
        if current != previous.get("skillSha256"):
            raise ValueError("同名技能有未识别的修改，未覆盖")
        backup = state_dir / (current + ".SKILL.md")
        if not backup.exists():
            shutil.copyfile(target, backup)
            os.chmod(backup, 0o600)
    if target.parent.is_symlink():
        raise ValueError("技能目录指向其他位置，未写入")
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
    except ValueError as error:
        raise SystemExit("内容技能安装未完成：" + str(error))
    except (OSError, KeyError):
        raise SystemExit("无法连接本机助手或读写本轮技能文件，请核对服务、权限和安装包；不要覆盖其他配置。")
