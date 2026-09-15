# CUI-03 — 共用媒体规则与 Gallery 接口

日期：2026-09-06。当前工作区 `fix/alibaba-sync-storage-wiring@60b051b`。
本步本地完成；代码仍未提交、未 push、未部署。未调用 Alibaba sync、未改数据库。

## 移植与接口

本轮 fetch 后 `origin/refactor/catalog-architecture-hardening` 为
`5fb1a559e9ff985a7efabde2bfd037f712df641b`。计划引用的
`03b5f1742ccc7176b5cfedb8d122457a779ff671` 与新 SHA 的
`catalog-media.ts` / `catalog-media.test.ts` 差异为空。只移植这两个文件，未整体合并分支。

相对来源有两项窄修订：使用现有 `PRODUCT_IMAGE_MAX_COUNT` 代替字面量 9；空白输入在
调用 URL resolver 前排除，防止空串被 resolver 转成一个虚假的图片地址。来源原有 5 个
测试保留，再加空白映射与迟到错误测试。原本纯模块无 shared 依赖，现在仅依赖该常量。

- Gallery 与 ProductMedia 的 trim / resolver / effective URL 去重 / 九张上限委托
  `createCatalogMediaState`；失败处理委托 `advanceFailedMedia`。
- ProductMedia 保留现有 index-shaped reducer 接口，由薄转换调用同一个 failure rule，
  不复制另一套失败算法。SSR hydration 前已失败图的检查和 live-region 行为继续保留。
- `Gallery` 默认 props 仍为旧布局：方形主图、520px 上限、初始四张、可展开/收起。
- 新增可选 `layout: 'detail'`：手机图框 1.14:1、桌面 1.42:1，横向可滚动缩略图，
  使用既有 token。没有新建第二个 Gallery，也没有复制 prototype 的全局 CSS。
- 新增 `selection: { source: string | null; onChange(source): void }`。source 可以是
  canonical API path 或其已解析 URL；onChange 返回**解析后的有效公开媒体 URL**。
  点击只通知上层，必须等上层更新 source 才切图；无效/空 source 显示占位，不默默换图。
- `variantMediaSources` 只将显式关联且在父级批准图库内的 SKU 图片排前，其余交给媒体
  模块去重/限额。没有变体图、pending selection 时保留父图库；不根据图片推断 SKU。

本次视觉选择受已批准设计约束：工业编辑式风格，Poppins/Inter、现有品牌色和圆角。
通用 UI skill 的替换字体/配色建议不应用于已有品牌；默认旧页没有改成新设计。

## 测试结果

基线 site 测试 284 / 284。先使移植规格及新控制/布局测试失败，再实现；空白 resolver
回归也先 RED 后 GREEN。没有删除旧测试或添加忽略类型错误的指令。

| 检查 | 结果 |
| --- | --- |
| media + variant-media + 原 product-media 窄测试 | 24 / 24 |
| site 全套测试及测试代码编译 | 297 / 297，无 skipped |
| Astro typecheck | 0 errors / 0 warnings，7 个既有 hints |
| site production build | 通过，15 pages |
| 8 个变更 TS/TSX 文件 Biome；git diff --check | 通过 |
| 既有 sku-detail Chromium E2E | 5 / 5 |
| 新媒体组件 Chromium 验证 | 受控切换、键盘、换商品、迟到错误、耗尽占位均通过 |

测试使用本机 Node 25 和既有 `NODE_OPTIONS=--no-experimental-webstorage`，不改变远端
runtime 或业务 API。未新增依赖。没有运行或更改另一个 Excel worktree 的 4321 服务。

## 浏览器中的实际检查

本地站点：`http://127.0.0.1:4326`，PUBLIC_API_BASE_URL 指向既有只读本地 API 3012。

1. `/headphones/`：打开先前捕获的真实 Alibaba 耳机样本。初始 4 张，View All 后 6 张；
   选择第 5 张再收起，选中缩略图仍然可见。390×844 手机视口无横向溢出，主图保持方形。
   截图已实际查看：`output/playwright/cui03-legacy-mobile.png`。
2. 既有 `sku-detail.spec.ts`：详情九张上限/返回、无 slug、阶梯报价、失败重试及关联商品
   读取失败等 5 条均通过。数据请求由该套件原有受控 fixture 提供，不是新鲜云端数据。
3. `/products/item/` 的临时组件 mount：通过本地 Vite 显式加载 test-only harness，使用
   合成图片响应，直接挂载真实 Gallery/ProductMedia。没有添加测试路由或用户页面入口。
   验证 detail 最多 9 张；点击第 5 张只回调、不自行改变受控 source；上层更新后才切换；
   第 9 张键盘 Enter 可选；换商品即使图库相同也重置 index/expanded；旧 DOM 图片迟到
   error 不影响新商品；重复 URL 不重试，失败依次前进后进入占位并播报。
4. 组件图框实测：手机 358×314.03125（1.14:1）；桌面测试容器 1408×991.546875
   （1.42:1）。手机容器无溢出。该容器只验证媒体比例，完整图文列宽留 CUI-04。

组件脚本首次用了浏览器自动化执行环境没有提供的 Node Buffer；改为本地 SVG 合成
响应后，在全新专用浏览器会话重跑并取得 exit 0。最终 pageerror 为空，console 仅有
React DevTools 提示，没有应用错误。早期失败会话不算通过证据。

组件复现：运行本地 dev 后，用 Playwright CLI 的
`run-code --filename=output/playwright/cui03-component-check.js`。
该脚本、截图与 CLI 日志是忽略目录下的本地验收产物；harness 本身由 site typecheck
覆盖。生产 dist 检索确认未包含 `mountGalleryHarness` / `cui03-fixture` / harness 路径。

## 下一步与未覆盖范围

CUI-04 将新详情 presentation / controller 接入既有 item shell 的 dev-only ID 预览。
本次只给出可复用媒体组件与真实旧页回归，**不表示新整页 UI 已交付**。

完整 RFQ、quantity、选型与媒体联动、手机整页 CTA、WebKit、云端 canonical 写入和部署
仍按后续 MIU 验收。迟到错误测试是实际 DOM error 事件，不代表模拟过所有网络/解码故障。
按项目单人串行规则完成实际 diff 自审，没有独立子代理 review；其余脏文件保持不动。
