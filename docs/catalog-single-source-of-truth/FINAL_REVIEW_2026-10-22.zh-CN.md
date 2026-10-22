# Pricing 分支收尾审查（2026-10-22）

本次审查对象是原分支 `feat/catalog-alibaba-price-tiers`、原 PR #69。比较基线为 `origin/main` 的 `404d1a257722175dcd70916e3f92ec6763fa0243`，本轮修改前为 `e7c2ee7212639d5fc135201876ab868c53ed8cb9`。未创建新分支、worktree 或 PR，未修改 SEO foundation 分支。

本轮只整理已实现的同步和恢复功能、修正测试、检查合并条件。发布性能及后续发布设计按所有者指示交由 SEO foundation；没有新增发布业务流程、审批步骤或 CI 工作流。

## CI 的改动和此前失败

仓库原有 CI 已包含类型检查、lint、单元/集成测试、站点及函数构建、隔离数据库上的浏览器测试。相对上述 main，本分支在 `ci.yml` 中的唯一改动是将已有 Chromium/WebKit 安装步骤移到 `pnpm test` 之前，因为站点测试中已包含使用浏览器的组件测试。没有增加工作任务，也没有在 CI 中登录线上后台发布真实商品。

`deploy-test.yml` 只增加 `PUBLIC_CATALOG_READY_DEFAULT` 的传递，默认仍为 `0`。窄屏分页修复是后台布局修复，不是 CI 流程变更。

旧 CI `39658870353` 的失败发生在 `catalog-table-publication.test.ts` 的 normal 用例：20 个临时商品中，17 个在首次调用内确认完成，另外 3 个返回可继续的 `OPERATION_UNCONFIRMED`。该用例使用临时 JSON 数据库、本地 PNG 和测试 JWT，拦截请求并限制为 `https://table.test`；不访问 Alibaba 或云端商品。

此前把这个结果简称为“20 件只发布了 17 件”，没有同时交代隔离环境和“首次调用尚未确认”的含义，容易让人误认为实际后台发布失败。这种汇报不准确。旧 CI 失败仍必须处理，已有本地或线上验收不能替代它。

本地独立复现表明，共用图片的首次读取变慢时，会出现相同的首次调用部分完成现象。它证明原测试把正常就绪选择与冷图片准备混在一起，不能据此断言已完全证明旧 Linux 运行的精确耗时原因。本轮修正为：

- normal 用例先通过真实 Admin handler 和 `runPreparation` 准备全部 20 件，逐件断言 `ready`，再开始批量操作；不伪造校验结果。
- 单独增加慢图片场景：首次真实本地图片读取延迟 4 秒；若部分操作尚未确认，必须使用原任务重试，最终仍断言 20/20、没有失败、没有替换任务。
- 保留丢失回复、公开读回失败、会话撤销、重试期间输入变化、重复操作和恢复下架等原有断言。未降低成功数量、跳过用例或修改业务超时来换取通过。
- 浏览器测试的受控请求原先在 handler 返回后就发出“完成”信号。现在等待 HTTP 回复交付结束后再发出，避免下个测试动作与上个请求交错。

## 审查范围与结果

按项目 `ENGINEERING_CRAFT.md`、SDK 合约要求、TypeScript 最佳实践及实际调用链检查。遵守所有者不使用子代理的要求，由当前执行者完成审查，没有声称进行独立多代理评审。

原分支相对 main 有 719 个变更文件，其中 242 个为运行源码。以下为本轮重点阅读的路径及跨文件调用链；不是对全部 719 个文件逐行审查的声明。自动检查覆盖下方列出的工作区。

| 检查内容 | 重点阅读的代码 |
| --- | --- |
| 同步自动继续、就绪判断、定向重同步 | `apps/functions/alibaba-catalog-sync/src/` 中的 workflow、runner、readiness、preparation、ingest、linking、promotion 和 photo-preparation 相关文件 |
| 原始来源、人工修改、版本保护、图片引用 | `packages/db/src/` 中的 source-binding、source-inputs、source-invalidation、product-state、row-mutation、product-list-view、preparation-jobs、operation-reference-recovery 和 CloudBase 事务相关文件 |
| 详情准备、创建重试、编辑和批量恢复 | Admin 的 product-create、preparation-worker、detail source 处理；站点的 publication-run、table-publication、batch、preparation-api、creation、session guard、draft recovery 及 `ProductClassificationEditor` 相关代码 |
| 图片问题说明、产品弹窗、私有预览 | `AlibabaPhotoIssues.tsx`、`AlibabaConnectionPanel.tsx`、`ProductRefresh`、`RecordForm`、`ConfigurationPhotosEditor`、`useAdminImagePreviews` 及对应调用处 |
| 公开详情、部署配置和测试有效性 | public-api 的 catalog-detail/handler/http-adapter，两个 workflow、部署/打包/合约检查脚本及相关测试 |

审查重点包括人工分类/价格/图片在重同步中保留、同一操作恢复、并发写入条件、撤销权限、未完成任务的图片保护、私有预览清理及公开详情投影。完整测试包含这些路径的既有故障和竞争场景。本轮未确认需要继续修改发布业务逻辑的新缺陷。

最终代码改动限于六个文件：

- `sync-workflow.ts` 将历史结果判断提取为私有函数，一行历史只解析一次 preparation；保留原有状态优先级和返回值。
- `media-import.ts` 修正注释：403 只说明源服务器拒绝访问，不能认定图片永久删除。下载处理逻辑没有变化。
- `AlibabaConnectionPanel.tsx` 与对应浏览器测试修正单数提示 `1 product needs photo review`。
- 两个发布测试按上一节修正准备前提和回复交付时机。

这些改动没有更改数据库结构、SDK 方法、权限、价格计算、分类、公开商品内容或发布步骤。没有引入大规模重构。

## 本地验证记录

测试期间冻结运行代码，未在浏览器测试运行中修改源码。完整根测试后只按格式工具要求调整一处测试换行，未改变行为；最终 lint 重新通过。

| 检查 | 本轮结果 |
| --- | --- |
| `pnpm test` | 8,004 项：8,001 通过、0 失败、3 项原有跳过 |
| 站点测试（包含浏览器组件测试） | 1,434 项：1,433 通过、0 失败、1 项原有跳过，已计入根测试 |
| 本地服务器测试 | 1,225/1,225，已计入根测试 |
| DB 测试 | 2,435/2,435，已计入根测试 |
| 本轮批量操作专项 | 11/11，包括慢图片后继续原任务，已计入根测试 |
| 同步 workflow 专项 | 整理前后各 25/25，已计入根测试 |
| 全工作区类型及 E2E 类型 | 通过 |
| 最终 `pnpm lint` | 1,103 个文件通过 |
| `pnpm verify:cloudbase-sdk` | 通过 |
| `pnpm build` | 15 页构建成功 |
| `pnpm package:functions` | 三个函数打包成功，目标 Node 20 |
| 站点构建产物中的服务端密钥名称扫描 | 通过 |
| `git diff --check` | 通过 |
| Linux 函数产物的运行检查 | Mac 无法加载目标 Linux/glibc 图片解码器；必须等待本提交的 Linux CI 在 Node 20.19 下确认，未记作本地通过 |

`Context7` 在本会话不可用；SDK 核对使用仓库安装包、项目验证脚本及官方 CloudBase 文档。本轮没有添加 SDK 方法、类型垫片或依赖。React 最佳实践扩展未安装，未声称使用；已使用项目 React/异步状态规则及已安装的 TypeScript 规范。

推送后仍须确认当前提交的完整 GitHub CI，包含 Linux 函数运行检查和构建后的两组浏览器流程，再合并。此记录写于推送前，不把尚未执行的远端检查记为完成。

## 实际数据验收与图片边界

本轮未再次发布真实商品。前轮实际后台选取的 20 件已有分类商品已完成发布、公开读回及恢复未发布，三个时钟已定向重同步并包含在该验收中；509 件正式公开商品内容保持，保留运营正式发布的 22 件耳机。相关明细见本目录的执行记录及原分支保存的私有验收文件，不能把本轮隔离测试当成新的线上验收。

此前两件耳机已通过正常弹窗选择替代图、保存并重新同步核对。剩余一件时钟的图库第 6 张和 SKU#006 规格源图仍不可用。按所有者最新决定，不再追查或猜测原图；后台保留商品、失败位置、源图链接、逐件重试和 Open product 入口。运营可打开原产品弹窗预览、上传或选择替代图后保存，也可保留非必需图片的警告。不伪造 SKU 对应关系，不因一张供应商图片缺失给商品强加分类。

单件及大批量发布的性能目标未在本轮重新验收，后续按已明确的 SEO foundation 边界处理。测试通过说明列出的场景已通过，不能承诺任何外部供应商状态和所有未来输入永远没有错误。

## 表达与证据复核

按 plain-language 写作要求，复核了两个 workflow、`catalog-table-publication.test.ts`、图片问题组件及本文。具体修正包括把“CI 发布 17/20”写清为“隔离测试首次调用确认 17/20”，把“403 表示图片已删除”改为“源服务器拒绝访问，不能证明删除”。核对依据为测试的本地数据库/请求隔离、任务恢复断言、workflow 差异及实际源图响应记录。没有把“写了代码”“本地通过”“远端通过”“已经部署”混作同一结果。
