"""Narrow VibeKB -> publisher -> private website draft adapter. No model or public publishing."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path

SITE = "supplychainsai.com"
WORKSPACE = 2
# MCP Python SDK eagerly parses JSON for Optional[str]; keep the text record explicit.
SOURCE_PREFIX = "channel-blog-source-v1\n"
MAX_BYTES = 256000
FIELDS = {"title", "slug", "excerpt", "authorName", "seoTitle", "seoDescription", "format", "body"}


def private_json(path):
    path = Path(path)
    info = path.lstat()
    parent = path.parent.lstat()
    if (not path.is_absolute() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or info.st_size > 16384 or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.getuid() or parent.st_mode & 0o077):
        raise ValueError("专用连接文件权限不正确")
    return json.loads(path.read_text())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class KnowledgeBase:
    def __init__(self, url, authorization):
        if url not in ("http://127.0.0.1:9021/mcp", "http://43.157.53.132:9021/mcp"):
            raise ValueError("知识库地址与固定站点不符")
        if not authorization.startswith("Bearer "):
            raise ValueError("知识库认证缺失")
        self.url, self.counter = url, 0
        self.headers = {"Authorization": authorization, "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream"}
        self.opener = urllib.request.build_opener(NoRedirect())
        self.rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "channel-blog-relay", "version": "1"}})
        self.rpc("notifications/initialized", {}, notification=True)

    def rpc(self, method, params, notification=False):
        self.counter += 1
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            body["id"] = self.counter
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(),
                                     headers=self.headers, method="POST")
        with self.opener.open(req, timeout=20) as response:
            data = response.read(2 * 1024 * 1024 + 1)
            if len(data) > 2 * 1024 * 1024:
                raise ValueError("知识库回复过大")
            session = response.headers.get("Mcp-Session-Id")
            if session:
                self.headers["Mcp-Session-Id"] = session
        text = data.decode("utf-8")
        if text.startswith(("event:", "data:")):
            text = "\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
        value = json.loads(text) if text.strip() else {}
        if value.get("error"):
            raise ValueError("知识库请求未确认")
        return value.get("result", {})

    def call(self, name, arguments):
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise ValueError("知识库操作未确认")
        value = result.get("structuredContent")
        if value is None:
            blocks = [x["text"] for x in result.get("content", []) if x.get("type") == "text"]
            if len(blocks) != 1:
                raise ValueError("知识库回复格式不正确")
            value = blocks[0]
        for _ in range(4):
            if isinstance(value, str):
                value = json.loads(value)
            elif isinstance(value, dict) and set(value) == {"result"}:
                value = value["result"]
            else:
                break
        if not isinstance(value, dict):
            raise ValueError("知识库回复不是记录")
        return value


def validate_article(value):
    if not isinstance(value, dict) or set(value) - FIELDS or value.get("format") != "markdown":
        raise ValueError("只接收网站 Markdown 草稿")
    limits = {"title": 200, "slug": 120, "excerpt": 500, "authorName": 120,
              "seoTitle": 200, "seoDescription": 320, "body": 131072}
    for name, limit in limits.items():
        if name in value and (not isinstance(value[name], str) or len(value[name]) > limit):
            raise ValueError("文章字段格式不正确")
    if not value.get("title", "").strip() or not value.get("body", "").strip():
        raise ValueError("文章标题或正文缺失")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value.get("slug", "")):
        raise ValueError("文章需要稳定的英文网址名")
    if value.get("authorName") != "Diversity Technology Limited":
        raise ValueError("文章作者与企业绑定不符")
    return dict(value)


def parse_document(document):
    if document.get("workspace_id") != WORKSPACE:
        raise ValueError("文章不在 diversity 工作区，未提交网站")
    content = document.get("content", "")
    try:
        envelope = json.loads(content.removeprefix(SOURCE_PREFIX))
    except ValueError:
        envelope = None
    if isinstance(envelope, dict):
        if set(envelope) != {"channelBlogSource", "siteId", "article"} or envelope["channelBlogSource"] != 1 or envelope["siteId"] != SITE:
            raise ValueError("知识库文章格式与站点不符")
        article = validate_article(envelope["article"])
    else:
        # Existing document 201 uses a title followed by explicit metadata, then H2正文.
        parts = content.split("\n## ", 1)
        if len(parts) != 2:
            raise ValueError("现有文章缺少明确的正文起点")
        lines = parts[0].splitlines()
        if not lines or lines[0] != "# " + document.get("title", ""):
            raise ValueError("文章标题与知识库记录不一致")
        labels = {"SEO title": "seoTitle", "Intro": "excerpt", "Author": "authorName", "Slug": "slug"}
        article = {"title": document["title"], "format": "markdown", "body": "## " + parts[1]}
        for line in lines[1:]:
            if not line.strip():
                continue
            name, separator, value = line.partition(":")
            field = labels.get(name)
            if not separator or not field or field in article:
                raise ValueError("文章元数据需要整理，未猜测或改写正文")
            article[field] = value.strip()
        if len(article.get("excerpt", "")) <= 320:
            article["seoDescription"] = article.get("excerpt", "")
        article = validate_article(article)
    if article["title"] != document.get("title"):
        raise ValueError("文章内容与知识库标题不一致")
    return article


def document_id(value):
    if not isinstance(value, int) or isinstance(value, bool) or not 0 < value <= 9007199254740991:
        raise ValueError("需要真实的知识库文档编号")
    return value


def fetch_document(kb, value):
    ident = document_id(value)
    document = kb.call("get_document", {"document_id": ident})
    if document.get("id") != ident:
        raise ValueError("知识库返回了不同文档")
    parse_document(document)
    return document


def save_source(kb, value):
    article = validate_article(value)
    digest = hashlib.sha256(json.dumps([SITE, WORKSPACE, article["slug"]], separators=(",", ":")).encode()).hexdigest()
    tag = "channel-blog-source:" + digest
    expected = {"channelBlogSource": 1, "siteId": SITE, "article": article}
    listed = kb.call("list_documents", {"tag": tag, "workspace": str(WORKSPACE), "limit": 2})
    rows = listed.get("documents")
    total = listed.get("total")
    if (not isinstance(rows, list) or not isinstance(total, int) or isinstance(total, bool)
            or total < 0 or total != len(rows)):
        raise ValueError("知识库来源查询格式未确认，未创建文档")
    if total > 1 or len(rows) > 1:
        raise ValueError("知识库存在重复来源，请人工核对，未继续创建")
    if rows:
        document = fetch_document(kb, rows[0]["id"])
        if json.loads(document["content"].removeprefix(SOURCE_PREFIX)) != expected:
            raise ValueError("同一文章已有不同内容，请编辑原稿，不另建文")
        return document["id"]
    created = kb.call("add_document", {"title": article["title"], "content": SOURCE_PREFIX + json.dumps(expected, ensure_ascii=False),
                                       "tags": [tag, "channel-blog-private-draft"], "workspace": str(WORKSPACE)})
    if created.get("workspace_id") != WORKSPACE:
        raise ValueError("知识库没有按工作区保存，未提交网站")
    document = fetch_document(kb, created.get("id"))
    if json.loads(document["content"].removeprefix(SOURCE_PREFIX)) != expected:
        raise ValueError("知识库保存内容未确认，未提交网站")
    return document["id"]


def run_json(command, payload, timeout=120):
    completed = subprocess.run(command, input=json.dumps(payload).encode(), capture_output=True,
                               timeout=timeout, env={k: v for k, v in os.environ.items()
                                                     if k in ("PATH", "HOME", "LANG", "LC_ALL")})
    if completed.returncode or len(completed.stdout) > 32768:
        raise ValueError("网站草稿交接未确认，请保留原文档编号重试")
    value = json.loads(completed.stdout)
    if not isinstance(value, dict):
        raise ValueError("网站草稿回执不正确")
    return value


def connect_kb(config):
    if config["role"] == "content":
        values = {}
        for line in Path(config["kbEnvironmentFile"]).read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
        return KnowledgeBase("http://127.0.0.1:9021/mcp", "Bearer " + values["KB_API_KEY"])
    # Reuse the publisher's existing KB read connection; never accept a URL or key from model input.
    import yaml
    entry = yaml.safe_load(Path(config["hermesConfig"]).read_text())["mcp_servers"]["vibekb"]
    return KnowledgeBase(entry["url"], entry.get("headers", {}).get("Authorization", ""))


def invoke(config, operation, payload, kb=None, execute=run_json):
    if config.get("siteId") != SITE or config.get("workspaceId") != WORKSPACE:
        raise ValueError("专用连接与企业工作区不符")
    if config.get("role") not in ("content", "publisher") or not isinstance(payload, dict):
        raise ValueError("专用连接角色不正确")
    if config["role"] == "publisher" and operation == "get-import":
        if set(payload) != {"operationId"} or not re.fullmatch(r"article-import-[a-f0-9]{64}", payload["operationId"]):
            raise ValueError("草稿结果编号不正确")
        return execute([config["python"], config["lockedInvoke"], "--node", config["node"],
                        "--bundle", config["invokeBundle"], "--credential", config["credentialFile"],
                        "--get-import", payload["operationId"]], {})
    if operation not in ("save", "submit") or (operation == "save" and config["role"] != "content"):
        raise ValueError("此连接不支持该操作")
    if set(payload) != ({"article"} if operation == "save" else {"documentId"}):
        raise ValueError("草稿任务字段不正确")
    kb = kb or connect_kb(config)
    ident = save_source(kb, payload["article"]) if operation == "save" else document_id(payload["documentId"])
    document = fetch_document(kb, ident)
    if config["role"] == "content":
        try:
            result = execute(["/usr/bin/ssh", "-F", config["sshConfig"], "-o", "BatchMode=yes",
                              "-o", "ConnectTimeout=12", config["sshHost"], "channel-blog-submit"],
                             {"documentId": ident})
        except (ValueError, OSError, subprocess.TimeoutExpired):
            return {"ok": False, "documentId": ident, "workspaceId": WORKSPACE,
                    "status": "stored-awaiting-handoff", "message": "文章已入库，网站草稿尚未确认；重试请沿用此文档编号。"}
    else:
        result = execute([config["python"], config["lockedInvoke"], "--node", config["node"],
                          "--bundle", config["invokeBundle"], "--credential", config["credentialFile"]],
                         {"documentId": ident, "workspaceId": str(WORKSPACE), "article": parse_document(document)})
    if (result.get("state") != "ready" or not re.fullmatch(r"article-[a-f0-9]{64}", result.get("articleId", ""))
            or result.get("editUrl") != "https://supplychainsai.com/admin/?section=articles&article=" + result["articleId"]):
        raise ValueError("网站草稿结果身份未确认")
    return {**result, "documentId": ident, "workspaceId": WORKSPACE}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--operation", choices=("save", "submit", "get-import"), required=True)
    parser.add_argument("--ssh", action="store_true")
    args = parser.parse_args()
    config = private_json(args.config)
    if args.ssh and (config.get("role") != "publisher" or args.operation != "submit"
                     or os.environ.get("SSH_ORIGINAL_COMMAND") != "channel-blog-submit"):
        raise ValueError("只允许专用草稿交接命令")
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("文章输入过大")
    lock_path = str(Path(args.config).with_suffix(".lock"))
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError("专用连接锁权限不正确")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        result = invoke(config, args.operation, json.loads(data))
        print(json.dumps(result, ensure_ascii=False))
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("网站草稿操作未确认；请保留原文档编号检查此专用连接。", file=sys.stderr)
        sys.exit(1)
