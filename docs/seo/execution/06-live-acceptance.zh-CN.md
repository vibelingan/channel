# 06 真实交付验收

状态 `in-progress / 404 fixed; static A/B/A pending`，MIU `SEO-REL-F1`。管理员准入和控制面已准备；公网 404 已修复并核对专用 noindex 正文。缓存与 A/B/A 仍待现场验收。最新原因与结果见[404 修复记录](module-06-404-fix.zh-CN.md)，此前历史见[现场记录](module-06-verification.zh-CN.md)。操作范围沿用[受控演练计划](../RECOVERY_DRILL_PLAN.zh-CN.md)。

## 执行输入与结果

已新增 `scripts/accept-site-release.mjs`、`scripts/accept-site-release.test.mjs`，用于检查目标、A/B/A、浏览器 hash、404 和通知范围。真实写入按已审查范围执行；准备与 404 修复已经完成，A/B/A 尚未执行。输入必须同时指定 canonical EnvId、origin、A/B artifact、activation、组件/路径/fixture 允许清单和 drillRunId，不能只用 test 这个名称判断环境。

```ts
type DrillResult = {
  runId: string; scope: 'static' | 'static-api';
  baselineActivationId: string; restoredActivationId: string;
  static: Evidence; api: Evidence | { state: 'not-run' };
  data: { existingPreserved: boolean; newFixtureCPreserved: boolean };
  notificationAttempts: number; cleanup: Evidence;
  observedRecoveryMs: number | null;
};
```

结果写入 `output/seo-release/<drillRunId>/`，按权限归档报告和无凭证的 HTTP/hash/fixture 证据。发布成功、人工恢复成功、自动恢复成功、数据补偿分别记录，不能一个总体 pass 掩盖 API 未跑。

## MIU SEO-REL-F1：一次可核对的发布/恢复闭环

要解决的问题是“流程图和 CI 绿色，但不知道现场是否真的回到 A”。核心断言针对真实 URL/运行身份和数据，不只针对 workflow 结果。

```js
await assertOrdinaryUrlMatches(restoredStaticHash);
await assertApiRunningIdentity(expectedApiIdentity); // static-only 范围明确 not-run
await assertNewFixtureCUnchanged();
await assertNoCanarySearchNotification();
```

第一阶段在未关联商品的 canary 路径验证静态 A→B→人工恢复 A；不要求先完成函数恢复或公开内容写入方整合。第二阶段在 C2/D2 完成后，验证安全 API 标记 A→B→A，并仅让 canary 验收失败一次以触发自动恢复。涉及商品的第三阶段必须等 B2，才测试公开更新/撤回/恢复的一条主路径。

第一阶段的静态 canary 使用 A/B 的固定 scope 合同，拥有独立激活记录并共享环境写入锁；不能修改整站 active，不能顺便上传整份 dist 或生产 sitemap。它的成功仅证明 canary 范围。

第二阶段若更改实际 `public-api` 函数中的安全健康标记，就使用 site scope 的真实函数组件和基线，静态组件引用保持原样。不能因为只改了标记，就在 canary 独立账本中悄悄改生产函数。恢复与最终 active 必须反映实际运行的函数版本；注入失败只影响标记验收，不破坏正常 API。

数据库默认保持当前值。专用 fixture B→A 只是带预期版本的受控补偿；期间创建的 C 必须保留。schema/历史字段不删除，不在生产原库上覆盖整库备份；PG 备份恢复如需验证另用隔离副本，当前不把它加入必经验收。

已有缓存的 context 和新 context 各读一次普通页面/API；核对初始 HTML、canonical、sitemap、真实 404 和恢复后核心交互。当前客户 UI/图库/询盘流程应保持；若实际实现出现可见差异，附前后截图，不能等上线后才发现。截图与录制按现有隐私开关启用，不捕获凭证表单。

保留原演练计划的三组本地负向检查，不增加大规模线上故障注入。fixture 以 runId 隔离，清理只操作精确 fixture；可先标 retired 保留审计。确需删除临时记录时按当前 runId/版本条件清理，不删除客户记录、字段或表。

拟本地测试 `drill requires exact target and scope`、`static-only never reports API verified`、`changed fixture refuses compensation`。命令 `node --test scripts/accept-site-release.test.mjs`。真实执行命令需实施后提供；本文件不放一个当前不存在却看似可直接运行的生产写入命令。

验收交付包含实际恢复耗时、当前 active/baseline、普通 URL 与旧缓存结果、函数/API身份、B/C 数据保留、配置反向读回和搜索通知数。凭证过期、未知写入或基线不可信时停止并记录，不反复自动恢复。该模块通过后才能按实际覆盖范围宣布上线可用。
