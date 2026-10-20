# 01 产物与恢复内核

状态 `planned`，基线 `139308f9`。本模块只完成本地输入检查、可信产物合同和严格执行结果，不调用云端。

## 交付接口和文件范围

复用 `sealHostingBackup`、`verifyRecoveryInput`、`planHostingRecovery`、`executeHostingRecovery`。修改现有 `scripts/hosting-recovery.mjs` 及测试；拟新增 `scripts/release/artifact.mjs`、`scripts/release-artifact.test.mjs`。现有备份 manifest v1 保留读取能力，新交付包增加独立的版本化 envelope，不把旧文件偷偷解释成 v2。

产物有两部分：不可变的候选 payload，在云写入前归档；协调器验收后记录的 accepted seal，引用同一 artifact ID 和 manifest hash。成功 seal 保存在 B 的持久状态中，不需要在持锁期间重新上传整个 ZIP。恢复时两部分一起检查；GitHub run 的绿色结论不能代替发布验收。

```ts
// 目标合同示意；不新增一个运行时 TypeScript 包。
type ArtifactRef = {
  repository: string; workflowPath: string; runId: string;
  artifactId: string; manifestSha256: string; expiresAt: string;
};
type ReleaseEnvelope = {
  schemaVersion: 2; releaseId: string; codeSha: string;
  target: { envId: string; siteOrigin: string };
  artifact: ArtifactRef;
  staticManifestPath: string; snapshotPath: string;
  functions: { name: string; packagePath: string; sha256: string; runtime: string }[];
  compatibilityRef: { path: string; sha256: string };
};
```

payload 由受信任 CI 生成，跨运行保留到 artifact 到期；控制面持久记录其验收身份，artifact 丢失时停止恢复。环境/origin/来源白名单来自目标配置，不接受操作人任意填写一个仓库就恢复。当前 run 的候选可验收后封存，未提交的候选不能按“最新 artifact”被选中。

envelope 是控制面组装的对象，不整体写进被它自己 hash 的文件。`manifestSha256` 只计算候选 `payload-manifest.json`；artifactId 在上传后从可信回执绑定，避免自引用 hash 和上传前预知 ID。

accepted seal 按组件绑定产物：完整静态包一个引用，每个函数一个引用。static-only 保留当前函数引用；retain-public 保留当前静态引用。候选 ZIP 内未交付的组件不得进入 baseline；所有被引用 artifact 都必须可用。

canary 是同一环境的固定小范围发布器，不是新测试环境：仅拥有预配置的 canary 路径、不包含商品/发现文件。其 v2 输入要求该 canary 的入口文件；完整 site scope 和旧 v1 仍要求首页。scope 由受信任目标配置限定，不能由任意路径参数扩大。

公开一致性检查从实际 `products/manifest.json` 的 `products[].path/revision` 与 `seo-manifest.json` 的 `entries[].kind/path` 读取，解析 sitemap index 及其所有本地产物分片，统一为同 origin 的规范 URL 集合。索引文件的分片位置不能当作商品 URL。HTML 正文/canonical/schema 继续复用已有构建检查。

输入文件沿用现有路径、symlink、字节数和 hash 检查；JSON/XML 必须有边界、禁外部实体/网络解析。未知 schema、非法 origin、缺分片、重复/超限输入都拒绝，不发外网去补文件。合法零商品必须有完整 manifest 和明确当前公开集合证据，不能把读取失败转成空数组。

## MIU SEO-REL-A1：一致且可追溯的恢复输入

当前问题：`planHostingRecovery` 只按 HTML 文件名检查撤回商品，旧 sitemap 单独残留商品 URL 时可通过。

```js
// 当前的判断范围只有 manifest.entries 的商品 HTML 路径。
if (productFile.test(entry.path) && !publicPaths.has(productPath)) throw new Error();

// 目标：完整解读本地产物后再做恢复计划。
const publicOutput = readPublicOutput(directory, manifest);
assertPublicOutputCompatible(publicOutput, currentPublicationProof);
assertArtifactSource(envelope, trustedRunMetadata, acceptedSeal);
```

`currentPublicationProof` 由 B 的内容合同提供，包含 target/generation/读取时间/公开路径；当前不在这里调用商品 API或操作数据库。对撤回商品，HTML、sitemap、商品/SEO manifest 中任何一个重新宣传该 URL 都拒绝整份恢复。旧正文 revision 的暂时落后必须明确记录；不把旧快照标为当前 API 最新数据。

选择联合解析而不是“跳过旧 HTML”，因为后者仍会恢复旧发现入口。来源验证由 C/D 提供真实 GitHub metadata，内核校验其匹配关系；仅有调用方 `{trusted:true}` 无效。拟测试 `rejects sitemap-only withdrawn product`、`accepts coherent public artifact`、`rejects wrong source/origin/expired artifact`。

验证命令：`node --test scripts/hosting-recovery.test.mjs scripts/release-artifact.test.mjs`，后一个文件拟新增。交付为稳定解析结果、拒绝原因和无云写入的恢复计划，可先独立合入当前 SEO 分支。

## MIU SEO-REL-A2：失败回执不能成为成功

当前执行内核只有 `await accept()`，返回 false 不抛错时仍返回恢复数量。

```js
// 当前
await accept();
return { restored: plan.uploads.length, removed: plan.deletes.length };

// 目标合同，每个 effect 都返回严格回执；不是 truthy 检查。
const receipt = await accept(context);
assertVerifiedReceipt(receipt, context.expectedComponentIdentity);
```

统一回执为 `{status:'verified', operationId, expectedHash, observedHash}` 或明确失败；无返回值、false、处理中和不匹配身份均不能成功。执行仍按依赖资源、HTML、发现文件逐项上传/读回，再做精确路径处理和允许配置；失败立即停止，不在内核自行决定恢复第二轮。

回执由适配器绑定可信 intent/operationId，实际观察的是候选旧包/文件的身份；恢复 A 后健康接口应返回 A 的代码标识，不要求旧代码凭空返回新 activationId。新的激活身份由 B 在验收后提交。

兼容旧调用方的迁移在本 MIU 一次完成：查明全部导入与测试 fixture，更新它们，不保留“旧 void 等于成功”的生产旁路。内核不写 B 的全局 active，只有 D 完成全部组件验收后才提交。

拟测试 `accept false never completes recovery`、`unverified upload stops before HTML`、`verified receipts complete exactly once`。验证命令 `node --test scripts/hosting-recovery.test.mjs`。交付是严格结果合同与本地执行器；云端实现放在 C，不在这里手搓假的线上成功回执。
