# CUI-01 / CUI-02 — 本地详情读取与选型状态验收

日期：2026-09-06。基线：`fix/alibaba-sync-storage-wiring@60b051b`。
本轮变更仍在当前工作区，未 commit / push / deploy。

## 已完成什么

CUI-01 将网络 unknown 限制在 gateway：有限流式读取 → 复用既有 API envelope reader →
共享 `decodeCatalogProductDetail` → 核对产品、版本、页码和 pageSize。组件不猜原始
Alibaba/Excel JSON，也不会将空响应当成空商品。后续页必须携带 revision。

每页解压后最多 2 MiB，固定字节缓冲避免海量小 chunk 对象；UTF-8 使用严格解码。
Abort、网络错误、404、409、限流、格式和大小错误分别返回显式状态，不输出私有 body。
小集合至多 500 variants / 10 pages / 8 MiB；超规模商品改为单页 SKU 浏览，不截掉第 51 项。

CUI-02 增加纯状态模块，没有 React effects、数据库、provider 分支或网络副作用：

- 每个请求由 controller 预先分配递增 generation，响应必须匹配 generation + productId +
  待接收页。旧商品响应、旧页响应、关闭后的响应、重复提交同一响应都不能覆盖当前数据。
- 完整集合才支持 options 匹配，匹配的是现有 canonical IDs，不生成选项笛卡尔积。
- 多个 ID 具有相同 options 时返回 ambiguous，需要明确选择 ID。SKU 文本可缺失或重复。
- 大小写/同义属性暂不合并；冲突的重复轴转为直接 ID 选择，不猜哪一个值正确。
- URL ID 暂未找到时保持 pending；只有 complete 集合可判 invalid，不能静默选别的 SKU。
- 默认在完整集合中选择第一条 canonical 顺序。分页模式无默认替代，但允许明确选当前页。
- 分页保留当前页和一个已选快照。网络/限流错误保留相同版本供重试；409、schema/header
  错误清掉旧集合和选择。同版本同 ID 返回不同选型内容时也要求刷新。
- unknown/conflict/reported 库存语义原样保留；reported 0 不触发自动换 SKU 或禁止询价。

## 证据与测试

使用本机 Node `v25.6.1`、仓库现有 pnpm/tsx。测试进程加
`NODE_OPTIONS=--no-experimental-webstorage`，原因是本机实验性 localStorage 行为影响已有测试；
不是云端 runtime 修改，也不在产品代码里增加底层 API 依赖。

TDD：gateway / page assembly 的 stub 先得到预期失败，再实现；CUI-02 selection 6 个、
request state 8 个测试先 RED 后 GREEN，再补 2 个相同版本快照/选择竞态回归测试。

| 检查 | 本轮结果 |
| --- | --- |
| gateway 10 + page assembly 8 | 18 / 18 通过 |
| canonical selection 6 + request state 10 | 16 / 16 通过 |
| site 全套测试（含测试 TypeScript 编译） | 284 / 284 通过；无 skipped |
| site Astro typecheck | 0 errors / 0 warnings，7 个既有 hints |
| site production build | 本地构建通过；不代表云端部署 |
| local-server 全套测试 | 64 / 64 通过 |
| local-server typecheck；窄 workspace suite | 通过；13 / 13 通过 |
| Biome 新增模块 + 修改的本地集成测试 | 通过 |
| diff 自审 | 读取实际实现与修改文件；未派发独立 agent review |

可复现命令（仓库根目录）：

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site test
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site typecheck
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site build
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/local-server test
pnpm --filter @vibelingan-channel/local-server typecheck
pnpm exec biome check apps/site/src/catalog apps/local-server/src/catalog-detail-workspace.test.ts
git diff --check
```

新增本地 HTTP 集成测试会在临时 workspace 中分别物化 Alibaba 合成 51-variant observation
和真实店小秘 parser/adapter 解析的合成 XLSX。批准前 gateway 获得 404；本地批准后从
真实 Express → public handler → HTTP → 同一个 browser gateway 读取两种 DTO，核对完整
数量、跨页 ID 和 stale revision。它不是浏览器视觉测试，也不是客户 Excel 整本重跑。

测试 probe 放在 site 的 testing 目录，由 local-server 测试启动独立 Node 子进程，避免
Node-only 编译器把 Astro `import.meta.env` / browser RequestInit 当后端类型；没有添加
类型抑制或修改业务请求选项。probe 只允许回环 HTTP，不发送认证信息。

另经当前 UI-02 本地服务只读检查 3 个先前捕获的真实 Alibaba 样本：

| canonical product ID | variants | images | 读取字节 |
| --- | ---: | ---: | ---: |
| `24ee8f21-1cac-49f0-93a2-30ba1746289f` | 3 | 6 | 4001 |
| `c1cdd2d8-4141-4a5a-8c90-7dc11a163df0` | 6 | 6 | 3434 |
| `227c01eb-b155-4e4a-b78a-8be6d12e3823` | 4 | 6 | 2619 |

三个均通过新 gateway / assembler 并达到 complete；读取前后本地 DB digest 相同。
**这不是新鲜调用 Alibaba，也不是重新同步云端商品。**

## 剩余边界与下一项

1. 当前只完成数据层和纯状态。controller 的 AbortController/effect 接线、可见 UI、真实
   点击/键盘/手机行为仍需 CUI-03..08；状态测试通过不等于页面已切换。
2. paged 模式刻意不保存全局 ID 集合，只检查当前保留页的重叠和已选快照。即使用户跳到
   最后一页，仍不宣称整个商品已检索完；pending ID 需继续翻页或显式清除。不得将它显示
   为“SKU 不存在”或将 50 条当全量。
3. 分类映射、云端 canonical 写入、自动同步、NEW/审核状态、发布、Excel worker、RFQ
   发送均未改动。原 category 审计脏文件与两个源设计 worktree 保留。
4. 下一步 CUI-03：核实媒体模块来源 SHA，选择性移植并让现有 Gallery / ProductMedia
   委托同一媒体规则；CUI-04 才首次展示新详情 UI。
