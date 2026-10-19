# 商品 SEO 工作记录

范围为独立商品 URL、初始 HTML 和原有交互复用，工作目录为独立 SEO worktree。main `37bcea5b`；pricing 最初 `658d126a`，实施中更新到 `9d9cfdeb`。pricing 的工作目录只读。

实际读过的规则与源码包括根 AGENTS、PUBLIC_PAGE_CONTRACT、ENGINEERING_CRAFT 的 Public API Projection/Frontend Islands/E2E/Deploy/Test efficacy 部分，以及 CloudBase SDK 合同说明。没有新增或调用 CloudBase SDK。

实现前核对 `SharedDetailPreview.tsx`、`SkuDetailPage.tsx`、`CatalogDetailController.tsx`、`catalog-product-detail-state.ts`、`catalog-detail-pages.ts`、`catalog-detail-api.ts`、`CatalogDetail.tsx`、`Gallery.tsx`、`CatalogDescriptionImages.tsx`、`CatalogSpecifications.tsx`、`catalog-content-view.ts`、`CatalogQuotePanel.tsx`、`CatalogQuoteSheet.tsx` 和公开询盘 transport。还核对两类商品卡片、taxonomy、共享 product-detail/PublicProductSchema 和 pricing 的相关 diff。

环境核对：CI Node 22.13.0、pnpm 11.5.0；按锁文件安装后 Astro 实际为 6.4.6。MIU 原先写成依赖范围起点 6.4.2，已按实际安装版本修正。官方 Astro routing/framework-components 文档只作合同参考，以真实构建验证行为。

匿名 API 读取观察到 total=487、实际 pageSize=48。分页采集全部 ID，随后重新比较清单和公开详情 revision；得到 487 个结构化详情。快照仅保存白名单公开字段，没有使用登录态或管理员接口。空 category 按旧数据兼容为未设置，不删除对应商品。

先写 bootstrap/快照测试，记录模块缺失和 idle 行为导致的失败；实现后逐步通过。原 transport 测试按 byte-budget-v1 对齐；原卡片测试改为检查标准 href。公开 metadata 路由枚举加入新标准页及实际 PageDescriptor 绑定检查。

措辞检查做了两处具体修正：卡片注释从“button，never a link”改为“普通点击展开，修饰键访问标准页”；报告把“495 页收录”明确写为“495 个可索引构建地址”，不把产物或 sitemap 等同 Google 收录。

浏览器依据实际 DOM 修正验收脚本：正文按空白折叠比较；图库后台预取不作为页面 ready 条件；国家选项是 Japan (JP)；分类返回保留原本的 page=1 规范化。最终完整走了需求、联系人、国家、确认和本地提交，校验 product/variant/revision。没有向客户提交真实询盘。

真实产物验证发现发布检查误读 SEO manifest 根结构，修正为其生产者实际输出的 `{schemaVersion,siteOrigin,entries}`，补测试后以 487 页真实构建和实际 fixture 产物分别验证允许/拒绝。没有绕过部署检查。

SSR 变异采用真实路由：临时把 client:load 改为 client:only，构建因初始 H1 缺失失败；finally 恢复源码。更新/撤回采用独立 fixture 输出目录，验证正文/版本变化及旧 HTML/sitemap 移除；它不证明远端 CloudBase 或 CDN 已删除旧页。

pricing 模拟合并起初一处分页测试文本冲突，通过保留 pageSize=51 负向断言解决。合并后的 pricing 价格测试仍依赖 button 标签，已在临时副本应用最小 anchor 选择器补丁，保留全部价格/MOQ 断言；补丁随文档交付，不改 pricing 工作目录。图片准备集成用例的首次失败保留日志，基线和重跑结果见状态报告。

最终测试数、构建数、浏览器证据、合并结果和上线边界以 PRODUCT_PAGES_STATUS.zh-CN.md 与 evidence/product-pages-2026-10-19.json 为准。用户普通浏览器登录、其他工作目录、Hermes、Blog、生产数据及线上部署均未操作。


## 按用户要求整理回原 SEO 分支

商品页另开分支违反本轮用户要求，已把其 5 个提交快进合回原 `feat/seo-foundation`，代码树与商品验收提交 `cf0c9bcd` 一致。整理前确认两个 worktree 无未提交的 tracked 修改；检查进程 cwd，并复制全部 output 与已验收 dist 共 1,296 文件、291,253,246 字节，逐文件校验 SHA-256。忽略项除已保留的输出外是 node_modules、.astro、dist，可重新生成。pricing 和其他 worktree 不在本次清理范围。

本次实际核对 `PRODUCT_PAGES_STATUS.zh-CN.md`、`PRODUCT_PAGES_MIU.md`、验收 JSON、`prepare-product-seo.ts`、`[publicKey].astro`、`CatalogDetailController.tsx`、`astro.config.ts` 和 Git 提交树。措辞将“独立分支”改为当前的“统一在原分支”，并将“尚未合并”限定为“尚未合并 main”，避免把本地分支整理误写成主线已交付。补充 SSG 代码路径，明确 Astro 构建 HTML、React hydration 和 API 刷新的先后关系，以及静态正文仍需重新构建发布的限制。

整理后核对：运行代码目录（apps/packages/scripts/.github/.env.example）相对 `cf0c9bcd` 没有差异；git diff --check 通过；发布保护用例 1/1 通过；迁移后的真实构建通过 487 个商品检查。尝试在原 worktree 重跑 3 个定向站点测试文件，进程因本地文件读取停滞而未产出测试结果，已停止，不能计为通过。此前完整站点和浏览器验收仍以已保留日志为据，本轮没有宣称重新执行完整套件。多余商品 worktree 及分支已经移除。
