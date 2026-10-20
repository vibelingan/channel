# 04 CI/CD 与恢复入口

状态 `planned`。依赖 A、B1、C；商品范围另外要求 B2。保留现有同 SHA 完整 CI、凭证检查、函数打包/冷启动检查和真实业务 smoke，不复制第二套常规 CI/CD。

## 入口、状态与文件所有权

修改 `.github/workflows/deploy-test.yml`，拟新增 `.github/workflows/recover-site.yml` 作为手动入口，以及 `scripts/run-site-release.mjs`、`scripts/release/orchestrator.mjs`。两入口都调用同一执行器。测试放 `scripts/release-orchestration.test.mjs`、`release-workflows.test.mjs`，并更新已有 `deploy-ci-gate.test.mjs`。

```ts
type ReleaseRequest = {
  operation: 'deploy' | 'recover'; targetId: string;
  codeSha: string; expectedActivationId: string;
  components: 'static-only' | 'site-and-functions';
  catalogMode: 'fresh' | 'reuse' | 'retain-public';
  artifactId?: string; reason?: string;
};
```

恢复入口要求明确 artifactId、expectedActivationId 和 reason，操作人不能提供任意下载 URL 或可执行旧脚本。入口只选择参数；实际范围由兼容计划限定。使用当前受信任恢复工具版本，artifact 只提供数据和函数包。

正常发布和手动恢复使用同一 `cloudbase-deploy-test` 目标锁，保留 `cancel-in-progress:false`；排队不代表已取得最终资格。独立恢复 workflow 需按 GitHub 默认分支可见性和仓库权限部署后才有按钮，本轮文档不是现成入口。不预设当前已配置 environment 审批。

## MIU SEO-REL-D1：正常交付和人工恢复共用执行器

当前 workflow 已显式采集、构建并归档，但静态验收和业务 smoke 在部署脚本退出后的多个步骤运行。目标把必要验收纳入同一持锁执行范围，不能先提交成功再跑唯一业务观察者。

```js
await verifyPreparedInputs(request);        // 无业务云写入
const guard = await coordinator.acquire();
await revalidateLiveBaseline(guard);
await executeComponents(plan, guard);
await acceptRequiredPaths(plan, guard);
await sealPrearchivedCandidate(plan, guard);
await coordinator.commitAcceptedActivation(plan, guard);
// 后续诊断上传/搜索通知失败不改变已经提交的站点状态。
```

payload 和已验证旧站备份在第一笔业务写入前归档，使用 upload-artifact 返回的固定 ID；当前 dist+snapshot artifact 扩展为 A 的完整候选，不直接重命名就冒充恢复包。accepted seal 引用预先归档的 payload，因此 runner 可以在一段持续续租的执行中完成写入、验收和成功提交，不跨 upload-artifact 步骤丢租约。

初始上线没有可信函数恢复基线时，先做 baseline adoption：普通 URL 与函数运行身份对照已封存包/兼容证据。找不到旧包的组件不自动标记为已备份；可先完成 static-only canary，禁止在“恢复能力未覆盖”情况下顺便更新所有函数。

| catalogMode | 实际动作 | 不能做的事 |
| --- | --- | --- |
| fresh，默认 | 采集当前公开快照，显式文件输入构建，再按当前公开证据交付 | 采集失败变成空快照；跳过 lint/test |
| reuse，手动应急 | 使用固定、可追溯且兼容的成功快照，构建照常运行；重新核对当前公开集合/撤回状态 | 旧快照冒充最新；无法验证公开状态时仍覆盖页面 |
| retain-public，手动修复 | 首期保留全部现有前端和发现文件，只交明确允许的兼容后端修复 | 没有商品输出就上传新 sitemap；修改依赖新公开页的后端；顺便重发前端 |

retain-public 必须有 reason、组件允许清单和兼容证据；没有可安全交付的修复范围就停止。它不是“整个站点普通 build，无条件跳过 SEO”。没有新增彻底关闭 SEO 检查的 off 开关。reuse/retain-public 必须在 Actions summary 显示实际数据时点与保留范围。

手动恢复分为 dry-plan 与 execute：前者只读并输出计划 hash；后者入锁后重读目标并重算，同 hash/身份/兼容条件通过才执行。计划在排队期间过期就拒绝，不把人工触发当作绕过检查的授权。

拟测试 `fresh deploy accepts and commits once`、`reuse rejects stale withdrawal evidence`、`retain-public never writes discovery files`、`manual recovery revalidates queued target`。命令 `node --test scripts/release-orchestration.test.mjs scripts/release-workflows.test.mjs scripts/deploy-ci-gate.test.mjs`。这些新增参数/文件现在尚不存在。D1 先启用人工 canary；常规整站入口继续受 C2/B2 的覆盖条件限制。

## MIU SEO-REL-D2：同一次发布内的一次自动恢复

当前没有此调用链。目标从 B 的实际步骤和 C 的读回判断失败，不用工作流级 `if: failure()` 一概调恢复。

```js
const failure = classifyFailure({ phase, journal, observedLiveState });
if (failure.kind === 'prewrite') return failedPrewrite(failure);
if (failure.kind === 'unknown') return manualRequired(failure);
const decision = await qualifyRecovery(failure, currentGuard, baseline);
if (!decision.allowed) return manualRequired(decision);
await markRecoveryAttemptOnce();
await recoverAndAccept(decision.plan); // 本次最多一次，不递归调用自身
```

状态至少覆盖 `FAILED_PREWRITE / STATE_UNKNOWN / MANUAL_REQUIRED / RECOVERING / RECOVERY_FAILED / FAILED_RECOVERED / SUCCEEDED`。以 journal 为准判断是否真正写入；单个 step 失败不能推断没有云端变化。恢复失败保存当前读回，不把失败日志覆盖掉；恢复成功时站点激活 A，原 B job 仍返回失败并显示“已恢复”。

硬取消不保证 catch/finally 运行；新任务看到 unresolved intent 不自动重启恢复。仅在旧外部操作读回明确且仍属同一 run 时可继续一次恢复，否则人工按 D1 接手。发布成功提交后，通知/归档诊断失败只重试对应任务。

拟测试是三组表驱动检查：`prewrite failures call recovery zero times`；`unknown/new owner/incompatible baseline perform no recovery writes`；`eligible failure restores once and failed recovery never recurses`。另核对 `postcommit notification error leaves active unchanged`。命令同 D1。线上只在 F 的 canary 验收处注入一次失败，不破坏真实商品或认证路径。
