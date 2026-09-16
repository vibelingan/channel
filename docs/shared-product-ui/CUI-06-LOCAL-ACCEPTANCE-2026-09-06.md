# CUI-06：本地询价表单、联动与校验

历史阶段记录：2026-09-07 的 [CUI-06B](CUI-06B-LOCAL-ACCEPTANCE-2026-09-07.md)
已补 CountryPicker 与专用本地保存。本页的“无保存/发送禁用”描述是 CUI-06 当时状态，
不再代表当前 dev 预览；生产 RFQ 仍未上线。

日期：2026-09-06。工作区 `$CHANNEL_REPO`。
分支 `fix/alibaba-sync-storage-wiring`，HEAD `60b051b`；在既有未提交 CUI 工作上继续。
状态：completed-local-form-review。未 commit/push、部署、同步、写询价 DB、调用邮件或 CRM。

## 结论：可以本地验证，不需要等部署

现有 3013 是隔离样本服务，使用本地 JsonFileAdapter，并委托共用的真实 public detail
handler；4328 是前端。数据库和服务都存在，但不等于当前分支已有商品 RFQ 提交接口。

本轮已完成“需求 → 联系方式 → 复核”的真实表单交互；Request a quote 和
Ask about customization 可以打开，只有最后 Send request 保持禁用。
刷新即清草稿，没有假成功/假单号。当前运行目录仍是 `data/shared-ui/ui05`，无需重放原始数据。
入口与重启命令见 [README](README.md) / [CUI-05](CUI-05-LOCAL-ACCEPTANCE-2026-09-06.md)。

## 已核实的后端现状

`apps/functions/admin/src/handler.ts` 的 `submitProject` 已有 Zod、限流、上传引用一致性等
业务保护，写入的是 `oemProjects`，并会尝试发确认邮件。它不是商品 RFQ：没有当前共用
productId/revision/canonical variant 的提交语义，不能拿它来宣称 RFQ 后端已完成。

本轮新增 shared 校验模块 `packages/shared/src/catalog/quote-draft.ts`，可由浏览器和未来
服务端共同引用。Node 中验证了规则，但当前没有挂到 RFQ POST route，也没有真实 DB
重新读取/保存调用。因此“共享规则已实现”与“服务端权威校验已接线”明确分开。

## 数据流与所有权

```text
本地已批准 detail/revision + canonical SKU
  → CatalogQuotePanel：拥有页面数量、intent、打开/关闭
  → CatalogQuoteSheet：React Hook Form 拥有输入/错误，shared Zod 验证
  → requirements → contact → 内存 review（仅当前身份有效）
  × 无提交 transport、无 DB 写入、无邮件
```

- 打开带入当前 SKU 与数量。表单内改数量回流页面报价；不会把来源价格写入请求。
- 关闭同商品保留买家输入，重开回到 requirements；改 SKU 后必须重新复核。
- 换商品/批准 revision 时通过 keyed panel 清空草稿；上下文 key 对 product/revision/
  variant/intent 任一变化同步使旧 review 失效，不等待 effect 后再隐藏。
- 输入只在内存，不进入 URL、localStorage、sessionStorage。浏览器测试使用 example.test 假资料。
- 空 SKU 字符串不妨碍 canonical variant；真正零变体商品不造 variant，仍可打开商品级 customization。

## 校验分层

| 层面 | 本轮行为 | 边界 |
| --- | --- | --- |
| 基础输入 | 数量为正安全整数字符串；拒绝空、0、小数、指数、分隔符、超精度；联系名/公司/国家必填且限长，邮箱格式与长度 | 不强制客户尚未定义的采购上限或国家枚举 |
| 跨字段业务 | customization 至少一个已知且不重复的定制项、至少 10 字需求；variant_quote 不接受隐藏的定制项 | 10 字是本地表单的明确最低描述规则，不是供应商审核批准 |
| 时间 | 日期必须真实且不在过去；进入 review 时再取当前日期，避免跨午夜用旧校验结果 | 仅请求交期，不承诺交期；未来服务端必须使用自己的业务时区/日期 |
| 上下文业务 | target policy 检查可用性、产品/revision 一致、variant 存在及属于该产品；询价不能缺 variant | UI 预检只基于已加载快照；服务端必须从 DB 构建 current，不能信任 request 中的 current |
| 报价/库存 | 低于 MOQ、无价、阶梯空档、unknown/conflict 或报告库存 0 仍可询价，界面明确需确认 | 询价不是下单；不锁库存、不借父报价、不计算订单结算 |
| 数据可信度 | strict schema 拒绝夹带 price/productName 等非买家字段；展示 React 转义；无 raw HTML | 正式保存的名称、选项、图片、报价快照由服务端重读后产生 |
| 尚未接线 | 服务端重新授权读库、写入一致性、重复提交幂等、反滥用、保存/读回 | 不因已有 Zod 就把这些算作完成 |

## 技术选型与依赖风险

按既有设计核实并采用 React Hook Form **7.87.0**、resolver **5.9.1**；site 直接依赖
shared 已使用的 Zod **3.25.76**，不借用 Astro 的其他 Zod 版本。两个新增库 MIT，
已核对 React 19 / Zod 3 peer 约束和安装后的实际类型、Zod 子路径实现。
官方 [resolver 用法](https://github.com/react-hook-form/resolvers) 和
[原生 dialog 行为](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) 是核对依据。
React Hook Form 主站本轮返回 403，改以官方仓库及已安装源码/类型核实，没有把失败请求当成功。

使用原生 showModal/close/Escape，未引入自制 focus trap 或全局状态库。
pnpm install 使用 --ignore-scripts；没有顺便升级其他依赖。

**安全审计不是全绿：** `pnpm audit --prod` 报告 58 项（5 low / 25 moderate / 28 high）。
涉及现有 axios、nodemailer、Astro 等依赖；resolver 的可选 Ajv peer 又关联到了现有
`ajv@8.20.0 → fast-uri@3.1.2` 路径。应用仅导入 `@hookform/resolvers/zod`，其实际运行模块
不导入 Ajv，但不能因此把包图告警删掉或声称已修复。生产发布前需单独处置依赖风险。
本轮没有为清 audit 一次性升级整仓，未声明这些风险对所有其他服务不可达。

生产 JS 总量前后相同：545,183 bytes，逐文件 gzip 合计 160,618 bytes；新功能仍 dev-only。
独立打包 QuotePanel（React/ReactDOM external，含共享 schema 和报价组件）110,447 bytes /
gzip 31,926 bytes，仅作为该入口预算，不冒充生产增量或完整站点首屏传输量。

## 验证结果

- Site 单元/渲染：318/318；shared：127/127。基础 schema、日期与 target 业务规则执行于 Node。
- Chromium 新旧详情完整回归：21/21；38 个相关 TS/TSX 文件 Biome 检查、文档/registry 检查及 git diff --check 通过。
- 三个真实 Alibaba 本地快照和一个生成 Excel 工作簿样本共用表单、canonical 选择与入口。
- 浏览器：需求/联系字段错误与焦点、定制必填、上下文/数量带入、低于 MOQ 可询价、
  回退/重开、换 SKU 重新复核、换商品清空、无 mutation 请求、无浏览器存储 PII 均通过。
- 表单跨日期后旧交期不能进入 review，回到需求步骤并聚焦错误日期。
- 320px / 缩短到 360px 高度的可视区中按钮可滚动到达，没有横向溢出；这是缩短 viewport，
  不是声称驱动了真实手机软键盘。桌面 1440px、手机 390px 截图已实看。
- 原生 Tab 可以暂时进入浏览器 chrome；下次 Tab 返回弹窗，页面背景控件不能获得焦点。
  首次过严的“每一步 activeElement 都必须属于 dialog”断言失败；实测确定 native 行为后，
  用禁止背景聚焦及必须返回弹窗的断言取代，没有加手写锁或跳过用例。
- site / shared / E2E / public-api / local-server 类型检查通过；Astro 为 0 errors、0 warnings、7 hints。
- site 和 public-api build 通过；生产 JS 未包含 data-rfq-review / data-quote-open / shared preview 标记。
- 新依赖安装时一次 Vite Outdated Optimize Dep 504；reload 后消失，未改业务请求或过滤异常。

证据：`output/playwright/cui06-review-desktop.png`、`cui06-requirements-mobile.png`。
只使用本地快照与测试联系人，没有做云端采集、新发布或客户真实工作簿整本验收。

## 下一步建议：先做真实本地保存，再接旧列表路由

回应用户本轮的本地 DB 验证要求，下一步可以完成一条不依赖部署的纵向链路：

1. 专用 RFQ service + HTTP route，复用 shared schema；从当前本地 DB 重新读取已发布且
   未归档的批准商品和 SKU，校验归属/revision，明确保存期间版本变化的拒绝/一致性规则。
2. 在独立本地 `catalogQuoteRequests` 集合保存服务端生成的不可变上下文快照；同幂等键
   同 payload 重试返回同记录，不同 payload 冲突。不能信任浏览器的名称、价格或状态。
3. 浏览器提交 → DB 读回 → 本地服务重启读回 → 重复/并发/下架/旧版本负例；只有真实
   保存成功才显示后端返回的编号。邮件/CRM provider 显式禁用，确认没有外发。

该阶段本轮**未实施**；应在下一轮先锁定目录及受限写入边界。随后继续 CUI-07 路由和
CUI-08 完整旅程。当前本地表单交付不是生产 RFQ 上线，也不要求先部署云端才能验证。
