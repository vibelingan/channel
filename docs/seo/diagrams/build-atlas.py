"""Combine six delivered Archify artifacts into one offline reading document.

Usage: python3 docs/seo/diagrams/build-atlas.py output/seo-final-2026-10-20
Requires current deliver receipts; never renders diagrams or calls cloud services.
"""

import hashlib
import html
import json
import pathlib
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    root = pathlib.Path(__file__).resolve().parents[3]
    output = pathlib.Path(sys.argv[1]).resolve()
    chapters = [
        ("hosting-system", "architecture", "职责总览", "先看执行入口、产物、托管与实时后端之间的边界。"),
        ("hosting-release", "workflow", "发布与恢复流程", "上方是现有自动发布；下方是独立显式恢复目标，没有失败自动回滚连线。"),
        ("hosting-publish", "sequence", "发布时序", "从快照到验收；后端先更新，随后静态站逐文件上传。"),
        ("hosting-backup", "sequence", "备份时序", "两次清单和配置比对、漏文件补取、文件完整性与归档门禁。"),
        ("hosting-recovery", "sequence", "恢复时序", "执行内核已有；锁内云端入口、来源与发现文件一致性等门禁待接入。"),
        ("product-access", "sequence", "商品访问时序", "访客与爬虫收到同一份初始 HTML，React 接管后通过 API 更新。"),
    ]
    payload = []
    for name, kind, title, note in chapters:
        artifact = output / f"{name}.html"
        specification = root / "docs/seo/diagrams" / f"{name}.{kind}.json"
        receipt = json.loads((output / f"{name}.delivery.json").read_text())
        if not receipt.get("ok"):
            raise ValueError(f"No successful deterministic delivery: {name}")
        if sha(artifact.read_bytes()) != receipt["artifact"]["sha256"]:
            raise ValueError(f"Artifact changed after delivery: {name}")
        if sha(specification.read_bytes()) != receipt["specification"]["sha256"]:
            raise ValueError(f"Source changed after delivery: {name}")
        payload.append({"id": name, "kind": kind, "title": title, "note": note,
                        "sha256": receipt["artifact"]["sha256"],
                        "html": artifact.read_text()})
    navigation = "".join(f'<a href="#{name}">{html.escape(title)}</a>'
                         for name, _, title, _ in chapters)
    sections = "".join(
        f'<section class="chapter" id="{name}"><div class="chapter-heading">'
        f'<span class="number">0{index + 1}</span><div><h2>{html.escape(title)}</h2>'
        f'<p>{html.escape(note)}</p></div></div>'
        f'<iframe title="{html.escape(title)}" data-artifact="{name}" '
        'sandbox="allow-scripts allow-same-origin allow-downloads"></iframe></section>'
        for index, (name, _, title, note) in enumerate(chapters)
    )
    template = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Channel SEO · 交付与恢复全图</title>
<style>
:root{color-scheme:light dark;--paper:#f5f7fa;--ink:#142337;--muted:#53657a;--line:#d6e1eb;--card:#fff;--accent:#176c80}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:92px}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif}
header,main,footer{max-width:1600px;margin:auto;padding:28px 32px}header{padding-top:40px;padding-bottom:20px}
.kicker{font-size:13px;letter-spacing:.08em;color:var(--accent);font-weight:650}h1{font-size:clamp(26px,3vw,40px);line-height:1.25;margin:8px 0 14px}
h2{font-size:23px;line-height:1.35;margin:0}p{margin:8px 0;color:var(--muted)}.intro{max-width:1040px}
.answers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:24px 0 12px}.answer{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px}.answer strong{font-weight:650;font-size:17px}
nav{position:sticky;top:0;z-index:5;background:var(--card);border-block:1px solid var(--line);padding:12px 28px;display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
a{color:var(--accent);text-decoration:underline;text-underline-offset:4px}nav a{text-decoration:none;padding:5px 10px;border-radius:6px}nav a:hover,nav a:focus{background:var(--paper);outline:2px solid var(--accent)}
main{padding-top:20px}.scope{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin-bottom:34px}.scope h2{font-size:20px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:650}
.chapter{margin:0 0 42px;scroll-margin-top:16px}.chapter-heading{display:flex;gap:16px;align-items:flex-start;padding:12px 2px}.number{font-size:26px;line-height:1.35;font-weight:650;color:var(--accent)}
iframe{display:block;width:100%;height:1100px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.notice{border-left:4px solid #c67a20;background:var(--card);padding:14px 18px;margin-top:14px}.notice p{color:var(--ink)}footer{border-top:1px solid var(--line);font-size:14px;padding-bottom:50px}
@media(prefers-color-scheme:dark){:root{--paper:#101a28;--card:#162437;--ink:#e1eaf4;--muted:#b2c2d4;--line:#33485c;--accent:#72d5e8}}
@media(max-width:760px){header,main,footer{padding-inline:16px}.answers{grid-template-columns:1fr}nav{position:static;padding:10px;gap:4px}nav a{font-size:14px}iframe{height:1080px}.scope{padding:16px}}
</style></head><body>
<header><div class="kicker">CHANNEL · 2026-10-20 · 方案收口 / 未执行本轮线上变更</div>
<h1>SEO 交付与恢复全图</h1><p class="intro">从系统职责到请求顺序，六张 Archify 图放在同一个离线 HTML 中连续阅读。图内可独立缩放、搜索和切换主题。所有参与方表示逻辑职责，不意味着要新增六套服务。</p>
<div class="answers"><div class="answer"><strong>恢复放在哪里</strong><p>拟放 GitHub Actions 独立运维入口；文件恢复到 CloudBase，不放在客户 app 后台。</p></div><div class="answer"><strong>什么时候恢复</strong><p>人工或经授权 agent 显式触发。发布自动备份，失败报告不会自动启动恢复。</p></div><div class="answer"><strong>恢复哪些对象</strong><p>静态托管文件及审核过的托管配置。函数、数据库和外部媒体有各自的恢复边界。</p></div></div></header>
<nav aria-label="全图章节">__NAV__<a href="#conclusion">审阅与剩余工作</a></nav>
<main><section class="scope"><h2>先确认范围和状态</h2><div class="table-wrap"><table><thead><tr><th>层级</th><th>正常发布</th><th>本次恢复范围</th></tr></thead><tbody>
<tr><td>页面与 SEO</td><td>Astro dist：公开页、后台前端、商品 HTML、sitemap、manifest</td><td>静态文件；当前恢复内核已有，云端任务尚未接入</td></tr>
<tr><td>函数与业务 API</td><td>现有流程先处理函数、网关和触发器</td><td>静态恢复不会撤销后端；须验证旧前端与当前 API 兼容</td></tr>
<tr><td>数据库 / 外部媒体</td><td>沿用业务服务；部署会确保所需资源</td><td>不在静态备份里，需独立保护</td></tr>
<tr><td>运行入口</td><td>现有 Deploy Test，共享目标锁</td><td>拟用手动 workflow_dispatch；当前没有已开放的恢复按钮</td></tr>
</tbody></table></div><p>备份和图文可以核验，不等于线上回滚已可用；test 是现有交付目标，没有额外隔离测试环境。</p></section>
__SECTIONS__
<section class="scope" id="conclusion"><h2>审阅结论与启用前条件</h2><p>保留现有 Astro / React / Cloud Functions 和单目标交付链路。正常构建前失败不会替换现网文件；写入后失败可能留下混合版本，不能承诺自动回滚或固定恢复耗时。</p>
<div class="notice"><p>新确认的恢复缺口：只有 sitemap 残留撤回商品地址、没有对应旧 HTML 时，当前恢复计划仍会接受。须补发现文件与当前公开状态的一致性门禁，才能启用云端恢复。</p></div>
<p>还需接通可信产物下载、当前版本/文件归属与后台发布协调、API 兼容检查、会抛错的云端适配器和真实 URL 验收。共享锁防重叠写，不自动冻结后台数据，也不保证默认等待队列不丢任务。</p>
<p>下一次实施顺序：恢复门禁和锁内接入 → 缓存修改及反向读回 → 整合目标分支交付商品页/404 → 现有目标完整 E2E 与计时演练。</p>
<p>本轮定向测试 41/41 通过，额外合成反例另列未覆盖缺口；没有部署、恢复或修改 pricing。</p></section></main>
<footer>完整方案与审阅报告随交付包提供。组合文档只读内嵌的已交付图，不安装依赖、不读取凭证、不调用业务或云端 API。<br><span id="load-state" role="status">正在装载六张图…</span></footer>
<script id="diagram-data" type="application/json">__DATA__</script>
<script>
const chapters = JSON.parse(document.getElementById('diagram-data').textContent);
let loaded = 0;
for (const chapter of chapters) {
 const frame = document.querySelector(`iframe[data-artifact="${chapter.id}"]`);
 frame.dataset.sha256 = chapter.sha256;
 frame.addEventListener('load', () => {
  loaded += 1;
  document.getElementById('load-state').textContent = `已装载 ${loaded} / ${chapters.length} 张图`;
 }, {once:true});
 frame.srcdoc = chapter.html;
}
</script></body></html>'''
    data = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
    document = template.replace("__NAV__", navigation).replace("__SECTIONS__", sections).replace("__DATA__", data)
    artifact = output / "SEO-DELIVERY-ATLAS.html"
    artifact.write_text(document)
    receipt = {"purpose": "offline-diagram-atlas", "output": str(artifact),
               "sha256": sha(artifact.read_bytes()), "bytes": artifact.stat().st_size,
               "embeddedArtifacts": [{key: chapter[key] for key in ("id", "kind", "sha256")}
                                     for chapter in payload],
               "deterministicSourceBinding": "passed", "browserEvidence": "pending",
               "note": "The combined reading document is not a single Archify schema artifact; each embedded diagram has its own deliver receipt."}
    (output / "atlas-assembly.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(artifact)


if __name__ == "__main__":
    main()
