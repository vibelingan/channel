# 03 云端适配与兼容

状态 `planned`。C1 先交静态/配置适配，C2 再交函数恢复。不会因为 C1 通过就宣称能恢复整次前后端发布。

## 适配边界

复用现有备份、HTTP 完整性检查、`waitForFunctionActive` 和函数 manifest；拟新增 `scripts/release/hosting-adapter.mjs`、`function-adapter.mjs`、`compatibility.mjs`，测试放根目录 `scripts/release-adapters.test.mjs`、`release-compatibility.test.mjs`。现有 `deploy-cloudbase-test.mjs` 中云端动作在本模块抽取；D 再串联，不在两个地方保留不同部署实现。

```ts
type EffectPort = {
  submit(intent: StepIntent): Promise<{ operationId: string }>;
  readBack(operationId: string, expectation: ComponentExpectation): Promise<VerifiedReceipt>;
};
type CompatibilityDecision =
  | { status: 'allowed'; planHash: string; components: ComponentRecovery[] }
  | { status: 'denied'; reasons: string[] };
```

类型是 A/B 合同的使用示意。所有 cloud 调用显式绑定 EnvId 与目标 origin；不依赖 MCP 当前选择环境。工具成功回执、云端生命周期终态和实际字节/运行身份分别核对，不能只看 exit code。每个外部 effect 均经过 B 的步骤日志。

管理 API 和 CLI 不参与 NoSQL 事务，也不支持站点 fencing token。异步 `submit/readBack` 之间持续续租；将阻塞式 CLI/`Atomics.wait` 改为受控异步进程与可取消轮询，保留现有运行时和终态错误判断。丢租约后禁止发起新动作；已发出的操作仍可能继续，记 unknown，交给 B 核对，不能立即反向写。

## MIU SEO-REL-C1：静态与配置的真实读回

当前目录上传会一次覆盖多种文件，而恢复内核已有资源/HTML/发现文件顺序。正常发布也应复用相同的阶段执行器。

```js
// 当前正常交付：整目录 upload，再验 hash。
await publishVerifiedAssets({ upload: uploadWholeDist, verify: verifyHostedAssets });

// 目标：每个阶段失败都保留最后已确认步骤。
for (const phase of ['assets', 'html', 'discovery']) {
  await executePhase(plan[phase], { journal, hostingPort, guard });
}
```

上传、精确删除和配置补丁都有独立 operationId/读回。读取同一普通 URL，并补重校验请求，验证 status/body hash、ETag/Cache-Control；随机 query 不能成为唯一验收。复用 `hosting-contract.mjs`、`hosting-integrity.mjs` 的有界响应生命周期，结束时释放 body。

删除只接受 A 生成的明确 owned path 差集，保留旧 hash 资源、平台和验证文件；404 的正文也必须是真实错误页面。缓存补丁限定实际修改字段，保留 source/expected-before/desired-after，反向时条件比对；原配置违反新 SEO/安全约束时保留兼容新值或拒绝计划，不盲目回放旧的首页错误正文和长缓存。

不承诺目录上传原子切换；阶段间混合窗口继续靠前后端兼容和旧资源保留。平台 cache purge 若合同或当前接入模式未证明可用，结果写未验证，不能把“发了 purge 请求”当成浏览器缓存已清。

拟测试 `assets failure prevents HTML upload`、`ordinary URL verifies bytes and error status`、`config inverse rejects changed-before state`，命令 `node --test scripts/release-adapters.test.mjs scripts/hosting-contract.test.mjs scripts/hosting-integrity.test.mjs`。C1 云端验收先使用 F 的无链接 canary，商品恢复须等 B2。

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
