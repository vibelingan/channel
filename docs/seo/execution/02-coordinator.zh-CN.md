# 02 发布协调器

B1 状态：`implemented / SDK-contract verified`。纯状态转换、CloudBase 事务适配器和只读状态接口已实现；真实 CloudBase 控制集合的并发 fixture 尚未执行，生产写入仍未启用。B2 继续为 `planned`，没有修改 pricing、公开商品事务或现有部署入口。

本轮基线 `feat/seo-foundation@15bd65bb`，核对的最新 `origin/main@37bcea5b` 未变。验证明细见[本模块记录](module-02-verification.zh-CN.md)。

## 交付接口和存储边界

`scripts/release/state.mjs` 提供 `createReleaseCoordinator`，`ledger.mjs` 负责控制记录的校验和固定集合映射，`store-cloudbase.mjs` 只适配已安装的 `@cloudbase/node-sdk` 事务。没有向 wx SDK 类型补方法，也没有把服务端 store 接到浏览器。

四个拟启用的 server-only 集合是 `siteReleaseTargets`、`siteReleaseScopes`、`siteReleaseRuns`、`siteReleaseSteps`。本轮不创建线上集合或修改权限；C/D 接入时须先建立拒绝浏览器读写的规则并执行专用 fixture，不能依赖默认权限。这些记录与业务商品、Alibaba lease、询盘和用户数据分开。所有记录保留，不执行历史清理或业务数据库迁移。

```ts
type TargetState = {
  schemaVersion: 1; targetId: string; target: Target; policyHash: string;
  version: number; nextFence: number;
  lease: null | { ownerRunId: string; runnerRef: string; fence: number;
    acquiredVersion: number; expiresAt: number };
  currentRunId: string | null; dirtyRunId: string | null;
  unresolvedOperation: null | { runId: string; stepId: string; operationId: string };
};
type Guard = { targetId: string; ownerRunId: string; fence: number; acquiredVersion: number };
// Scope 的 active、baseline 引用同一个已验收组合：
// {activationId, sourceRunId, compositionHash}，site/canary 分开。
// Run 记录 scope、kind、plan、实际交付的组件、组合、累计验证步骤、失败原因和 accepted seals。
```

`targetId` 由固定 `repository/envId/siteOrigin` 规范化后计算，不含分支或 scope。目标配置由受信任 runner 装配，不能从用户请求临时换 origin 来建第二把锁。同目标 canary 前缀改变后，policyHash 不匹配会阻止使用旧控制记录；不自动迁移或重置。

SDK store 要求注入显式 envId 的 `app.database()`，并检查实例实际 env 相同。ID 全部确定：target hash、target+scope、target/run hash、target/run/step hash。无 where、扫描、批量删除。每个事务最多 24 次读写，单记录 JSON 上限 128 KiB；组件组合最多 33 项。这些是实现边界，非供应商配额。

## B1：租约、步骤与激活

### 租约和时间

`acquire({ownerRunId, runnerRef})`、`renew(guard)`、`release(guard)` 共用目标记录。默认 180 秒租约，预期由 D 每 60 秒续租；本模块不启动定时器或后台任务。时间来自构造器的可信 clock，操作参数里的 now 不参与授权。

fence 在新租约时递增。Guard 的 acquiredVersion 固定在取得租约时，因此 heartbeat 不会让正在进行的步骤失效；事务同时检查当前 target/version 的合法性、owner、fence 和期限，并在写入时递增 target.version。SDK 冲突重试重新读取这些条件。scope.version 则在最终激活时严格比较 run 开始时的版本。

**过期只表示 stalled。** 新任务不能通过 TTL 直接抢锁。现有 CloudBase API 不认识 fence，也不会因此撤销已发出的调用。丢失租约后禁止开始下一次写入，保留 unresolved 记录供读回。

### baseline 的首次登记

首次正常发布前须有 baseline。`kind:'adopt'` 只接受一个只读 accept 步骤，用于把 C 已归档并实际读回的现状登记为 baseline；不允许 write 步骤，也不能再次 adopt 已有 baseline。空控制表不会被当成空线上站点。

D1 增加 `kind:'initialize'`，仅用于已经证明未占用的 canary 前缀第一次创建静态 A。它可以记录写入并建立 canary 基线，不能用于 site，也不能覆盖已有 canary 基线。前缀清单与普通 404 的证明由 D1 在持锁后重新生成，不能把空控制表当作静态存储为空。见[人工入口](04-workflows.zh-CN.md)。

adopt 的来源与读回证明仍须由 C/D 真实生成。本模块不会因为一份本地 fixture 就登记线上 baseline，也不提供跳过验收的入口。

### 每个外部调用之前记录意图

```js
const step = await coordinator.beginStep({ guard, runId, stepId, component,
  kind: 'write', beforeHash, afterHash, subject, verifySubject, executionId });
// 此时 intent/unresolved 已经提交；外部副作用在事务之外。
const submitted = await cloudAdapter.submit(step);
await coordinator.recordSubmitted({ guard, runId, stepId, receipt: submitted });
const observed = await cloudAdapter.readBack(step);
await coordinator.confirmStep({ guard, runId, stepId, receipt: observed });
```

Run 的 plan 固定 `planSha256 / acceptanceHash / stepCount`。步骤的 intentHash 绑定 target/run/step、fence、executionId、operationId、前后 hash、对象及顺序。最后一步必须是 scope accept，期望身份必须等于 acceptanceHash；之前只能交付显式选中的组件。

回执沿用模块一的 `executionId/planSha256/operationId/subject/expectedHash/observedHash`，增加 `intentHash` 和 `terminal:true`。submitted 仅记录提交；verified 既要身份匹配，也要确认云调用已经结束。false、void、pending、非终态或错 hash 均拒绝。模块一的回调允许这些额外字段，接口联测已执行。

重复 begin 遇到未确定的旧意图时返回 `STEP_REQUIRES_READBACK`，不给第二次调用云 API 的许可。已验证步骤可以重复确认，但计数只增加一次。输入在进入异步事务前复制，调用方后续修改原对象不能改变记录。

### 失败与接手

`markUnknown` 保留 pending；`failRun` 遇到 pending 时不能抹掉它。只有终态的 not-applied 读回，才允许 `failStep` 清除该操作。已经发生的其他写入仍保留 dirtyRunId。lint/build 等写前失败没有 dirty 状态，不因此要求恢复。

`reconcile({expectedVersion, expectedFence, proof})` 仅处理过期租约：要求旧 runner 身份一致、job 已结束、云调用 quiescent、操作身份对应，证据在租约到期后取得且不超过 60 秒。version/fence 必须精确匹配，旧证据不能解除新归属。

proof 是 C/D 从平台取得的受信任 metadata，本模块只校验匹配关系，不认证 GitHub 或查询云端；evidenceRef 不能由浏览器自行证明。读回已经不再变化但内容是部分结果时，可以解除 unresolved，仍保留 dirty 并只允许显式恢复。它不会自动开始恢复。

恢复自身失败也不会清掉原发布造成的 dirty 状态。后续人工恢复成功时，最近的失败恢复和最初失败发布都关联为 `FAILED_RECOVERED`，原失败原因保留。该状态模型不包含 D2 的自动恢复调度或尝试次数策略。

### 组件组合、来源与提交

`startRun` 的 publish/restore 必须显式提供 deliveredComponents。static-only 只换 static，函数交付只换选中的 function；未交付组件沿用当前 baseline 的 artifact 和原 accepted seal。候选 ZIP 中未选择的组件不进入 active。

恢复来源必须是同目标、同 scope 的已验收 run，或默认采用 scope.baseline.sourceRunId。不会按最新 SHA、最大 run ID 选包。对选中组件检查到期；历史 active 的记录不会因到期被清空，实际 artifact 可用性仍由 A/C 验证。

`commitRun({guard,runId,changeSetRef})` 要求全部计划步骤及最终 accept 验证成功，再在同一条件事务中记录实际交付组件的 seals、更新 active/baseline、关联 changeSetRef、清理当前归属。每次 commit 使用新 activationId；恢复旧 releaseId 也会得到新激活身份。

提交应答丢失后可以读回或以同一 changeSetRef 再调用：返回已有 activation，不重复激活。更晚重放旧提交只报告历史结果和 isCurrent:false，不能覆盖新版本。整个事务不调用 GitHub、上传文件或发送搜索通知；通知失败不改变已提交的状态。

## 只读观察与交付验收

`status({scopeKey})` 返回 target、scope、pendingStep（含已记录的 providerOperationId）及 uninitialized/idle/leased/stalled/recovery-required 状态；`runStatus(runId)` 读取具体 journal。读取不会初始化记录。实际 GitHub/CLI 操作入口留给 D，不接网站业务后台。

本地测试涵盖竞争 owner、心跳、过期 pending、证据错误、提交应答丢失、scope 版本变化、组件保留、恢复再失败，以及 A2+B1+实际 SDK 的接口联测。测试只替换 SDK 网络传输，使用真实 transaction/get/set/retry；真实 CloudBase 锁和持久性仍须专用云 fixture 验证。

新共享 offline CI 沿用 `.github/workflows/seo-module-1.yml` 文件及历史，名称改为 SEO release modules；加入既有 SDK 合同检查并运行仓库默认 pnpm test。四条原 CI/deploy/E2E workflow 不变，无云凭证、无 environment、无部署命令。下一步是 C1；B2 继续等待公开写入方的整合窗口。

## MIU SEO-REL-B2：公开内容世代与发布事务的接入

当前 db adapter 已有 Alibaba 的事务内 guard，能参考其设计；站点发布不得直接复用该业务锁。

```js
// 现有模式：guard 检查和受保护写入在同一个事务。
const lease = await tx.collection(leaseCollection).doc(leaseId).get();
assertGuard(lease, guard);
await targetRef.update(patch);

// 目标：公开内容事务也读取站点 publication state。
// 先完成所有读取，再一次提交 product patch + generation + change reference。
```

拟新增 `packages/db/src/publication-guard.ts` 及 `scripts/publication-coordination.test.mjs`；只有整合到最新 main/pricing 后才接 `cloudbase-adapter.ts` 和真实保存/发布/撤回调用方。合同要求：公开投影发生变化才递增 generation，草稿保存和询盘写入不变；同一业务事务同时更新公开记录、generation 和变化引用。对影响公开内容的图片/变体写入也要清点，不能只接一个 Publish 按钮。

generation 为服务端维护的非负 safe integer；缺少已初始化的 generation 不是 0，必须先完成基线建立。溢出/非法值拒绝写入，不静默重置。传给 A/E 的证明同时携带 targetId、generation、读取时间和公开集合摘要。

进入静态交付的短期窗口，相关公开写入检查 publication guard；冲突返回可重试的 `PUBLICATION_BUSY`，不丢草稿、不自动把用户操作标为成功。构建期间不持该阻塞，询盘/用户写入不受影响。实际交付窗口的时长须在 F 测量，超出可接受时间时停止并调整，不无限冻结发布。

环境写入 lease 与商品 publication barrier 是两个概念。canary 虽共享环境 lease，但不持商品内容 barrier，不阻塞正常商品编辑；site 只有即将改变商品/发现文件的阶段才取得相应 barrier，并在事务中核对内容世代。

接入清单保存 `writer/ref/transaction boundary/projection effect/guard test`，缺一个相关写入方就保持商品范围关闭；不能用两次读取 generation 代替事务约束。明确用户影响：后续可能新增“发布进行中，请稍后重试”的短暂管理端状态；接入时需保留表单并提供截图，本轮无 UI 变化。

拟测试 `public publish increments generation once`、`draft and inquiry writes continue`、`withdraw races with recovery and never resurrects URL`。命令 `node --test --experimental-strip-types scripts/publication-coordination.test.mjs`；接真实调用方后补一次现有后台保存/重试路径验证。交付时若只完成合同则状态为 `contract-ready`，不能记为 producer-integrated。
