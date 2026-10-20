# 02 发布协调器

状态 `planned`。B1 可在不修改 pricing 业务事务的情况下完成；B2 是整合阶段的公开内容合同，未接全写入方时不启用商品恢复。

## 状态归属与数据形状

拟新增 `scripts/release/state.mjs`、`store-cloudbase.mjs` 和根目录 `scripts/release-coordinator.test.mjs`。部署/恢复日志属于服务器控制面，不能从浏览器直接写，不占用 Alibaba 的 lease 文档。

```ts
type TargetState = {
  targetId: string; version: number; nextFence: number;
  lease: null | { ownerRunId: string; fence: number; expiresAt: string };
  unresolvedOperation: null | { runId: string; stepId: string; operationId: string };
};
type ScopeState = {
  targetId: string; scopeKey: 'site' | 'canary'; version: number;
  active: null | { activationId: string; releaseId: string; compositionHash: string };
  baseline: null | { activationId: string; compositionRef: string; sealHash: string };
};
type StepRecord = {
  runId: string; stepId: string; operationId: string; fence: number;
  component: string; expectedBeforeHash: string; expectedAfterHash: string;
  state: 'intent' | 'submitted' | 'verified' | 'failed' | 'unknown';
};
```

targetId 从固定 repository/envId/origin 规范化计算，是环境写入互斥身份，不包含 git ref 或 scope。site/canary 的 active/baseline 分开存储，取得的是同一 TargetState 的环境 lease，不能由不同分支或 scope 起一个绕过锁的名字。`activationId` 每次正常交付或恢复都唯一；旧 artifact 的 releaseId 可复用。手动恢复 A 验收后，baseline 指向当前已确认的 A 组合，不按“最大 run ID”选回 B。原失败运行状态与站点当前激活状态分别保存。

`compositionRef` 指向按组件绑定 artifact 的已验收清单，详见 A；它可以同时引用旧静态和新函数，不能仅以一个新代码 SHA 代表全部线上组件。canary 有独立 scope 状态，其允许路径固定，仍共享实际环境的 Actions 写入锁，不移动整站的 active/baseline。

存储使用新增的 server-only 文档集合：`siteReleaseTargets`、`siteReleaseScopes`、`siteReleaseRuns`、`siteReleaseSteps`；公开内容 generation 归 B2。记录保留期单独配置，不自动删除历史 schema；旧 target 字段通过兼容读取维护。候选过期只影响能否恢复，不静默清空 active。

事务按确定 doc ID 读取，所有读取先于写入。回调只能做读、校验和写，不能上传云文件、调用 GitHub 或发通知。CloudBase 的事务回调可能重试；使用已安装的 `@cloudbase/node-sdk` 事务边界，不给 wx SDK 添虚构方法。[官方事务合同](https://docs.cloudbase.net/en/database/transaction)

## MIU SEO-REL-B1：可接手的持久交付状态

当前问题：`executeHostingRecovery` 依赖调用方声称“已经持锁”，没有持久归属或步骤状态；Actions concurrency 也不能处理硬取消后仍在进行的云调用。

```js
// 目标：事务提交意图，退出事务后才执行外部操作。
const intent = await store.beginStep({ guard, stepId, beforeHash, afterHash });
const submitted = await effect.submit(intent);
await store.recordSubmitted(intent, submitted.operationId);
const observed = await effect.readBack(submitted);
await store.confirmStep(intent, observed);
```

每次 begin/confirm/成功提交都在同一事务中检查 target/version/owner/fence/有效期。CLI heartbeat 和状态读取由可信 runner 提供，时间限制使用可注入 clock；不得将客户端传入的 now 当授权依据。租约初始建议 180 秒、60 秒续租，可调，需覆盖实际调用和运行器延迟；这不是平台执行时限保证。

**云端 API 不识别 fence。** TTL 到期只标 stalled，不能直接由新 run 接管写入。存在 intent/submitted/unknown 的外部操作时，必须确认旧 job 已结束且云端操作已终止/可读回，再在条件事务中解除 unresolved 状态。没有“过期后立即覆盖”的自动分支。丢租约后只读核对，不能启动新的发布或补偿写入。

验收后先给已归档候选记录 accepted seal，再以一个条件事务更新 active、baseline 和 change-set 引用；候选封存/提交结果未知时读回。逐 URL 搜索事件不在这个事务中批量展开，避免事务无限变大。只有状态成功提交才通知 E。恢复成功保留原 `FAILED_RECOVERED`，不改成新发布成功。

不选仅内存状态或只有 GitHub 锁，因为进程结束后无法判断哪些已改；不选数据库事务包住外部上传，因为云服务不参与该事务。拟测试 `expired lease with unresolved operation cannot be stolen`、`intent exists before first external write`、`stale activation cannot commit`、`restore A advances activation and baseline atomically`。命令 `node --test scripts/release-coordinator.test.mjs`。

B1 交付为纯状态转换、CloudBase store adapter、只读状态报告；真实持久读写合同在启用前用专用控制面 fixture 验证。未验证前可通过 fake store 本地验收，但不能据此启用生产自动恢复。

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
