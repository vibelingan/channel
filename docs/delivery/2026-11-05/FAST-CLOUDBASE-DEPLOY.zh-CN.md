# CloudBase 部署步骤提速：测量、取舍与本次改动

2026-11-05。基线分支 `release/assistant-seo-20261104`（3f1851cc）。本次只改脚本与测试，没有推送 `test`、没有部署，也没有用 CLI 操作云端。“预计节省”是按实测日志推算的，要等店主同意后的下一次普通 test 部署才能确认。网站交付的提速另见 vibelingan/channel#73。

## 1. 实测：19 分钟花在哪里

来源：Deploy Test 41850270700 第 2 次尝试，步骤“Deploy to CloudBase test”，15:46:22–16:05:21 UTC。

| 阶段 | 时长 | 说明 |
| --- | --- | --- |
| 40 个 NoSQL 集合逐个确认（33 个通用 + 7 个文章） | 11.5 分 | 每个约 17 秒，日志全部为 “ready”，没有任何写入 |
| admin、public-api 代码与配置更新 | 约 1.6 分 | CLI zip 路径 |
| `alibaba-catalog-sync` 私有 ZIP 上传（9,138,075 字节） | 4.7 分 | 单流约 33 KB/s |
| 函数激活、配置、网关检查 | 约 1 分 | |

### 1.1 为什么一个集合要 17 秒

`ensureNoSqlResourceSet` 对每个集合依次调用 6 次工具：checkCollection、listIndexes、getResourcePermission，然后无论是否写过，都再把这三项重读一遍作为“验证”。每次调用都通过 `npx mcporter call` 新开一个进程，平均约 2.9 秒（690 秒 / 240 次）。40 个集合共 240 次调用，全部串行。

第二遍重读只在第一遍做过写入（建集合、建索引、改权限）时才有意义。没有写入时，它读到的就是几秒前刚校验过的同一状态：索引定义不一致在第一遍就会停止部署，权限必须完全等于 ADMINONLY。

## 2. 各项措施与预计节省

| 措施 | 本次 | 预计节省 | 说明 |
| --- | --- | --- | --- |
| A. 未写入的集合不再重读第二遍 | **已实现** | 240 次 → 120 次调用，约 **5.8 分** | 有写入的集合仍完整重读校验 |
| B. 集合之间最多 4 个同时检查 | **已实现** | 剩余约 5.8 分 → 约 1.5–2.5 分，约 **3.5–4.5 分** | 集合互相独立；失败后不再开始新的集合 |
| C. 常驻 MCP 连接（一个服务器进程处理全部调用） | 未做 | 再省约 1 分 | 仓库没有 MCP 客户端依赖；CI 用的是未固定版本的 `npx mcporter`，需要先固定版本或新增依赖 |
| D. 私有 ZIP 改用多分片并发上传 | 未做，建议下一步 | 约 **4 分** | 见 2.1 |
| E. 函数代码未变则跳过 | 不可行 | — | 每次构建都把 release id 写进代码，`confirmFunctionCode` 正是靠它确认新代码上线，所以代码每次都会变 |

A+B 预计让集合检查从 11.5 分降到约 1.5–2.5 分，部署步骤从 19 分降到约 9–10 分。并发时 runner 上同时跑 4 个 mcporter 进程，单次调用可能比串行时慢一些，所以给出的是区间。

### 2.1 私有 ZIP 上传（建议，未实现）

现状：ZIP 通过 MCP 工具 `cloudbase.manageStorage upload` 上传，在 `cloudbase-mcp` 内部使用 SDK 默认的单流上传，无法从本仓库调整分片和并发。

仓库已有可复用的做法：`scripts/release/native-function-stage.mjs` 先把同一 ZIP 存成恢复对象（`seo-recovery/objects/<sha>.bin`，32 路分片，本链路实测约 350 KB/s），再在服务器端复制到 `fnzip-upload/<秒>-<16位hex>/alibaba-catalog-sync.zip`，并完整读回核对 SHA-256。`cos-archive-transfer.mjs` 也已允许这个精确的 key 格式。改用它约 30 秒即可完成，另一个好处是新代码的恢复副本也一并保存。

没有在本次做的原因：

- 部署脚本用普通 `node` 运行，而该模块会引入 `.ts` 文件（`packages/media-storage/src/cloudbase.ts`）。
- 它还需要 Node SDK、Manager 和私有归档对象存储接入部署脚本，涉及凭据在进程内的使用。这些应该作为单独的变更评审。

## 3. 本次改动

- `cloudbase-nosql-resources.mjs`：单个集合的检查逻辑改为一个依次产出工具请求的生成器（`collectionSteps`），同步入口 `ensureNoSqlResourceSet` 与新的 `ensureNoSqlResourceSetConcurrently` 共用同一套逻辑。第二遍重读只在本集合发生过写入时执行。并发入口有上限（1–8，默认 4），拒绝重复的集合名；任何一个失败后不再开始新的集合，等已在进行的检查结束后抛出第一个错误。
- `mcporter-call.mjs`：新增 `callMcporterAsync`，与 `callMcporter` 共用同一条命令、参数和超时，结果用同一套解析与错误检查。
- `deploy-cloudbase-test.mjs`：`set_env` 仍先单独执行，让 npx 缓存先就绪；随后把 33 个通用集合和 7 个文章集合一起交给并发入口。异步调用的重试次数和错误脱敏与原 `callTool` 一致。其他调用（函数、网关、触发器、ZIP）不变。
- `docs/CLOUDBASE_DEPLOYMENT_DESIGN.md`：更新集合校验的描述。

没有改动的部分：集合清单、索引与权限要求、索引不一致时停止部署、只增不删的规则，以及函数备份、恢复步骤和网站交付。

## 4. 验证

本地 Node 22.13.0（fnm）：

- `node --experimental-strip-types --test scripts/*.test.mjs`：1822 项全部通过，0 跳过。
- 新增与加强的测试：
  - 未变的集合每个恰好 3 次调用；有写入的集合仍重读。
  - 并发峰值等于 4，调用集合与串行入口完全相同。
  - 失败后不再开始新的集合，且等进行中的检查结束。
  - 拒绝重复的集合名和非法并发值。
  - 异步 mcporter 调用与同步调用的命令、超时完全一致，并拒绝藏在成功退出里的 MCP 错误。
  - 部署脚本先 `set_env` 再并发检查，并在部署函数之前完成。
- 用原模块跑同一组“全部已就绪”的输入：33 个集合 198 次调用；新模块 99 次。
- 改动文件的 Biome 检查、`node --check scripts/deploy-cloudbase-test.mjs` 通过。

真实环境待验证（需店主同意后的普通 test 部署）：

1. 40 行 “ready” 日志的时间跨度从约 11.5 分降到约 2.5 分以内（行的顺序会与清单不同）。
2. 没有新的 mcporter 或 npx 缓存冲突错误。
3. 部署步骤总时长约 9–10 分钟，函数冒烟与网站交付结果不变。
