"""Build the content-only kit; never copy publisher programs or credentials."""
import hashlib
import io
import json
import os
import zipfile
from pathlib import Path


def build(output):
    source = Path(__file__).resolve().parent
    files = {
        "README.zh-CN.md": (source / "README.zh-CN.md").read_bytes(),
        "install.py": (source / "install.py").read_bytes(),
        "skills/channel-blog-writing/SKILL.md": (source.parent / "skills/channel-blog-writing/SKILL.md").read_bytes(),
    }
    manifest = {
        "version": "2026-10-27-content-4-images",
        "targetAgentId": "xianqu-agent1",
        "credentialIncluded": False,
        "websiteToolsIncluded": False,
        "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
    }
    files["MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 27, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    data = buffer.getvalue()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
    except FileExistsError:
        if output.read_bytes() != data:
            raise ValueError("Existing archive differs; use a new version instead of replacing it")
    return {"file": output.name, "sha256": hashlib.sha256(data).hexdigest(), "files": len(files), "credentialIncluded": False}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[3]
    print(json.dumps(build(root / "output/channel-blog-content-kit-2026-10-27.zip")))
