# CUI-04 修订版：收紧图库、恢复内容层级

**历史验收记录：** 用户随后认可此版，要求明确小标题字段并继续下一阶段。
当前实现与重启路径已由 [CUI-05 验收](CUI-05-LOCAL-ACCEPTANCE-2026-09-06.md) 取代；
下文测试数、ui04-r1 及未实现数量报价等描述均是本记录形成时的事实。

状态：implemented-local-awaiting-user-visual-review。用户指令：“按照修改的方案改一版我看看”。
分支 `fix/alibaba-sync-storage-wiring`，HEAD `60b051b`；本轮叠加在既有未提交 CUI 工作上。
没有 commit/push、部署、云端同步、发布、RFQ 发送，也未改动店小秘工作区或来源快照。

## 当前效果

- 标题附近显示至多三个简短参数；无线样本只有已提供的 Material / ABS，不凭空补卖点。
- 商品规格用键值行，包装配件另列；供应商介绍、服务和无法分类的文字默认折叠，行长 70ch。
- 图库保留整图、留白、缩略图和张数。禁用 RFQ 改为内联，不占手机固定底栏。
- 旧 v1 描述按段落显示；新内容不可用或管理员改过描述时保留兼容路径，不进行浏览器端猜测。
- 分类映射、数量/来源报价、真实 RFQ 与正式路由切换仍未实施。本轮等待用户查看修订效果。

当前规范以 [DESIGN §4](DESIGN-2026-09-06.md) 为准；[初版验收](CUI-04-LOCAL-ACCEPTANCE-2026-09-06.md)
中的旧比例、固定 CTA 和成绩明确标为历史。README / MIU / TASK-REGISTRY / 审查文档同步更新。

## 共享内容路径与安全边界

Alibaba / Excel observation → `buildStructuredContent` → 私有本地候选 → 显式批准快照 →
`GET /api/products/:id/detail?view=structured` → strict v2 decoder → 同一 CatalogDetail。

复用现有 sanitizer，新增直接依赖 parse5 **7.3.0**（原 lockfile 已有其间接依赖，离线安装，
无新增网络下载）。使用其[官方 fragment AST 接口](https://parse5.js.org/functions/parse5.parseFragment.html)，
没有自建第二套 sanitizer、没有向浏览器发送源 HTML、没有 `dangerouslySetInnerHTML`。

- 输入最多 64,000 字符；AST 4,000 节点、深度 32；输出每组最多 100 行、说明 80 段，
  名称 200 字符、值/段落 2,000 字符。超限返回 warning + 无内容块，保留已批准文本，不截断字段。
- 两个明确非空格才作为行候选；空列可忽略，多值/未知标签转说明；同名不同值不选赢家。
- 原表存在嵌套或合并格时保守地把该 observation 的所有表格留为说明，避免 sanitizer 删除
  整张表后按序号错误匹配。历史 sanitizer 已经丢失的 colspan/rowspan 无法从快照补回。
- 已批准 facts 与描述候选同名冲突时，不晋升摘要；两值仍保留在说明。SKU 相关麦克风/
  连接方式不选作摘要；产品级规格和选中配置有明确语义提示，不声称供应商信息已经认证。
- public v1 **不增加字段**；新 UI 显式 opt-in v2，无已批准 content 时返回 v1。
  坏 v2 不伪装成 v1；未知/重复 view 参数 400；未发布/未批准 404；跨 revision 409。
- 新 content 跟随批准 revision。管理员修改描述后不继续批准旧提取值。warnings 留在私有候选，
  公共 projection 不包含 HTML、证据路径、账号或来源身份。

这不是全量供应商 HTML 清洗问题的终结。未知分类规则和真实性审查仍需后续审核；本轮没有
改写原始数据或擅自修正供应商标题/麦克风信息之间的矛盾。

## 本地数据和启动

原 `ui04` 未写入；复制到 **`apps/local-server/data/shared-ui/ui04-r1`** 后重新物化/批准本地样本。
三件 Alibaba 使用已有 observation 和本地图片，零 Alibaba API 请求；Excel 用真实 parser
解析生成验收文件，不是客户工作簿。产品 IDs、SKU IDs、19 个本地图片保持复用。

四个直达链接仍在 [README](README.md)，端口仍是 site **4328** / API **3013**。
`?preview=shared` 仍为 dev-only，旧列表和 slug 页面尚未替换。

已有数据时只启动，不重复 seed：

```sh
cd $CHANNEL_REPO/apps/local-server
NODE_OPTIONS=--no-experimental-webstorage pnpm exec tsx src/catalog-detail-cli.ts --serve --directory ./data/shared-ui/ui04-r1 --port 3013
```

```sh
cd $CHANNEL_REPO/apps/site
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm exec astro dev --host 127.0.0.1 --port 4328
```

仅在目标不存在且未运行目标 DB 服务时，准备步骤是 seed `--content-revision`，随后
CLI `--directory ./data/shared-ui/ui04-r1 --approve-local --port 3013`。seed 独占建目录，存在即拒绝覆盖。
Node flag 仅用于本机 Node 25 兼容，不是业务功能或云端 runtime 变更。

## 验证证据

按执行计划/TDD 先看到 parser、结构化 HTTP、呈现用例失败，再实现转绿；R1 曾实测
900px 下原 600px 高图框超过目标，修后为 360px。遵守当前单人要求自行审查，未派发 reviewer。

| 检查 | 结果 |
| --- | --- |
| site 完整 unit + test TS | 310 通过 |
| catalog-import 完整测试 | 286 通过，含 10 项新内容提取测试及真实 Excel 单元格路径 |
| shared 全文件 glob 测试 | 122 通过，含 v1/v2 strict 和共同分页约束 |
| public-api 测试 | 73 通过 |
| local workspace/真实 HTTP 集成 | 14 通过，含两来源批准、v1 兼容和手改描述保护 |
| Chromium 新预览 + 旧 slug | 17 通过；四样本、八断点、长标题/坏图片、旧页回归 |
| 类型检查 | shared / import / public-api / local-server / E2E 通过；Astro 0 errors、0 warnings、7 既有 hints |
| 构建 | site 15 页；public-api tsup 成功；生产产物未发现新预览组件/文案/structured 请求 |
| 格式与差异 | 相关 TS/TSX Biome、git diff --check 通过 |

重跑时使用 `NODE_OPTIONS=--no-experimental-webstorage`；shared 测试显式使用引号
`tsx --test 'src/**/*.test.ts'`，避免 shell 只展开单层目录而漏掉 src 根部测试。

浏览器高度 900 CSS px，同一无线样本（包括新增摘要和张数）：

| viewport 宽 | 图框宽×高 | SKU 区 Y |
| ---: | --- | ---: |
| 390 | 358×332 | 1020 |
| 640 | 560×360 | 1002 |
| 700 | 560×360 | 1002 |
| 768 | 560×360 | 964 |
| 900 | 560×360 | 964 |
| 1023 | 560×360 | 964 |
| 1024 | 420×420 | 498 |
| 1440 | 537×420 | 458 |

单栏仍需向下滚到选型：没有宣称长标题商品能在手机首屏塞完全部信息。已验证缩略图 6
可滚动到并点击，CTA 不固定遮挡，页面不横向溢出。720×450 用例验证相当于 1440 窗口
200% 时的 CSS 宽度重排和坏图选型；**未驱动原生浏览器 zoom 菜单，不等同跨浏览器缩放验收**。
原生 zoom / Safari 等完整覆盖仍属 CUI-08。

已逐张查看截图：`output/playwright/cui04-revision-desktop.png`、`cui04-revision-900.png`、
`cui04-revision-mobile.png`、`cui04-revision-sample-2.png`、`-3.png`、`-4.png`。
截图里的黑色浮条是 Astro 开发工具，不属于页面 UI，也不进入生产构建。
