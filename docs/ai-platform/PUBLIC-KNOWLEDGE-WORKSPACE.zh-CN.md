# 官网小助手读哪些知识库文档

> 2026-11-10 起生效。机制本身在知识库服务（`vibelingan/vibekb`）里，完整设计见该仓库的
> `docs/public-workspace.md`。本文只说官网这一侧。

## 规则

知识库里每个客户有两个工作区：内部的 `diversity`，对外的 `diversity-public`。
**放进 `diversity-public` 的文档，官网小助手立刻能读到；移出去，立刻读不到。** 不需要部署官网，也不需要改任何变量。

官网（`ai-worker`）只持有一把公开只读 key（`VIBEKB_PUBLIC_API_KEY`，以 `kbpub_` 开头）。
知识库服务端把这把 key 绑定到 `diversity-public`：它只能检索、列出、读取这个工作区的文档，
不能写、不能删、看不到其他工作区。

## 官网不再做的事

- 不再有文档 ID 白名单（`VIBEKB_PUBLIC_DOCUMENT_IDS`）、公开标签（`VIBEKB_PUBLIC_TAG`）、工作区 ID
  （`VIBEKB_PUBLIC_WORKSPACE_ID`）。「对外公开」标签不再有任何作用。
- 不再持有知识库的管理 key（`VIBEKB_MCP_API_KEY`）。

## 官网仍然检查的两件事

都是防「配错 key」，不是判断哪篇文档公开：

1. key 必须以 `kbpub_` 开头且不少于 32 位，否则 `ai-worker` 拒绝启动；
2. 连接后对方必须自报为公开只读服务（`knowledge-base-public`），否则一篇文档都不读。

管理 key 被误填进来时，这两条都过不了。

## 每次回答读多少

每个问题最多取 3 篇文档，每篇只取前 10000 字符。所以对外文档每篇应控制在 8000 字符以内，
长资料按主题拆成多篇（内容助手的入库规则里已写明）。问题没有检索到任何文档时，取最近更新的 3 篇公开文档。

## 部署所需

| 位置 | 名称 | 说明 |
|---|---|---|
| GitHub secret（`test` 环境） | `VIBEKB_PUBLIC_API_KEY` | 新增。知识库 `.env` 里 `KB_PUBLIC_KEYS` 配的那把 `kbpub_…` |
| GitHub variable | `VIBEKB_MCP_URL` | 不变 |
| GitHub secret | `VIBEKB_MCP_API_KEY` | 上线验证后删除 |
| GitHub variable | `VIBEKB_PUBLIC_DOCUMENT_IDS` / `VIBEKB_PUBLIC_TAG` / `VIBEKB_PUBLIC_WORKSPACE_ID` | 上线验证后删除 |

`ai-worker` 启动时会检查公开工作区里至少有一篇文档，所以**必须先让知识库服务上线并放入公开文档，再部署官网**。
完整顺序见 vibekb 仓库 `docs/public-workspace.md` 的「上线顺序」。
