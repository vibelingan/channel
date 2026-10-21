# F1：404 问题的原因、修复与剩余验收

2026-10-21 10:20 UTC。状态：**公网真实 404 与专用 noindex 正文已修复；静态 A→B→A 尚待执行。** 继续使用 `feat/seo-foundation`，没有新增分支或 worktree。

## 已观察到的原因

这是 CloudBase STATIC_STORE 网关与托管文件的交付问题，纯 HTTP 即可复现，React 尚未执行。不能把 COS website 配置正确直接当作公网正确，也不能仅凭差异就断言腾讯内部实现有 bug。

| 对照 | 网站配置 | 根目录 404.html | 公网缺失地址 |
| --- | --- | --- | --- |
| 修复前 | ErrorDocument=index.html | 本次新增文件存在 | 200，专用错误正文 |
| 单变量实验 | 完全不变 | 原件备份后移至独立保留路径 | 404，当前首页正文 |
| 修复后 | ErrorDocument=errors/not-found.html；OriginalHttpStatus=Enabled | 不存在 | 404，专用 noindex 正文 |

单变量实验的网关请求 ID：`e78723a9-ab65-44f2-aefa-18e9f58ce87e`；最终修复请求 ID：`18170e56-9aed-4abc-ad20-5efcd1d610d6`。最终正文 SHA256 为 `f61e6cc6b940599a2edea1fa5f3fb278636ca31dc1d2c4bf5d22ace3e657afc5`，23961 bytes。两个实验均在先归档、后持有共享部署锁的维护窗口内执行，云端调用已有终态和读回。

**能够确认的触发条件是根目录文件的存在，而非普通缓存等待。** 网关内部具体怎样优先选择该文件，没有源码证据，不把推测写成实现事实。之前只恢复 website 配置、保留新增入口文件的恢复方案不完整；此处已经补正。

原件字节保存在本地 `output/seo-f1-debug-2026-10-21/backup/404.html`，云端保留在 `__seo_canary__/f1-diagnostics-20261021/preserved-404.html`。新正式错误文档是 `errors/not-found.html`。没有批量清理、删除业务记录或历史 hash 资源。

## 本轮边界

- 重新读取当前首页、headphones、两份 sitemap，并与 COS 对应对象逐字节核对。首页、分类页的资源引用已经发生外部变更；本轮开始时尚无写入，因此只记录当前版本，未恢复上午的整站包。
- 两个实验后，四个普通 URL 均保持当前基线。没有写入正常页面、商品正文、业务函数、数据库 schema、pricing 或 product-sync。
- 保留现有域名、证书、两条 STATIC_STORE 路由；未改 DNS，未新增代理函数或平台版错误页配置。
- 维护运行 39586820373 已将域名静态响应头改为 `no-cache`；云端配置、四个普通 URL 和全新缺失地址均已读回。普通正文 hash 不变，错误地址仍为 404。缓存更新前的完整参数已归档，可单独恢复缓存头而保留已修复的错误页。

## 代码防止再次引入

C1 明确使用 `errors/not-found.html`，同时保留 OriginalHttpStatus=Enabled。C1 的计划和 provider 都拒绝上传保留名称 `404.html`；删除保护包括新的错误文档。该约束仅用于新的 CloudBase 发布适配器，正常部署脚本及现有 workflow 不在本轮改动范围内。

整站 D1 接入时必须把 Astro 产出的 `404.html` 映射到托管专用路径，再生成对应交付 manifest；不能直接把 dist 整目录上传。原有构建检查仍可检查 Astro 产物，托管清单和实际 URL 必须分别验证。此项属于整站接入，尚未宣称完成。

新增两项回归先在原代码上得到失败，再修实现：非保留错误路径可用／根目录回退名称被拒绝；provider 在 SDK 调用前拒绝危险上传与错误文档删除。原有配置、SDK 适配、恢复、并发和读回测试继续执行。当前 37 项定向测试通过，SDK 合同检查通过；更广回归及精确 SHA 的远端 CI 单独记录。

## F1 和 Blog 各做到哪里

F1 是现场证明发布与恢复可用：在 `__release-canary/index.html` 建立 A，发布 B，再选择已验收 A 恢复；比较公网字节、浏览器缓存、激活身份和耗时。它不等于增加一个客户功能，也不包含 Blog。

| 工作 | 当前状态 |
| --- | --- |
| A1/A2 产物校验与恢复内核 | 已实现并有离线回归 |
| B1 发布状态、租约和日志；C1 静态托管适配 | 已实现；F1 正在补真实现场证据 |
| D1 静态 canary 人工入口 | 已实现、已注册；只开放本分支的一文件 canary 人工执行 |
| F1 第一阶段 | 404 和 no-cache 已现场验证；A→B→A 待执行 |
| C2、整站 D1、自动恢复 D2、公开内容合同 B2、搜索事件 E1 | 待实现或接入 |
| 商品 SSG | 之前已有源码和本地验证；本轮未正式部署商品页面 |
| Blog 与 Hermes | 设计完成，当前分支没有编辑器、草稿导入 API 或 Agent 工具的实现 |

Blog 设计流：企业微信发起 → Hermes 生成文章 → 调用 draft-import API → 导入成功返回草稿编辑链接 → 客户编辑、预览、人工发布。Agent 只有创建草稿权限，不自动发布。异步 202 不算完成，只有 ready 才回编辑链接；重复调用按幂等键处理，不覆盖人工修改。原设计在项目主目录 `output/seo-blog-design-2026-10-18/TECHNICAL-PLAN-AND-HERMES-DRAFTS.zh-CN.md`。

## 证据和审阅

现场证据目录：`output/seo-f1-debug-2026-10-21/`。核心文件为 `quarantine-result.json`、`error-path-result.json`、各 preparation/远端 archive、`resource-mapping.json`。不保存签名 URL 或云凭证。

核对了 CloudBase 官方管理文档、已安装 Manager 5.9.1、COS SDK 2.15.4 和真实公网响应。Context7 不可用。参考：[COS website 状态码合同](https://intl.cloud.tencent.com/document/product/436/30617)、[COS 复制与移动](https://cloud.tencent.com/document/product/436/64995)、[CloudBase 缓存清除的支持范围](https://cloud.tencent.com/document/api/876/137741)。DIRECT 网关不套用 CDN/EO 刷新接口。

文字审阅覆盖本页、执行索引、模块六记录与 CURRENT_EXECUTION。将“恢复原配置即恢复完成”修正为“配置读回与公网行为分别核对”；将“404 被缓存，等刷新”修正为可检查的单变量文件实验。保留两个尚未完成的事实：A→B→A 未跑、Blog 未实现。

## 受控 canary 开放范围

2026-10-21 10:46 UTC：已核对四个发布控制集合均为 ADMINONLY、两份 OPA 扩展为空，将完整只读响应指纹 `ade149d24c39b4b413db0a5c2ca5db422115d3c116046dd01c4895a23a87c515` 固定在 policy。只允许人工 plan/execute，在 `__release-canary/index.html` 建立 A、写 B、恢复明确 accepted A；每次执行要求精确代码 CI、归档来源、计划 token、预期 activationId 和共享锁。没有普通静态页面、函数或业务数据库写入权限入口。

每个阶段前再次读取配置和前一激活状态，任何状态漂移、权限指纹改变、普通 URL 改变、404 或缓存失效、未知云操作都停止，不重试未知写入。B 的回退来源是第一次已验收 A 的精确归档，恢复产生新的 activationId，保留 A/B 归档和日志，不删除记录。独立 canary 的测试结果不能代替整站、接口或数据库恢复验收。

代码 `5ba18aa52e09b88ed1a94380a8fe1ed541e7fcf6` 的远端 CI 39586231324 已成功；本地发布回归 208 项通过，整仓本地导出测试的唯一失败源于没有 .git，相关只读 Git 测试补充明确 Git 元数据后 17/17 通过。精确提交的远端整仓回归通过，不把导出目录的环境差异写成代码缺陷。
