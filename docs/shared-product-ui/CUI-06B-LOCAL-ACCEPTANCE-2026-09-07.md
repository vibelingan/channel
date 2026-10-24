# CUI-06B — CountryPicker 与本地询价保存

状态：completed-local。工作区 `fix/alibaba-sync-storage-wiring@60b051b`，在已有未提交
CUI 工作上继续；没有 commit、push、合并、部署、云端同步或邮件外发。
本阶段来自用户“CountryPicker 搞好…搞完后接下来下一个阶段开始实现”的明确授权。
旧 CUI-06 只做到 review；本记录取代其“本地没有保存接口”的当前状态声明。
CUI-07 的旧列表/slug 路由接线仍未实施。

后续状态：用户已批准并完成 [CUI-06C 本地 Admin 闭环](CUI-06C-INQUIRY-ADMIN-2026-09-07.md)。
下文保留 CUI-06B 当时的验收快照；其中测试记录的 `new` 状态和启动命令不是最新状态。
当前处理状态、受保护的后台读取入口及包含 Admin 开关的重启命令以 CUI-06C 为准。

## 当前可以做什么

打开 [本地无线样本](http://127.0.0.1:4328/products/item/?preview=shared&id=24ee8f21-1cac-49f0-93a2-30ba1746289f)，
Request a quote → Requirements → Contact → Review → **Save inquiry locally**。
只能用测试资料。返回的编号来自实际写入，不是前端生成的假 receipt。
记录位于 `apps/local-server/data/shared-ui/ui05/db.json` 的 `catalogQuoteRequests`。
不注册公共/通用 CRUD 读入口，不把联系方式放进 HTTP 响应。

已保留一条供检查的测试记录：`038e137e-300e-4cfa-a7fe-fd6465622943`。
country=`HK`、quantity=`500`，product=`24ee8f21-1cac-49f0-93a2-30ba1746289f`，
variant=`42516c60-7284-4189-8184-bab8617f61b4`；status=`new`，notification=`disabled-local`。
浏览器显示真实编号，磁盘读回一致；重启本地 API 后记录仍存在。原有 4 个样本商品未改。

## CountryPicker 选型与契约

现有 `components/form/Select.tsx` 是无搜索的手写 select-only listbox。本次不扩大它的
状态机或替换所有既有调用，而是在同一 form 目录增加搜索型同级组件，沿用同一品牌、
边框、圆角、44px 操作尺寸和错误样式。

- [React Aria ComboBox](https://react-aria.adobe.com/ComboBox)，锁定
  `react-aria-components@1.21.1`，Apache-2.0，已核对 React 19 peer 和安装类型。
  库负责组合框/列表选择/键盘/焦点，项目只封装国家数据、名称或代码搜索和表单接口。
- [i18n-iso-countries](https://github.com/michaelwittig/node-i18n-iso-countries)，锁定
  `7.14.0`，MIT；只导入单个 en JSON，不导入包含全部语言的 Node 入口。
  此版本数据有 250 个国家/地区条目，含 `XK` 扩展；不是声称 ISO 正式分配数为 250。
- 持久化稳定代码，`Intl.DisplayNames` 生成标签；未知 locale 回退英文，未知代码不造标签。
  shared `CountryCodeSchema` 只接受该版本数据集合成员，拒绝空、自由文本、对象、`ZZ`、
  `UK`、小写/带空格代码。无 IP 默认值，无国旗作为唯一标签，无远程国家查询。
- RHF `Controller` 接 value/onChange/onBlur/ref，错误能聚焦真实输入框。
  支持搜索无结果、清空、键盘选项、必填/disabled、description/error、窄屏。
- 当前 `country` 明确表示 **Company country / region**，只是首次联系的公司所在地。
  不是配送资格或详细收货地址。后续 shipping/billing 分开建字段，复用同一组件。

原生 dialog 集成另有两条窄适配：浮层留在本组件的 fixed portal，避免 body portal
落到 native modal 后面；Escape 在 window capture 防止同时触发外层 dialog 取消。
不自制 focus trap。当前使用库仍支持但已标记 deprecated 的 `UNSTABLE_portalContainer`，
仅封装在此组件，升级时需按官方 PortalProvider 接口复核；不能将这项说成稳定 API。

测试中还发现：自动化直接 fill 一个仍被滚动容器遮挡的输入框，后续自动滚动会按库规则
关闭 popup。改成真实用户可执行的“先点击可见输入，再输入”，没有加 sleep/force click。
搜索/清空/Escape 与跨日期测试连续 3 轮、6 次通过。曾出现的类型、YAML 冒号和 HMR
干扰均已修复并重新验证，没有跳过失败断言。

## 保存的数据流与边界

```text
已批准 detail + canonical variant + buyer fields
  → RHF / shared Zod → 明确 Review
  → dev-only local transport（不带 cookies、不接受重定向）
  → 受限本地 HTTP → JsonFileAdapter 的同一 mutation lock
  → 重读发布状态/批准 revision/变体集合 → 生成服务端快照 → 原子保存
  → {ok, requestId} → 显示本地成功编号
```

1. `CatalogQuoteSubmissionSchema` 严格允许 fields/target/idempotencyKey，拒绝夹带价格/
   商品名以及 intent 不一致。基础国家、数量、定制、日期规则由 shared 统一定义。
2. 写入在与全部 JsonFileAdapter catalog mutation 相同的锁内；重载磁盘后检查本地 clone、
   发布且未归档、批准 header 产品 ID、当前 revision、完整变体数量、变体归属/approved ID。
   不是服务外先 get、随后无保护 create。server 日期明确使用香港日历日。
3. 名称、图库、父报价及选中变体快照取自批准数据，浏览器无权提供。
   报价只是当时讨论依据；不锁库存、不生成订单/发票、不向旧 OEM 接口发送。
4. 幂等键 hash 与规范化 payload hash 保存；同键同内容返回同编号，不同内容返回冲突。
   已接受的原请求重试不因商品后来下架而变成第二条请求。新请求必须通过当前状态校验。
5. 前端发送中阻止回退/关闭与连点；没有 transport 默认禁用，不会回退旧 OEM。
   网络结果不明只显示可重试错误，不制造成功。同一未改的复核沿用同一个键。
   幂等键与草稿只保留在内存；刷新/改内容会创建新的逻辑请求，不宣称跨浏览器去重。
6. CLI 必须显式 `--enable-local-quotes`；仅 loopback 服务、固定本地 Origin、
   application/json + 自定义头、16KB 请求体、每分钟 60 次请求上限。
   这些是本地隔离措施，不是可直接暴露互联网的鉴权/反滥用方案。
7. JSON 样本库无静态加密，故提示只用测试联系人；无 PII localStorage/sessionStorage。

## 本地启动

不要针对正在运行的同一 JSON 目录启动第二个写入进程。先确认 PID/cwd 并停止旧 API。
此次没有重新 seed、重放源数据或下载媒体，继续使用 ui05。

在 `apps/local-server`：

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec tsx src/catalog-detail-cli.ts --serve --directory ./data/shared-ui/ui05 --port 3013 --enable-local-quotes
```

在 `apps/site`：

```sh
PUBLIC_API_BASE_URL=http://127.0.0.1:3013 NODE_OPTIONS=--no-experimental-webstorage pnpm exec astro dev --host 127.0.0.1 --port 4328
```

Node flag 仍仅是本机 Node 25 的既有开发兼容设置，不是云端运行时要求。

## 验证与剩余风险

- Site 318/318；shared 129/129；local-server 68/68（包括 3 个新 RFQ 集成用例）。
- 新旧详情 Chromium 非写入回归 22/22；显式本机真实写入 1/1；CountryPicker/日期重复验证 6/6。
- 服务端覆盖并发 8 次同键只保存一次、重开 adapter 重试、异 payload 冲突、非法国家/字段、
  缺失/外来/归档变体、旧 revision、下架、HTTP Origin/格式/体积与不存在的公开读取能力。
- Site、shared、local-server 类型检查与 site build 通过；Astro 0 errors / 0 warnings，
  8 hints（包括新 portal deprecated 提示），并非所有提示为零。
- 生产 build 不包含 CountryPicker / 本地 receipt 标记；生产 JS 仍为 545,183 bytes，
  每文件 gzip 合计 160,618 bytes，未把 dev 功能带上线。
- 独立 QuotePanel bundle（React external，含原有 RHF/Zod/报价组件）327,576 bytes，
  gzip 98,613 bytes；上一版为 gzip 31,926 bytes。这是采用成熟交互库的明确成本。
  生产接线前应将询价 sheet 按需加载并重新测量，不能宣称“零包体成本”。
- `pnpm audit --prod` 仍有 58 项告警：5 low / 25 moderate / 28 high，无 critical。
  本轮未扩大为全仓依赖升级；发布前必须处置已有依赖风险，不能据测试通过宣称安全全绿。
- 证据截图位于 `output/playwright/cui07-local-inquiry-receipt.png`（文件名前缀历史命名，
  实际对应本 CUI-06B），测试记录没有发到任何真实联系人。
- CountryPicker 桌面与手机截图已实看：`output/playwright/cui06b-country-picker-desktop.png`、
  `output/playwright/cui06b-country-picker-mobile.png`。Registry 的 9 个任务通过唯一性、
  依赖无环、完成文件存在与验收文件存在检查；本轮相关源码 Biome 与 git diff --check 通过。

后续：CUI-07 接旧列表/直达和返回状态；生产 RFQ 需要真正的 CloudBase 事务 adapter、
一致的读取/审批生命周期、反滥用、销售端查看处理与通知。国家地址政策、正式售价、
报价单/订单/发票/付款仍要客户确认，均不在本轮自动实现范围内。
