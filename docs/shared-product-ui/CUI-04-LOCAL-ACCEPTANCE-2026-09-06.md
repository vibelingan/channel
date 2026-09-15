# CUI-04 — 首个真实数据详情页面

日期：2026-09-06。分支 `fix/alibaba-sync-storage-wiring`，HEAD `60b051b`。
状态：completed-local。包含本轮及前序 CUI 的未提交代码；没有 push、部署、云端同步、发布或 RFQ 发送。

**后续用户实看复核：** 此处成绩证明功能纵向切片，不代表最终内容/视觉设计签收。
20:04/20:09 截图暴露纯文本层级不足与中间屏宽大图，已补充
[复核](CUI-04-DESIGN-REVIEW-2026-09-06.md)。保留本文件原始测试事实；
后续已批准实施的当前效果、最新成绩与重启路径见[修订版验收](CUI-04-REVISION-ACCEPTANCE-2026-09-06.md)。
下文旧比例/固定 CTA 是初版历史，不再是当前设计；API 3013 当前读取 `ui05`，
最新小标题/数量报价与重启步骤见 [CUI-05 验收](CUI-05-LOCAL-ACCEPTANCE-2026-09-06.md)。

## 本轮实现与设计取舍

现有 `/products/item/` shell 增加显式 `?preview=shared&id=<canonical id>` 的 **dev-only** 入口。
线上构建剔除预览组件和文案；旧 slug 页面保持原行为，未知/错误 ID 不回退旧 DTO。
Controller 位于 `src/catalog/application/CatalogDetailController.tsx`（替代计划中的 shop 路径），
负责取消请求、递增 generation、revision 分页、SKU 与图片选择。叶子组件不区分供应商。

复用当前 SiteHeader/Footer、Poppins/Inter、brand/accent tokens、Gallery；没有复制原型全局样式。
桌面维持原型 1.08/.92 图文列，手机为标题→图库→SKU、底部固定禁用的询价按钮。
真实 SKU 是可选单选项；多于 12 行改为原生选择框，重复标签显示 canonical ID，
无虚构 option 笛卡尔积。库存保留 reported/unknown 语义，不把未知变为零。
图库点击不改变 SKU，没有明确关联的 SKU 不按颜色猜图。facts 平铺，description 作为文本。

已检查 refactor 远端参考 `5fb1a559e9ff985a7efabde2bfd037f712df641b` 的旧 CatalogDetail：
它依赖供应商特定 pricing decision，不能直接当新契约的通用组件，故本轮只复用现有共享接口，
不合并整个 refactor 分支。店小秘原始原型 worktree 未改动。

## 数据与本地运行

API `3013` 读取 `apps/local-server/data/shared-ui/ui04/db.json` 与同目录 media。
该目录由 UI-02 已批准样本复制，再经真实 Excel parser → observation adapter → local
materialize → explicit local approval 添加 **1 个生成的 Excel 测试商品**。没有客户 workbook 验收声明。
三件 Alibaba 商品 ID、图片和详情快照保持不变（3/6/4 个 SKU）；Excel 样本有 8 个 SKU。
所有数据文件保持 git-ignored，不导出任何 token、原始证据或账户字段到页面。

一开始给 Excel 样本去掉图片，publication guard 返回 invalid-product；追踪到
`validateProductPublication` 的必需图片规则。没有绕过该规则，改用已有验收测试像素，
第一次准备目录保留为 `ui04-failed-no-image-20260906`。这不是 Alibaba 图片缺失。
示例标题带 `[Excel test fixture]`，不能把白色测试像素当成真实商品摄影。

已启动：site `4328` → API `3013`。原 `4321` 店小秘服务、`4326`/`3012` 前序服务未动。
直达链接见 [README](README.md)。只有本机可访问；没有 tunnel 或外网发布。

服务关闭后，在两个终端分别重启（不要重复启动已占用端口）：

```sh
cd $CHANNEL_REPO/apps/local-server
NODE_OPTIONS=--no-experimental-webstorage pnpm exec tsx src/catalog-detail-cli.ts --serve --directory ./data/shared-ui/ui04-r1 --port 3013
```

```sh
cd $CHANNEL_REPO/apps/site
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm exec astro dev --host 127.0.0.1 --port 4328
```

`catalog-detail-preview-seed.ts` 是一次性准备入口，目标目录存在会拒绝覆盖，**不要每次启动重跑**。
更不能对运行中的 JsonFileAdapter 数据文件开第二个写入进程。Node 25 的 Web Storage
flag 仅为当前本机兼容选项，既不是业务依赖，也不表示云端 runtime 改成 Node 25。

## 验证结果

遵循执行计划、TDD 与 completion verification；按当前单人规则自行复核 diff，未派发独立 reviewer。

- 前端完整 tests：**303/303**（含 test TypeScript 检查）。
- Astro check：**0 errors / 0 warnings / 7 个既有 hints**。
- local-server typecheck：通过；本地详情持久化/双 adapter/HTTP 集成：**13/13**。
- Chromium：**14/14**，其中 9 项新预览验收 + 5 项旧 slug 回归。
- build：**15 pages**；37 个产物 JS/HTML 没有预览组件标识或预览文案。
- 用临时 `4329` 静态预览实际打开同一 query：只显示旧页 Product not found，
  新详情组件数量为 0；验证后停止该临时服务，保留 `4328`/`3013`。
- Biome：30 个相关 TS/TSX 文件通过；`git diff --check` 通过。

浏览器覆盖：3 个真实 Ali + 1 个 Excel 样本实际 GET/图片解码/最终 SKU 选择；
390×844 手机 SKU 点击和方向键；图库不改变 SKU；无横向溢出；51st URL SKU 等待
revision-pinned page 2；409 清空快照并重试；404/坏 JSON 不回退；空字段与 HTML 文本；
从延迟 A 切到 B，A 响应不能复活旧选择。截图实际检查桌面 1440×1000 与手机视图。

首次浏览器运行暴露单选 input 的 1px 隐藏点击区被 label 截获，改为覆盖整个选项的透明
原生 input，保留 peer focus 样式和键盘行为；重复标签增加可见 ID 的测试先红后绿。
另纠正测试的文案定位和 Astro dev toolbar 造成的全页匹配冲突，没有删掉失败断言。

命令（仓库根目录）：

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site test
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site exec astro check
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/local-server typecheck
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/local-server exec tsx --test src/catalog-detail-workspace.test.ts
E2E_SHARED_DETAIL_PREVIEW=1 E2E_SITE_URL=http://127.0.0.1:4328 NODE_OPTIONS=--no-experimental-webstorage pnpm exec playwright test tests/e2e/shared-detail-preview.spec.ts tests/e2e/sku-detail.spec.ts --project=chromium
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @vibelingan-channel/site build
```

本地浏览器测试 IDs 对应此已保留样本集；重建样本导致 canonical IDs 改变时需同步测试/链接。
截图：`output/playwright/cui04-desktop.png`、`output/playwright/cui04-mobile.png`（git-ignored）。

## 明确未完成

数量、阶梯报价展示、询价表单是 CUI-05/06；目录返回与旧列表新入口是 CUI-07；
完整多浏览器/旅程验收是 CUI-08。移动端截图里的固定 CTA 目前明确禁用。
源属性同义归并、客户分类确认、Admin 新审核流与生产批准生命周期不在本轮。
源标题和 SKU 属性可能矛盾（例如标题 with MIC，而属性 no microphone），当前保留原值。
这次没有新鲜 Alibaba API 请求；真实数据是先前取得的本地样本，不代表云端新 UI 已上线。
