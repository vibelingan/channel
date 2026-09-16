# CUI-05：明确小标题与数量报价条件

**后续状态：** CUI-06 已接本地表单；只有最终发送仍禁用。最新表单、业务校验与后端现状见
[CUI-06 验收](CUI-06-LOCAL-ACCEPTANCE-2026-09-06.md)。以下保留 CUI-05 当时的成绩和范围。

日期：2026-09-06。分支 `fix/alibaba-sync-storage-wiring`，HEAD `60b051b`。
状态：completed-local。实现叠加在原有未提交 CUI 工作上，未 commit/push、部署、云端同步、
生产发布、RFQ 发送，也没有修改其他 worktree。此文不授予后续云端操作权限。

## 用户可见变化

- 供应商说明按明确的 `noteBlocks: {kind:'heading'|'paragraph',text}[]` 渲染。
  Experienced Headphones Manufacturer 和 Product Description 现在是加粗 h3，不再是普通段落。
- Requested quantity 初始为空；输入 2 / 500 / 1000，真实无线样本显示来源单价
  USD 5.70 / 5.00 / 3.80，并高亮命中档。低于 MOQ、阶梯空档和无价不会借用别的报价。
- 商品报价和所选配置报价独立，各 offer、regular/promotion 和币种不合并。
  SKU 更换保留数量并重新计算，商品或批准 revision 更换清空数量。
- RFQ 仍明确禁用：下一项 CUI-06 才接本地草稿与复核；不伪造发送或后台记录。

## 数据与兼容性

解析器使用已有 parse5 + sanitizer，在服务端生成类型字段，不在 React 中推断标题。
当前原始样本的两个指定标题没有 h2/h3 标记：采用用户本次确认的两个完整独立标签规则，
同时支持保留的 h1–h6。不会把正文中含该短语的句子当成标题，不用长度或首字母大写猜测。
其他边界已丢失的说明仍是段落；这不是“所有供应商 HTML 的标题都已恢复”的声明。

候选保存 `detailSourceNoteBlocksCandidate`；本地批准把块固定到 publication revision。
文本及顺序必须逐项等于 content.notes；不符拒绝。80 块、标题 200 字符、段落 2,000 字符
及既有源输入/树预算继续生效。公共接口不输出原始 HTML 或 evidence 地址。

- 无 view：strict v1，字段不变。
- `view=structured`：保留 v2 contract。
- `view=sections`：有批准 noteBlocks 时返回 v3，旧批准数据兼容回到 v2/v1。
- 新 gateway 接受显式版本，未知字段/类型/非法分页失败，不把坏 JSON 变成空商品。

金额沿用两个已有 adapter 的百分之一编码；BigInt 格式化保留安全整数数位和源币种，
不把 JPY 等重新按 ISO 指数解释，也不进行换汇/销售政策处理。以后若变更金额单位，需要
单独版本化迁移。当前展示是来源报价，不能当成本站售价或订单结算金额。

## 验证

- Site 单元/渲染测试：316/316。
- catalog-import：287/287，含标题解析、恶意/超限输入、保守表格提取。
- shared：123/123，含严格 v3、noteBlocks 与批准文字一致性、v1/v2 不被扩展。
- public-api：73/73；本地 workspace/真实 HTTP 集成：14/14。
- Chromium 新旧详情回归：18/18，包含三个 Alibaba 快照与一个生成 Excel 工作簿样本。
  标题 h3、数量边界、无价、SKU 切换、跨商品重置、390–1440px 布局、失败图片、旧详情均通过。
- site、shared、catalog-import、public-api、local-server 及 E2E 类型检查通过；
  Astro 有 7 条原有 hint，无 error/warning。site 与 public-api 构建通过。
- 第一轮 E2E 为 17/18：旧页面捕获 Astro dev toolbar audit 的一次 Failed to fetch；
  未过滤该错误、未放松测试，完整重跑 18/18。不能据此声称已修复开发工具自身偶发问题。
- 新增测试的元组类型在 E2E typecheck 中被发现并修正，再跑通过。
- 40 个相关代码文件 Biome check、git diff --check、当前文档链接/围栏和 registry 检查通过。
  生产 HTML/JS 扫描确认不包含新详情预览或数量报价组件标记。

浏览器截图保存在工作区 `output/playwright/cui05-headings.png` 和
`output/playwright/cui05-quantity-mobile.png`。不是云端或跨浏览器验收。

## 当前本地运行

页面：<http://127.0.0.1:4328/products/item/?preview=shared&id=24ee8f21-1cac-49f0-93a2-30ba1746289f>。
其他三个样本链接见 README。专用 API 为 3013；数据库副本在
`apps/local-server/data/shared-ui/ui05`。此前 ui04 / ui04-r1 保留，没有覆写。

ui05 已从 ui04-r1 复制，重放本地三个已有 Alibaba observation 与生成 Excel；无新 Alibaba
请求，无重新下载图片。只批准隔离的本地快照；不将真实云端草稿变成公开商品。

重启 API（在 `apps/local-server`）：

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec tsx src/catalog-detail-cli.ts --serve --directory ./data/shared-ui/ui05 --port 3013
```

重启 site（在 `apps/site`）：

```sh
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm exec astro dev --host 127.0.0.1 --port 4328
```

flag 只适配本机 Node 25 的现有测试运行条件，不是云端 runtime 要求。
不要在 live API 缓存同一 JSON 数据目录时另开 writer；重放前停下该 API 或创建新副本。
`catalog-detail-preview-seed.ts --quote-phase` 是已执行的一次性副本初始化，不要对已存在 ui05 重跑。

## 下一步与保留边界

CUI-06：以当前商品、canonical SKU 与有效数量建立本地询价草稿/复核，保留上下文，
验证焦点、关闭恢复及错误提示；不连接发送。CUI-07 再接列表/旧路由返回，CUI-08 做完整旅程。
分类映射、云端 canonical 回填、真实客户 Excel 整本验收、生产 rollout 与真实 RFQ 仍独立待做。
