# 03 云端适配与兼容

2026-10-24补充：下文“现有部署未改”描述10月22日边界。整合后的普通test部署已经在原SEO分支接入静态协调器，仍待真实普通部署验收；通用函数恢复开关继续关闭。当前现场结果见[本轮记录](../../blog/06-integrated-release-worklog-2026-10-24.zh-CN.md)。

正式网站采用小批次上传及精确撤回，每批最多12条、并发最多4个；canary继续逐条。撤回批次在写入前保存每条路径和原hash，以独立的removals字段参与intentHash；不能伪造“空文件hash”表示删除。前后聚合hash、路径顺序及实际计划共同绑定操作。每条删除后仍用普通/重新验证/条件HTTP请求核对404，最终再次全量确认。回执丢失或部分成功均停止并保留整个批次，结束旧进程、确认现场静止后才能核对并接续。旧单文件日志与已部署批次日志不改写。


2026-10-22：C1 与 C2 SDK 适配已实现；C2 的现场版本观测、固定测试/报告生产链和 D1 函数恢复接线也已补上，发布回归 378 项通过。真实 execute 保持关闭；生产资格仍需 B2 的完整版本状态、对应历史函数兼容套件和已验收函数基线。详见[D1 函数入口](module-04-function-entry.zh-CN.md)、[C2 SDK 适配](module-03-c2-adapter.zh-CN.md)和[404 记录](module-06-404-fix.zh-CN.md)。

现有正常部署脚本、workflow、pricing、函数及业务 schema 均未改动。下文保留原模块设计与当时基线；最新实施范围以上述交付记录为准。

## C1 的模块接口

| 文件 | 单一职责 |
| --- | --- |
| `scripts/release/hosting-adapter.mjs` | 把 A2 的 upload/verify/remove/configure/accept 回调接入 B1，每个写操作先落 intent |
| `scripts/release/hosting-provider.mjs` | 包装显式环境的 Manager SDK；单对象上传、精确删除、配置增量请求和控制面读取 |
| `scripts/release/hosting-configuration.mjs` | 配置计划、逐步 before/after 身份、SDK 参数映射、有条件且安全的反向计划 |
| `scripts/release/hosting-readback.mjs` | 同一普通 URL 的正文、状态、MIME、ETag 和缓存验证 |

复用 `hosting-cache-plan.mjs` 的静态专用域名响应头补丁和 `hosting-contract.mjs` 的缓存/错误文档检查。`smoke-http.mjs` 只新增可选的外部 AbortSignal 和 redirect 参数，默认请求行为保持原样。没有在现有 deploy 脚本旁新增另一条自动发布入口；D1 才将旧交付调用方切到这些适配器。原脚本目前继续用原实现。

新增 root devDependency `@cloudbase/manager-node@5.9.1`，用于固定执行合同和运行真实 SDK transport fixture。没有改变既有包的锁定版本。它不进入应用或函数业务代码；以后部署 runner 需要提供相应 Manager 实例。不能以工具当前选中的环境代替显式 envId。

## MIU SEO-REL-C1：状态、命令与读回

### A2 与 B1 的绑定

```js
const configurationPlan = prepareHostingConfiguration({ target, before });
const coordinatedPlan = hostingCoordinatorPlan(hostingPlan, configurationPlan);
// D 在 A1 校验 artifact/来源、B1 选择恢复目标后 startRun。
const callbacks = createHostingRecoveryAdapters({
  plan: hostingPlan, configurationPlan, directory,
  coordinator, guard, runId, provider, errorDocument,
});
const result = await executeHostingRecovery(hostingPlan, callbacks);
// callbacks 完成全部验证后，D 才允许 coordinator.commitRun。
```

A2 planSha256 绑定文件、顺序、scope 和最终状态。B1 的 planSha256 另绑定整个配置计划，防止最终配置相同但中间步骤被换掉。stepCount 为上传数 + 精确删除数 + 配置写入数 + 最终 accept；没有用一条大步骤包住多个配置调用。factory 检查 B1 run 的 plan、scope 和 static 交付范围，并核对租约记录中的 envId/origin 与 SDK 写入目标相同。

回调参数、guard、配置计划和错误文档期望在异步前复制。文件从通过 symlink/大小检查的 artifact 读取并核对 SHA-256，再交给 SDK provider 写入独立、只读的暂存文件；暂存文件保留原扩展名供 COS 判断 MIME。调用方后续修改对象或本地 artifact，不能把上传重定向到另一条路径。

SDK provider 固定捕获 Manager 的一个 Environment，核对构造配置、Environment ID 和 lazy EnvInfo 返回的 ID。网站域名通过带 EnvId 的 DescribeHTTPServiceRoute 单独核对；不会切 MCP 的全局环境。共享桶的 BasePath 由已安装 SDK 处理，测试覆盖逻辑路径到物理路径的转换；共享桶的全桶网站配置修改由 SDK 明确拒绝。

### 一步的生命周期

1. 续租并检查 run、目标和固定计划，读取对象当前 hash/缺失状态。
2. B1 提交 intent/unresolved 后才调用 provider。
3. SDK 提交结果通过计数、逐文件回调或精确逐项删除检查，保存 submitted 回执。
4. HTTP 或控制面读回达到预期，再 confirmStep。
5. 全部文件、删除状态和最终配置重新验收后，才确认 scope accept。C1 本身不移动 active/baseline，交给 B1 commitRun。

资源先于 HTML，发现文件最后，继续由 A2 控制。资源阶段失败后不会继续发 HTML、删除或配置请求。删除只接受 A2 明确拥有的 HTML/发现文件差集；额外拒绝根 index/404、平台/验证文件和旧 hash 资源。不执行目录清理、全站 prune 或 SDK 的 safe 自动回退。

默认 60 秒续租、单操作等待上限 120 秒、单 HTTP 请求上限 15 秒，均有输入范围检查。配置读回间隔默认 1 秒，要求连续两次匹配。失去租约、超时、外部取消或不匹配时停止，尽可能把步骤记为 unknown；无法写日志时，原 intent/submitted 仍然阻止后续写入。

**取消等待不能撤销已发出的 SDK/COS 请求。** 迟到结果不再确认步骤或开始下一步；暂存文件在底层 SDK 自身结束后清理。TTL 过期仍须按 B1 的旧 job 终态及云操作静止证明接手，不立即反向写入。SDK 单对象上传内部可能切到串行重试相同字节；这是同一个 pending 操作的一部分，不提供 C1 层的重复上传重试。

### 普通 URL 与缓存

每个对象先请求标准 URL，再向相同 URL 发 `Cache-Control: no-cache`，最后带 If-None-Match 验证 304 或完整正文。没有随机 query。目录的 index.html 使用访客访问的目录地址；重定向直接失败，不能用别处页面的正文通过检查。

200 正文必须符合 artifact 长度/hash 和已知 MIME；HTML、XML、JSON、文本及所有 404 检查可变内容缓存规则。ETag 必须存在且在本次读回中一致。错误页既核对 HTTP 404，也核对专用 noindex/错误页标记；404.html 作为普通文件读取时同样检查正文标记。

这些是没有强制重验请求头的服务器 GET，**没有模拟浏览器已保存的旧缓存**。旧浏览器 fresh cache 不能被服务器主动删除。provider 的 purgeCapability 明确为 unverified；没有发送 purge，也不把请求受理视为浏览器缓存已清。已有缓存的 context、真实 CDN 和网络收敛仍由 F1 验收。

### 配置与反向计划

`prepareHostingConfiguration` 从当前配置准备逐个变更：网站错误文档，以及现有 DIRECT 静态专用域名的响应缓存头。域名必须恰好只有 `/`、`/*` 两条归属明确的 STATIC_STORE 路由，且路由级没有冲突缓存头。请求仅发送 Domain 与 Extension，不发送含历史通配符的 Routes。缓存补丁不包含证书、AccessType、上游、API 路由或路径重写；保留其他扩展和头部。网站配置只映射已安装 SDK 支持的字段，未知字段或不能无损表达的路由直接拒绝。

每个变更保存完整 before/after，以及配置状态投影的 hash。仅排除平台维护的 Domain/Route CreateTime/UpdateTime，其余字段仍参与比较。artifact 的原始配置快照 hash 保持不变；回执同时保留实际原始读回 hash 和状态 hash，先验证内容投影相同，再满足 A2 的快照引用，不把两种身份混称。provider 在调用前重新读取当前值，比较后才发最小参数；这不是服务端 CAS，仍要求 D1 让所有写入方持有同一交付锁。配置请求返回 RequestId 也不足以验收：控制面连续匹配后，最终 HTTP 检查仍须通过。

`inverseHostingConfiguration` 要求当前值仍等于该计划的 after，且 prior 配置满足安全要求。旧首页错误兜底、长缓存、路由归属变化或证书/API 被其他发布修改时，不自动覆盖。保留当前安全值或重新生成向前修复计划。本期没有“允许不安全反向”的开关。

当前线上缓存不满足旧部署 preflight 的历史观察仍未被本轮修改。D1 接入时须在单独受控的配置准备阶段处理，并验证后再交付页面；不能先上传一半，再以缓存失败触发反复上传。

## pricing / product sync 的整合边界

本轮只读检查 `origin/feat/catalog-alibaba-price-tiers@39705e23` 与 `origin/fix/alibaba-sync-storage-wiring@bcee8f2f` 的相关已提交共享路径。前者增加了 configurationPhotos、supplierDecisions、alibabaReviewReason 等字段和公开投影约束；后者调整了发布校验和数据库适配。因此没有把“理论上不会改 schema”当成已验证事实，也没有据此判断一定有破坏性迁移。

C1 不读写这些商品字段。它们与 B2 的公开内容 generation / writer 清点有关，留到整合窗口。product sync 分支也动了 package/lockfile，后续需正常合并并重新解析依赖；本轮锁文件比较确认旧包版本未变。`hosting-integrity.mjs` 在相关分支中存在，本轮只复用底层 HTTP 生命周期，没有改它或 deploy 脚本。没有检查、修改其他 worktree 的未提交工作。

## 后续线上写入的范围和恢复办法

本轮没有云端写入，也没有创建控制集合或启动远端部署。接入 D1 后先执行 F1 的静态 canary：

- 事前确认一个固定、无业务链接且没有其他所有者的 canary 前缀，核对域名、envId、当前配置和路径清单；不能假定候选前缀可用。
- 先保存 A 的可信 artifact / 当前配置与路径证据，取得现有 Actions 部署锁和 B1 租约，再按该前缀交付 B。canary 禁止全局配置变化、商品/发现文件和函数/数据库变更，代码已检查这些边界。
- 手动选定 A 恢复并验收；每次恢复使用新 activationId，只更新 canary scope。保留旧 hash 资源和历史记录，只移除确认属于本次演练的退役 HTML。
- 写入结果不明时停止，保留 intent、暂存调用状态和现有站点；先证明旧 job 与云调用结束，再决定读回、继续或恢复。没有自动删库、数据库 down 或重复恢复链。

全局 404/缓存修正另列精确计划和影响说明，持同一锁进行。它会影响整站静态响应，不能混在 canary 内悄悄执行，也不能与 pricing 的交付窗口交错。真实 A/B/A、旧缓存和恢复耗时通过后，才允许对应线上范围。

## MIU SEO-REL-C2：兼容当前数据的函数代码恢复

当前发布依次更新函数代码、等待 Active、更新配置、再交静态；运行时漂移已经会拒绝。目标保留这些有效检查，新增固定旧包、兼容证明及范围计划。

```js
const decision = evaluateCompatibility({ currentData, exposedClients, baseline, componentDiff });
if (decision.status !== 'allowed') return manualRequired(decision.reasons);
await recoverApprovedComponents(decision.components, { journal, guard });
```

函数包从已验收 CI 的不可变 payload 取得，包含完整包 hash、运行时、handler、层引用及运行身份；不重新编译旧 Git 提交。复用已有 bare-temp 冷启动 smoke 和发布 SHA 健康检查。包 hash 证明待上传字节，健康标识证明运行中的代码，二者不能互相替代。

兼容记录按组件包含 `readerFormats/writerFormats`、当前数据格式范围、公开 API 版本、已暴露新客户端与候选旧 API 的兼容结果、旧写入保留未知字段的证据、需要配置引用和测试 ref。缺记录即拒绝自动降级，不能默认 compatible。函数代码可恢复而配置不可恢复时，要有“保留当前兼容配置”的明确计划，否则整个相关组件不自动恢复。

环境变量更新按平台整份替换处理：区分受部署管理的 key 和非管理 key，安全读取并保留后者。`***` 等脱敏值不能写回；只有可信 runner 能在内存中取得完整值或有效 secret 版本引用时才修改。明文不进日志、artifact、兼容报告或聊天。当前读取只拿到脱敏结果时，配置写入资格为 denied，不退化成 manifest-only 覆盖。

数据库字段默认保留、旧字段可以继续兼容读取。此模块不含数据库迁移器、down、删列/表或清理历史记录。旧代码因新约束/数据格式无法写入时，选择兼容修复向前。已有的破坏性 AI migrateDown 完全不在调用图中。

恢复先确保服务端兼容已暴露的新旧客户端，再恢复前端，最后处理允许回退的配置/代码。旧 API 不兼容新客户端时保留当前兼容服务或拒绝，不能一律逆序降级。首期只覆盖已有且有可信基线的函数；新增函数/触发器没有旧版本时，不用 delete/recreate 当恢复。

拟测试 `old writer preserves new field`、`new constraint denies old writer rollback`、`new client rejects incompatible old API`、`masked config never submitted`、`verified function baseline restores code identity`。命令 `node --test scripts/release-compatibility.test.mjs scripts/cloudbase-function-state.test.mjs`；涉及 SDK 面时再运行 `pnpm verify:cloudbase-sdk`。线上只做一次无业务影响的 API 标记 A/B/A 验收。

## 平台合同的证据边界

本轮已核对固定提交的调用顺序、现有 SDK 适配和官方管理工具文档。新函数别名/版本切流、原子托管激活、逐路径 503、PG PITR 均不作为本期实现前提。实施 C 时按当时安装版本核对具体 transport/返回字段并保存 contract receipt；没有证据的动作保持关闭，不向 SDK shim 添加方法。见 [SDK 合同规则](../../CLOUDBASE_SDK_CONTRACT_VERIFICATION.md)。
