# 模块 03 / C1 验证记录

C1 已实现并完成本地 SDK 合同与 HTTP 联测。没有执行真实托管写入、修改缓存、清理线上路径或创建控制集合。C2、D1 和真实 F1 验收仍未完成；本页不能作为线上恢复资格证明。

## 基线和写入范围

- SEO 基线：`feat/seo-foundation@ae123b7f93ed2a64a5fde56fa1bdef805bdcdb78`。保持同一分支和 worktree。
- fetch 后 main：`37bcea5b38284210159e95f8d10f3a9b5cf2ee44`。
- 只读接口参照：pricing `39705e23`，product sync / storage wiring `bcee8f2f`。两者有商品字段、公开投影或发布校验变化，未将其等同于破坏性 DB 迁移，也没有审阅或修改其他 worktree 的未提交内容。
- 新增四份 `scripts/release/hosting-*.mjs`、两份 fixture、四份测试；共享文件只改 `smoke-http.mjs` 的可选取消/重定向参数及 `hosting-contract.mjs` 的错误正文校验导出。
- root package/lockfile 增加精确版本 Manager SDK。原有 package/snapshot 项和其他 workspace importer 均未改变；root importer 只增加这一个 devDependency，新增 268 个锁定包。后续整合 product sync 时仍需正常合并依赖，不能覆盖对方 lockfile。
- 原 deploy 脚本、四份既有 CI/部署 workflow 和 SEO offline workflow 保持与基线逐字节相同。没有改前端、函数、商品事务、数据库 schema 或定时任务。

工作文件放在该 checkout 忽略的 `output/seo-module-03-2026-10-21/`；测试使用该目录内的源代码导出，没有新增 Git worktree。源码同步回真实 checkout 后再按同一份文件 hash 提交。

## 可重复的检查

Node `22.13.0`，pnpm `11.5.0`。

| 检查 | 结果 |
| --- | --- |
| C1 + A2/B1 + 原托管/HTTP 定向回归 | 118 个通过，0 失败 |
| `pnpm lint` | 825 文件通过 |
| `pnpm verify:cloudbase-sdk` | 通过，既有 node/wx SDK 集成保持有效 |
| 默认 `pnpm test` | 最终源码正常退出 0；3016 个测试通过，其中根脚本 662 个，0 失败 |
| lockfile 对比 | 旧包版本未改，只有 root importer 增加 Manager SDK |

定向命令：

```sh
node --test --experimental-test-coverage \
  scripts/release-adapters.test.mjs scripts/release-provider.test.mjs \
  scripts/release-readback.test.mjs scripts/release-configuration.test.mjs \
  scripts/release-coordinator.test.mjs scripts/release-store.test.mjs \
  scripts/release-integration.test.mjs scripts/hosting-contract.test.mjs \
  scripts/hosting-integrity.test.mjs scripts/smoke-http.test.mjs
```

完整 `pnpm test` 遵循现有脚本排除真实 PostgreSQL 的三个包；它不是浏览器 E2E 或生产数据库验收。没有因为失败而跳过既有用例。首轮定向回归因离线安装未完成而缺少 node-sdk；补齐 frozen 依赖后，原断言全部重新运行。

## 关键行为证据

- 普通 URL、重新校验和 ETag 条件请求返回一致的预期正文；状态、MIME、字节上限、ETag、超时、外部取消和重定向均有反例。没有随机 query。
- 404 必须是专用错误正文，404.html 作为普通文件也检查标记；首页正文配 404 状态不能通过。
- A2 + B1 + 安装 Manager SDK + 本地 HTTP 的完整恢复实际改变临时文件，先记录 intent 再调用 COS transport。accept 之前不移动 active/baseline。
- 资源上传失败不继续 HTML、删除或激活；配置受理后不收敛仍为 unknown；迟到 SDK 结果不能补确认或开启下一文件。
- 过期/丢失租约、跨 envId 或跨 origin 的租约、可变回调参数、暂存文件扩展名和本地 artifact 修改都有确定性检查。
- canary 正常路径只恢复其前缀，保留根页面和全局配置，不移动整站 baseline；即使重算 plan hash，越出 canary 前缀也不能通过。
- 配置补丁保留证书、API 路由、上游、路径重写、其他扩展与响应头；完整 before/after 不匹配时拒绝覆盖。旧首页兜底、长缓存或不认识的网站配置不能被静默恢复。
- SDK 上传计数必须与实际逐文件完成回调相符；删除逐项错误不能算成功。共享桶上传/删除的物理 BasePath 有测试，桶级网站配置写入被拒绝。

## SDK 合同依据

固定 `@cloudbase/manager-node@5.9.1`，读取了安装包的 hosting/storage/environment/env 实现及类型。fixture 使用实际 SDK 服务，仅替换 Cloud API requestFn 和 COS transport；没有模拟一套不存在的 SDK 方法。

核对了 [Manager Hosting 文档](https://docs.cloudbase.net/api-reference/manager/node/hosting)、官方 MCP 文档查询返回的托管参数，以及 SDK 的 `describeHttpServiceRoute` / `modifyHttpServiceRoute`。Context7 在本轮未提供。MCP 的 auth status 和官方文档查询为只读，本轮没有用 MCP 改当前站点资源。

几个影响实现的实际合同：EnvInfo 通过 EnvBaseInfo 映射；hosting 单文件上传返回 successCount/totalFiles/failedFiles 并提供逐文件回调；单文件删除返回 Deleted/Error；SDK 的网站 setter 只能表达指定字段，某些组合路由无法无损映射；共享桶禁止全桶网站配置写入。新文档中的 SDK safe/prune 能力没有被开启。

## 自审和措辞核对

实际审阅了四份 C1 实现、四份 C1 测试、两份网络 fixture、`hosting-recovery.mjs`、`state.mjs`、`hosting-cache-plan.mjs`、`hosting-contract.mjs`、`smoke-http.mjs`、部署脚本和 workflow 的相关边界，以及模块设计页和执行索引。沿用 Engineering Craft 的 Deploy、Counters 和 E2E 规则；按用户禁止委派的要求，本轮为作者自审。

补充真实 API 的 Domain/Route CreateTime/UpdateTime 后，复现并修正了配置永不收敛的问题。C1 分开记录不可变 artifact 快照身份、实际原始读回 hash 和配置状态 hash；只排除两种已确认的服务端时间字段，证书、路由和扩展仍参与比较。旧备份格式没有变化。

自审用 RED→GREEN 修正了 MIME 暂存文件名、外部 EnvInfo、静态路由空集合、普通 404 文件正文、canary 范围、可变回调输入、SDK 缺少完成回调及租约与写入目标不一致的问题。原始失败和最终通过日志保存在本轮 output 中。

文档将“真实读回已验证”限定为“本地 HTTP 读回和安装 SDK 合同通过，真实托管尚未验收”。核对依据是 HTTP 服务器仅绑定 loopback、SDK transport 被替换、线上没有 mutation 调用。取消仅能停止等待/HTTP 请求，不能撤销 SDK/COS 调用；purge 和旧浏览器缓存没有被写成已解决。

## 启用前的缺口

D1 仍需把现有交付入口、Actions 共享锁、B1 控制集合和可信 artifact 归属接起来，保证所有写入方都经过同一互斥边界。C1 没有新增可执行的部署 CLI，也不认证 artifact 的 GitHub 来源；这是 A1/D1 的责任。

C1 的本地连续读回不证明真实云端生命周期或网络收敛。F1 先按模块设计页约定 canary 的精确前缀、A/B/A 恢复输入及停止条件，再写线上。全局缓存/404 迁移另行说明范围；已有缓存浏览器、真实 HTTP/API 行为和恢复耗时都待现场验证。商品恢复仍需 B2；函数恢复仍需 C2。没有执行数据库 down、删字段或全库覆盖。

下一次交付：模块 04 / D1 的受控人工入口，先面向静态 canary；C2 和自动恢复 D2 保持关闭。

## 2026-10-21 F1 发现的补充约束

静态网站配置需要明确设置 `ErrorDocument.OriginalHttpStatus=Enabled`；缺失或 Disabled 不能作为安全配置。相同的 `404.html` 路径也必须允许修正这个标志。安装 SDK 使用 Enabled/Disabled 字符串，不是 true/false。

现场已证明 COS 源站返回正确 404 时，当前 STATIC_STORE 网关仍可能返回 200；恢复源配置后，外部响应也未立即跟随。C1 配置写入/读回能力不等于公网恢复能力，F1 保持未通过、D1 执行保持关闭。详情与恢复状态见[模块六记录](module-06-verification.zh-CN.md)。
