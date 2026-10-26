"""Run one isolated local Hermes content task using only the two draft tools."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--initialize-only", action="store_true")
args = parser.parse_args()
root = Path(os.environ["HERMES_AGENT_ROOT"]).resolve()
home = Path(os.environ["HERMES_HOME"]).resolve()
profiles = (Path.home() / ".hermes/profiles").resolve()
if home.parent != profiles or not home.name.startswith("channel-blog-acceptance-"):
    raise SystemExit("Use an owned channel-blog-acceptance profile, not the normal Hermes home")
if not (root / "run_agent.py").is_file():
    raise SystemExit("Explicit installed Hermes runtime required")
output = Path(__file__).resolve().parents[2] / "output/hermes-blog-live"
output.mkdir(parents=True, exist_ok=True, mode=0o700)
sys.path.insert(0, str(root))
from run_agent import AIAgent
from hermes_cli.runtime_provider import resolve_runtime_provider
from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers

try:
    runtime = resolve_runtime_provider(requested="openai-codex", target_model="gpt-5.6-terra")
    discover_mcp_tools()
    agent = AIAgent(
        api_key=runtime["api_key"], base_url=runtime["base_url"],
        api_mode=runtime.get("api_mode"), model="gpt-5.6-terra", provider="openai-codex",
        enabled_toolsets=["mcp-channelblog"], max_iterations=8, quiet_mode=True,
        save_trajectories=False,
    )
    names = sorted(t["function"]["name"] for t in agent.tools)
    assert names == ["mcp__channelblog__channel_blog_create_draft", "mcp__channelblog__channel_blog_get_import"], names
    if args.initialize_only:
        print(json.dumps({"stage": "initialized", "tools": names, "modelCalls": 0, "websiteWrites": 0}))
    else:
        started = time.time()
        result = agent.run_conversation(
            user_message="""Write and save one useful English draft explaining how a buyer can prepare an OEM headphone enquiry.
Use 250 to 400 words with H2 headings, short paragraphs and a practical checklist. Give general guidance only; do not invent company capabilities, specifications, certifications or prices. Do not include HTML, images, tables, H1, footnotes or external links.
Save it using channel_blog_create_draft with these exact fields:
idempotencyKey: hermes-local-20261026-v1
externalTaskId: channel-blog-acceptance-20261026
format: markdown
title: How to prepare a clear OEM headphone enquiry
slug: oem-brief-hermes-acceptance-20261026
authorName: Diversity Technology Limited
seoTitle: How to prepare a clear OEM headphone enquiry
excerpt: A practical checklist for preparing product requirements, samples, packaging and delivery details before requesting an OEM headphone quotation.
seoDescription: Prepare an OEM headphone enquiry with clear use cases, quantities, connection preferences, sample criteria, packaging and delivery requirements.
body: your generated Markdown.
After saving, query its receipt once using channel_blog_get_import. Return the confirmed editor link and say that a human still needs to review and publish. If a call fails, report it; never change the fixed task or draft key.""",
            system_message="You are the isolated content helper for this acceptance task. Your only capabilities are creating one private draft and reading its receipt. Never claim an article is published. Do not request or reveal credentials.",
            task_id="channel-blog-acceptance-20261026",
        )
        with (output / "conversation.json").open("x", encoding="utf8") as handle:
            os.chmod(handle.name, 0o600)
            json.dump(result, handle, ensure_ascii=False, default=str)
        calls = [call for m in result.get("messages", []) if m.get("role") == "assistant" for call in (m.get("tool_calls") or [])]
        sources = [json.loads(call["function"]["arguments"]) for call in calls
                   if call.get("function", {}).get("name") == "mcp__channelblog__channel_blog_create_draft"]
        assert len(sources) == 1, "Exactly one model-generated draft request required"
        source = sources[0]
        assert source["externalTaskId"] == "channel-blog-acceptance-20261026"
        assert source["idempotencyKey"] == "hermes-local-20261026-v1"
        with (output / "source.json").open("x", encoding="utf8") as handle:
            os.chmod(handle.name, 0o600)
            json.dump(source, handle, ensure_ascii=False)
        summary = {"stage": "model-returned", "tools": names, "modelCalls": result.get("api_calls"),
                   "toolCalls": [c.get("function", {}).get("name") for c in calls],
                   "seconds": round(time.time() - started, 3), "humanPublicationRequired": True}
        (output / "model-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf8")
        print(json.dumps(summary))
finally:
    shutdown_mcp_servers()
