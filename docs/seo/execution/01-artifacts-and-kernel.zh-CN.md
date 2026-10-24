# 01 产物与恢复内核

状态：`implemented / locally verified`。A1、A2 已实现，仍使用 `feat/seo-foundation`。代码基线 `259fb689`，主线核对基线 `origin/main@37bcea5b`。远端测试使用本模块独立的 [offline workflow](../../../.github/workflows/seo-module-1.yml)；真实云端恢复尚未启用。

本模块可以独立验收输入检查和执行顺序。实际站点恢复必须等 B 的状态/锁和 C 的云端适配器接入，再由 D 提供入口。这里的测试通过不能解释为线上可一键回滚。

## 文件和责任

| 文件 | 责任 |
| --- | --- |
| `scripts/hosting-recovery.mjs` | 保留 v1 备份读取；生成恢复计划；执行严格回执合同 |
| `scripts/release/input.mjs` | 路径、文件边界、hash、规范 JSON 身份 |
| `scripts/release/public-output.mjs` | 联合核对商品 HTML、商品/SEO manifest、robots 和本地 sitemap 图 |
| `scripts/release/artifact.mjs` | v2 payload、envelope、来源 metadata、accepted seal 的匹配检查 |
| `scripts/prepare-hosting-recovery.mjs` | v1 本地准备入口，只写新建的计划报告，不执行恢复 |

依赖只增加根开发依赖 `sax@1.6.1`，用于严格 XML 解析；不进入浏览器 bundle。事件和 namespace API 已按[维护仓库说明](https://github.com/svg/sax)及安装包源码核对，并通过畸形 XML、DTD/实体和 namespace 用例验证。

## A1：完整且可追溯的输入

### 旧 v1 备份

`sealHostingBackup` 继续要求两次清单和配置一致，下载内容匹配普通对象 ETag；multipart ETag 继续要求独立读回证据。`verifyRecoveryInput` 保留 `schemaVersion:1 / purpose:hosting-recovery`，检查 env/site、配置 hash、文件字节数、SHA-256 和首页。

新增边界检查在读取前限制文件数和声明大小，再检查实际文件大小。根目录、父路径和最终文件中的 symlink 均拒绝；打开文件时使用 `O_NOFOLLOW` 并核对 inode/device。候选目录在校验及执行期间应由受信任执行器独占，不接受其他进程并发修改输入。

`planHostingRecovery` 仍接收显式 `currentOwnedPaths` 和 `publicProductPaths`。这两个数组只提供本地规则检查所需的输入，**本模块不能证明它们是线上最新状态**。B2 接入前，不开放线上商品恢复。

### 商品一致性

联合读取以下来源，检查任何一处是否宣传当前公开集合之外的商品，再要求四处商品路径集合一致：

1. `products/p-*/index.html` 的独立页面清单。
2. `products/manifest.json` 的 `schemaVersion/purpose/siteOrigin/total/products[].path/revision`。
3. `seo-manifest.json` 的 `entries[].kind/path`，商品路径不能伪装成普通页面。
4. sitemap urlset 中的页面 URL。

`sitemapindex` 中的 loc 代表分片，不当成页面。所有分片在本地清单内递归读取；支持非 `sitemap-*.xml` 文件名、robots 的 Sitemap 指令，禁止外域、缺失分片、循环和重复 URL。分片实际身份也进入上传排序，保证自定义 XML 分片不会被当作普通依赖提前覆盖。

旧站备份如果完全没有商品 HTML、商品 URL 和商品/SEO manifest，可作为 legacy 输入。只要出现商品输出，就要求完整合同。显式零商品也是有效集合，但不能用读取失败代替零商品。

初始正文、canonical、schema 的语义检查继续由已有构建检查负责；此处不复制另一套 HTML SEO 实现。商品正文 revision 会原样保留在计划中，不能把旧快照解释成当前 API 最新版本。

### v2 交付包

`verifyReleaseArtifact({ envelope, directory, policy, run, acceptedSeal, mode, now })` 只比较受信任适配器提供的来源 metadata，**不自行访问或认证 GitHub**。`policy` 必须来自目标配置；`run` 将由 C/D 从平台 API 获得；恢复 seal 将由 B 的持久状态提供。调用方传入 `{trusted:true}` 不满足合同。

```ts
// 文件路径均相对于下载并安全解包后的候选目录。
type ArtifactRef = {
  repository: string; workflowPath: string; runId: string;
  artifactId: string; manifestSha256: string; expiresAt: string;
};
type Components = {
  staticManifestPath: string;
  snapshotPath: string | null;
  functions: { name: string; packagePath: string; sha256: string; runtime: string }[];
  compatibilityRef: { path: string; sha256: string };
};
// envelope 与 payload-manifest.json 共同包含：
// schemaVersion:2、releaseId、codeSha、target、scope、Components。
// envelope 另外包含 ArtifactRef；payload 另外包含 purpose:'release-payload'、
// createdAt、entries:[{path,bytes,sha256}]。
```

`manifestSha256` 计算原始 `payload-manifest.json` 字节。静态/函数/快照/兼容文件的描述也写进 payload 并与 envelope 比较，防止来源验证通过后换掉 runtime 或组件角色。envelope 中的 artifactId 在上传后绑定，不写回 payload，避免自引用。

静态 manifest 是独立 v2 文件：`purpose:'static-release'`、`entries`、`configuration/configurationSha256`。它描述的每个文件都必须也是 payload 成员，字节数和 hash 一致。未声明成员、缺失文件、重复文件、过期 artifact、错误仓库/workflow/event/ref/run/SHA/artifact 关系均拒绝。

`mode:'candidate'` 允许在发布验收前检查候选，不能用于恢复计划。默认 `mode:'recovery'`，要求匹配的 `acceptedSeal`，包含 `schemaVersion:1 / activationId / releaseId / codeSha / artifact / target / scope`。`planReleaseRecovery` 强制恢复模式。成功的 GitHub run 不能代替 accepted seal。

这是单份组件来源包的检查。B/D 后续按实际交付的组件记录 baseline：static-only 保留原函数引用，retain-public 保留原静态引用。ZIP 中未交付的组件不会因此成为 active。兼容文件在本模块只检查存在、JSON 和 hash；schema/数据兼容的决策仍由 C2 实现。

### site 与 canary

site 和旧 v1 都要求 `index.html`。v2 canary 要求固定前缀内自己的 `index.html`，无需全站首页；目标策略中的 scope 必须完全匹配。canary 不允许函数、商品快照、搜索发现文件或平台验证文件；所有静态路径和当前所有权必须处于前缀内，配置 hash 必须保持目标策略中当前已核对的值。

本模块只给出 canary 计划，不创建 canary 路由、不部署文件，也不改线上配置。真正的读回、缓存和 HTTP 验收由 C/F 完成。

### 输入上限

| 输入 | 默认硬上限 |
| --- | --- |
| 候选成员 | 20,000 个；单文件 128 MiB；总量 512 MiB |
| JSON metadata | 每文件 4 MiB |
| 商品 snapshot JSON | 64 MiB |
| XML | 每文件 5 MiB；32 层 |
| sitemap | 100 份；合计 50,000 个页面 URL |

不允许通过 artifact 自己的字段提高这些上限。JSON/XML 使用严格 UTF-8 解码；XML 禁止 DTD、外部实体、无效 namespace 和非规范 URL，解析过程不请求网络。

## A2：每一步必须有本次执行的证据

生成的计划使用 `schemaVersion:2`。`planSha256` 绑定目标、scope、文件和路径处理等完整计划；`stateSha256` 绑定预期最终文件身份、明确移除路径和配置身份。前者是完整性检查，不能替代 B 的授权和环境锁。

`executeHostingRecovery(plan, adapters)` 开始时复制并冻结计划及回调引用，在第一个 effect 前检查计划身份和所有必要适配器。每次执行生成独立 `executionId`；同计划上一次执行的回执不能复用。

```ts
type Intent = {
  executionId: string; planSha256: string;
  subject: string; expectedHash: string;
};
type Submitted = Intent & { status:'submitted'; operationId:string };
type Verified = Intent & {
  status:'verified'; operationId:string; observedHash:string;
};
// upload(entry, intent) -> Submitted
// verify(entry, intent & {operationId}) -> Verified
// remove(path, intent) -> Verified，expectedHash/observedHash 均为 'absent'
// configure(intent) -> Verified，hash 为计划中的配置身份
// accept(intent) -> Verified，hash 为实际最终状态的 stateSha256
```

上传的 submitted 只表示已提交，必须紧接着用同一个 operationId 读回验证。后续结果同时匹配 executionId、planSha256、subject、expectedHash、observedHash；false、void、pending、不完整对象和不匹配结果全部拒绝。适配器必须从实际读回生成 observedHash，不能照抄 expectedHash。

执行顺序是：每个依赖资源上传/读回，随后 HTML，再随后全部发现文件；接着处理明确拥有的退役 HTML/发现路径，再处理允许的配置，最后从普通 URL 验收最终状态。老 hash 资源、平台认证和 Google/Bing 验证文件保留。只根据显式所有权处理路径，不做广泛清理。对未包含在目标包内、又无法确认角色的已拥有 XML，计划直接停止，要求 C 提供发现文件归属核对；既不盲删，也不默默留下可能仍宣传旧商品的孤立 sitemap。

任何一步抛错或回执不符合合同，立即停止；内核不重试、不决定第二轮恢复、不更新全局 active。途中可能已完成部分写入，后续 B/C 必须记录并读回，不能把异常当作“什么都没发生”。A2 的本地目录适配器只用于验证合同，未冒充线上适配器。

## 单独验收与后续接入

本地命令：

```bash
node --test scripts/hosting-recovery.test.mjs scripts/release-artifact.test.mjs \
  scripts/release-envelope.test.mjs scripts/recovery-kernel.test.mjs scripts/release-module-ci.test.mjs
pnpm test:deploy-smoke
pnpm lint
```

[验证记录](module-01-verification.zh-CN.md)保存实际命令、结果、审查修正和远端边界。独立 workflow 在当前 SEO 分支 push 时运行，只有 `contents:read`，checkout 不保留凭证，安装时禁 lifecycle scripts。它运行全仓 lint 和脚本回归，日志仅保存到 GitHub artifact；现有 CI、部署和 E2E workflow 均不改动。

下一步是模块 02 的 B1：持久状态、步骤日志、环境锁与恢复目标选择。继续在同一分支。商品发布证明 B2、平台来源获取和云端副作用 C、实际入口 D，以及现场验收 F 未交付前，模块 01 只作为本地/CI 内核使用。数据库字段与历史记录继续保留，本模块没有数据库操作。
