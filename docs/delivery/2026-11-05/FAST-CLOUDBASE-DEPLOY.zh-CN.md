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

## 5. 实测结果（Deploy Test 41972333945，4b066cf4）

2026-11-05 店主同意后，把 #73、#74 合入 `release/assistant-seo-20261104`，`test` 快进到 4b066cf4。运行成功，三个函数的 health 均报告 releaseId 4b066cf4，网站首页 200。

| 项目 | 41850270700 | 41972333945 |
| --- | --- | --- |
| 整个 Deploy Test 运行 | — | 37 分（05:10–05:47 UTC） |
| 任务“Build, deploy, and smoke test” | 79 分 | 26.7 分 |
| Deploy to CloudBase test | 19 分 | 6.0 分 |
| 40 个集合确认 | 11.5 分 | 约 1.4 分（首末 ready 行 05:34:00–05:35:23） |
| `alibaba-catalog-sync` 私有 ZIP | 4.7 分 | 2.1 分（同一单流路径，链路波动） |
| 网站交付 | 43.7 分（555 个文件） | 7.2 分（0 个文件变化） |

- 本次网站没有文件变化，所以 #73 的批次上传没有被实际执行；它的提速仍待下一次有页面变化的部署确认。
- 网站交付 7.2 分里，私有恢复包上传（83 MB）占 2.8 分。
- 上一次运行（41878896329）在清理临时区域函数时失败；本次清理在提交后约 5 秒内完成，没有触发新的等待上限。
- 回滚点：本次运行在写入前保存的函数原包与托管备份（步骤 21–23 的产物）；上一份已验收网站与函数版本为 3f1851cc。

## 6. 未变的函数不再上传代码

### 6.1 为什么以前做不到

每个函数的 `tsup.config.ts` 都把 `CHANNEL_BUILD_SHA`（commit）和 `CHANNEL_BUILD_TIME` 编译进代码。所以源码没变时，每次提交的包也都不一样。函数恢复和目录运行时准备（`stage-catalog-runtime.ts`）都把 health 里的 `releaseId` 当作“正在运行哪份代码”的证据，所以这个版本戳不能简单移到环境变量里。

### 6.2 现在的判断

- **版本戳固定：** 部署任务在打包前把 `CHANNEL_BUILD_TIME` 固定为 commit 时间，部署步骤因此知道新包里的两个版本戳。
- **逐字节比对：** 部署前一步（步骤 22）已经把每个正在运行的函数包保存在 `output/function-backup-before/`。部署时把新包里的新版本戳换成线上 health 报告的旧版本戳，然后要求和线上包逐字节相同：`index.js`、`package.json`、原生解码器文件都要相同，文件集合也必须一致。
- **出错一律上传：** 任何不一致、读取失败、版本戳格式不对或找不到备份，都按原来的方式上传。`CLOUDBASE_FORCE_FUNCTION_CODE=1` 可以强制全部上传。
- **跳过上传的函数：** 仍然更新配置（环境变量照常整体替换），然后确认 health 仍是原来那份代码，并且已经带上本次部署编号。

### 6.3 版本怎么报告

- `releaseId` 仍然是“正在运行的这份代码由哪个 commit 构建”，函数恢复、目录运行时准备和人工核对的含义都不变。被跳过的函数会继续报告较早的 commit。
- 新增 `deployedReleaseId`：部署在配置里写入 `CHANNEL_DEPLOYED_RELEASE`（本次部署）和 `CHANNEL_DEPLOYED_CODE`（它确认过的代码 commit）。只有正在运行的代码的 `releaseId` 等于 `CHANNEL_DEPLOYED_CODE` 时，health 才报告 `deployedReleaseId`。如果代码被其他途径替换，这个字段会自动消失，不会冒充本次部署。
- 部署写出 `output/function-release/releases.json`，冒烟检查据此核对每个函数应有的 `releaseId` 和 `deployedReleaseId`。手动目录验收接受 `deployedReleaseId`（没有时退回 `releaseId`）。

### 6.4 预计效果与上线顺序

`alibaba-catalog-sync` 源码很少变化，每次可省约 2–5 分钟（ZIP 上传加代码导入激活）；admin 和 public-api 各约半分钟。

第一次部署这项改动时，`packages/shared` 的 health 代码变了，三个函数都会正常上传。从第二次起，没有改动的函数才会跳过上传。
