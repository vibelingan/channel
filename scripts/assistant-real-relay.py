"""One SSH request to the existing model or a fixed public VibeKB scope. No credential export."""
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

BASE = Path("/opt/vibekb/mcp-kb")
WORKSPACE = 2
PUBLIC_IDS = {12}
PUBLIC_TAG = "对外公开"

def env_file(path):
    result = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result

def public(doc):
    tags = doc.get("tags", [])
    if isinstance(tags, str):
        tags = json.loads(tags)
    return doc.get("id") in PUBLIC_IDS and PUBLIC_TAG in tags and not any(
        tag in tags for tag in ["内部", "internal", "private", "channel-blog-private-draft"]
    )

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def main():
    config = yaml.safe_load((Path.home()/".hermes/config.yaml").read_text())
    hermes_env = env_file(Path.home()/".hermes/.env")
    kb_env = env_file(BASE/".env")
    model = config["model"]
    model_key = hermes_env.get("CUSTOM_TENCENT_API_KEY") or model["api_key"]
    kb_key = kb_env["KB_API_KEY"]
    if sys.argv[1:] == ["--describe"]:
        print(json.dumps({"model": model["default"], "model_base_url": model["base_url"],
            "mcp": "http://127.0.0.1:9021/mcp", "workspace_id": WORKSPACE,
            "public_document_ids": sorted(PUBLIC_IDS),
            "knowledge_credential_id": hashlib.sha256(kb_key.encode()).hexdigest()}))
        return
    raw = sys.stdin.buffer.read(131073)
    if len(raw) > 131072:
        raise ValueError("request limit")
    request = json.loads(raw)
    data = request.get("body")
    method = request.get("method", "POST")
    headers = {"Content-Type": "application/json"}
    if request["kind"] == "model":
        if method != "POST" or not isinstance(data, dict) or data.get("stream") is not False:
            raise ValueError("unsupported model request")
        if set(data) - {"model","messages","stream","max_tokens","temperature","response_format","thinking"}:
            raise ValueError("unsupported model fields")
        if "thinking" in data and data["thinking"] not in [{"type":"disabled"},{"type":"enabled"}]:
            raise ValueError("unsupported thinking mode")
        if not 1 <= data.get("max_tokens", 0) <= 4096:
            raise ValueError("token budget")
        data["model"] = model["default"]
        url = model["base_url"].rstrip("/") + "/chat/completions"
        headers["Authorization"] = "Bearer " + model_key
    elif request["kind"] == "mcp":
        url = "http://127.0.0.1:9021/mcp"
        headers["Authorization"] = "Bearer " + kb_key
        headers["Accept"] = "application/json, text/event-stream"
        for key, value in request.get("headers", {}).items():
            if key.lower() in {"mcp-session-id", "mcp-protocol-version"}:
                headers[key] = value
        if method == "GET":
            print(json.dumps({"status":405, "headers":{}, "body":""})); return
        if method == "POST":
            if not isinstance(data, dict):
                raise ValueError("MCP body")
            rpc = data.get("method")
            if rpc == "tools/call":
                params = data.get("params", {})
                name, args = params.get("name"), params.get("arguments", {})
                if name in {"search_documents", "list_documents"}:
                    if str(args.get("workspace")) != str(WORKSPACE):
                        raise ValueError("workspace denied")
                    if name == "list_documents" and args.get("tag") != PUBLIC_TAG:
                        raise ValueError("public tag required")
                elif name == "get_document":
                    if args.get("document_id") not in PUBLIC_IDS:
                        raise ValueError("document denied")
                else:
                    raise ValueError("write or unknown tool denied")
            elif rpc not in {"initialize","notifications/initialized","notifications/cancelled","ping","tools/list"}:
                raise ValueError("MCP method denied")
        elif method != "DELETE":
            raise ValueError("MCP method denied")
    else:
        raise ValueError("destination denied")
    encoded = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, data=encoded, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=100) as response:
            if "event-stream" in response.headers.get("Content-Type", ""):
                parts, size = [], 0
                while True:
                    line = response.readline(65537)
                    if not line:
                        break
                    size += len(line)
                    if size > 524288:
                        raise ValueError("response limit")
                    parts.append(line)
                    if line.startswith(b"data: "):
                        frame = json.loads(line[6:])
                        if frame.get("id") == data.get("id") and ("result" in frame or "error" in frame):
                            parts.append(b"\n\n")
                            break
                body = b"".join(parts)
            else:
                body = response.read(524289)
            if len(body) > 524288:
                raise ValueError("response limit")
            text = body.decode("utf-8")
            # Restrict retrieved documents before they leave the remote host.
            if request["kind"] == "mcp" and data and data.get("method") in {"tools/call","tools/list"}:
                def project(frame):
                    result = frame.get("result", {})
                    if data["method"] == "tools/list":
                        result["tools"] = [t for t in result.get("tools", []) if t.get("name") in {"search_documents","list_documents","get_document"}]
                    else:
                        for block in result.get("content", []):
                            if block.get("type") != "text":
                                continue
                            try:
                                value = json.loads(block["text"])
                            except json.JSONDecodeError:
                                continue
                            if isinstance(value,dict):
                                for key in ["results", "documents"]:
                                    if key in value:
                                        value[key] = [d for d in value[key] if public(d)]
                                        value["count"] = len(value[key])
                                if "workspace_id" in value and (value["workspace_id"] != WORKSPACE or not public(value)):
                                    raise ValueError("document scope changed")
                            block["text"] = json.dumps(value, ensure_ascii=False)
                    return frame
                if "event-stream" in response.headers.get("Content-Type", ""):
                    text = "\n".join("data: " + json.dumps(project(json.loads(line[6:])), ensure_ascii=False)
                        if line.startswith("data: ") else line for line in text.split("\n"))
                elif text.strip():
                    text = json.dumps(project(json.loads(text)),ensure_ascii=False)
            print(json.dumps({"status":response.status,"headers":{k:v for k,v in response.headers.items()
                if k.lower() in {"content-type","mcp-session-id","mcp-protocol-version"}},
                "body":text},ensure_ascii=False))
    except urllib.error.HTTPError as error:
        print(json.dumps({"status":error.code,"headers":{},"body":""}))

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status":502,"headers":{},"body":"upstream_request_failed"}))
        sys.exit(0)
