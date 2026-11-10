"""One SSH request to the existing model or the public read-only VibeKB scope. No credential export."""
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

BASE = Path("/opt/vibekb/mcp-kb")
PUBLIC_WORKSPACE = "diversity-public"
READ_TOOLS = {"search_documents", "list_documents", "get_document"}

def env_file(path):
    result = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result

def public_key(kb_env):
    """The read-only key the KB server binds to the public workspace (KB_PUBLIC_KEYS)."""
    for item in kb_env.get("KB_PUBLIC_KEYS", "").split(","):
        name, _, key = item.strip().partition("=")
        if name.strip() == PUBLIC_WORKSPACE and key.strip().startswith("kbpub_"):
            return key.strip()
    raise ValueError("public knowledge key missing")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def main():
    config = yaml.safe_load((Path.home()/".hermes/config.yaml").read_text())
    hermes_env = env_file(Path.home()/".hermes/.env")
    kb_env = env_file(BASE/".env")
    model = config["model"]
    model_key = hermes_env.get("CUSTOM_TENCENT_API_KEY") or model["api_key"]
    kb_key = public_key(kb_env)
    if sys.argv[1:] == ["--describe"]:
        print(json.dumps({"model": model["default"], "model_base_url": model["base_url"],
            "mcp": "http://127.0.0.1:9021/mcp", "public_workspace": PUBLIC_WORKSPACE,
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
                if name not in READ_TOOLS:
                    raise ValueError("write or unknown tool denied")
                if "workspace" in args:
                    raise ValueError("workspace argument denied")
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
            # The server scopes documents to the public workspace; only trim the tool list here.
            if request["kind"] == "mcp" and data and data.get("method") == "tools/list":
                def project(frame):
                    result = frame.get("result", {})
                    result["tools"] = [t for t in result.get("tools", []) if t.get("name") in READ_TOOLS]
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
