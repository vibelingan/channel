# Accio + Alibaba.com + TCB Agent 调研证据

日期：2026-07-28

## 已观察的本项目事实

- 现有架构把公开客服的业务真相放在 CloudBase 控制平面，把 Agent 限定为受控对话编排器。
- 现有设计要求价格由确定性、版本化规则引擎产生，LLM 只解释，不生成或修改价格。
- Hermes + 腾讯乐享链路已做过本地 PoC；生产仍需 BFF、授权、限流、审计、人工接管和数据隔离。

## Accio 官方页面观察（2026-07-28）

来源：

- `https://www.accio.com/about-us`
- `https://www.accio.com/`
- `https://www.accio.com/work/doc`
- `https://www.accio.com/work/doc?slug=quickstart`
- `https://www.accio.com/work/doc?slug=agent-tools-guide`
- `https://www.accio.com/work/doc?slug=automations-guide`
- `https://www.accio.com/work/doc?slug=channels-guide`
- `https://www.accio.com/work/doc?slug=connectors-guide`
- `https://www.accio.com/work/doc?slug=browser-use-guide`
- `https://www.accio.com/work/doc?slug=changelog`

### 经典 Accio

- 官方将其描述为 B2B 采购工具：找产品、找供应商、趋势分析、新品设计、AI 辅助询价与业务研究。
- Agent Mode 的官方定义是把采购规划推进到最终询价；典型能力包括供应商匹配、比较、起草/批量发送询价。
- 官方 FAQ 的目标用户是买家、品牌、采购团队；未在已读取页面发现第三方开发者 API、OAuth、Webhook、MCP Server 或商品目录同步合同。
- “AI-assisted inquiries / automated inquiries”证明 Accio 可以帮助买方向供应商询价，不等于能把本网站访客询盘写回 Alibaba.com 商家后台。

### Accio Work（与经典 Accio 必须分开）

- 官方首页将 Accio Work 定义为 macOS/Windows Electron 桌面 Agent 平台，而不是托管在客户 TCB 环境中的 Agent 服务。
- 官方明确写出可读取本地文件、运行终端命令、控制浏览器、调用外部 API；浏览器能力需要显式权限。
- 官方明确写出支持 MCP，用于连接“external tool servers”。这证明 Accio Work 可作为 MCP Client 消费外部工具；尚未证明它向外提供 MCP Server 或稳定的 Agent API。
- 官方写出可连接 Shopify、Gmail、Slack、LinkedIn 等 50+ 服务；已读页面未列出 Alibaba.com Seller 商品目录 OAuth 连接器的权限合同。
- 官方写出可连接 Telegram、Discord、钉钉、飞书、微信等消息渠道；这是 Agent 接收任务/回复聊天的入口，不等同于系统间数据同步 API。
- 2026-07-22 changelog 写明 Team scheduled tasks 可发 Webhook 通知；当前证据只证明任务结果通知，不证明双向远程控制、商品 CRUD 或通用 Agent-to-Agent 协议。
- 2026-07-15 changelog 写明 “Alibaba.com site builder” 可实时可视化编辑；2026-07-07 写明 Alibaba.com storefront editor 重设计。尚需核验这是生成/编辑店铺页面，还是能读取既有卖家商品目录。

### Accio Work 运行与通信边界

- Quickstart 明确要求下载并登录桌面客户端；官方只列 macOS/Windows Electron 客户端，未在已读文档中提供 Linux 容器、CloudRun、Cloud Function、无头服务端或公开 Agent REST API 部署方式。
- Automations 文档明确写明 schedule 在本地运行；电脑关闭时任务不执行，重启后只做 missed-run reconciliation。这不满足网站 24/7 客服或稳定增量同步的可用性合同。
- Channels 可以把 Agent 绑定到 Telegram、Discord、钉钉、飞书、微信/企微，让外部用户发消息；需要客户端中的 channel 在线，且默认经过 Pairing 审批。文档未列网站嵌入式 Widget 或通用 HTTP 入站通道。
- 2026-06-26 release notes 的 Webhook 是把自动化结果通知到钉钉、飞书、企微群机器人；2026-07-22 扩展到 Team scheduled tasks。它是出站通知证据，不是入站调用 Agent 的 API 证据。
- Agent Tools 文档中的多 Agent `Send Message` 只描述同一 Accio Work Team 内成员协作；没有跨厂商 A2A 协议、远程 Agent 地址注册或 TCB Agent 双向会话合同。
- Browser Agent 在 2026-04-30 release notes 中明确遇到登录墙/登录弹窗时停止并禁止自动登录；因此不能假设它可无人值守登录 Alibaba.com 抓取私有后台。
- Browser Use Guide 同时说明 Agent 可通过本地 Chrome Extension 或 CDP 复用用户已有登录 session，读取动态页面、表格并下载文件；通信走 `127.0.0.1`，默认需要操作许可。这适合员工在场、已有登录态的一次性提取/迁移 PoC。
- 浏览器方案仍依赖桌面客户端、本地 Chrome、现有 cookie、人工授权和页面 DOM；没有增量游标、Webhook、重放/幂等和字段合同，因此不能承担持续生产同步。

### Alibaba.com Connector / 店铺能力（存在，但合同仍缺失）

- 2026-04-06 release notes 明确写明新增 “Alibaba.com account authorization via Connectors”；2026-04-17 又提到授权 callback 与已连接邮箱显示。
- 2026-05-27 release notes 提到 “Alibaba.com Q&A (Business Advisor)” 可在会话内触发 Connector 授权。
- 2026-06-01 release notes 提到 `Alibaba Publish Skill (alibaba-publish-skill)`；更早版本还提到 Alibaba.com Smart Assistant plugin、shop publishing、store published versions 与 storefront editor。
- 这些名称足以证明 Accio Work 有一条获授权的 Alibaba.com 运营能力面，但公开 release notes 没有给出 OAuth scopes、支持账号类型、商品 list/detail 字段、分页、SKU/图片/类目、批量导出、增量游标、Webhook、限流、发布/更新语义或数据再使用许可。
- 当前官方 `Connecting Third-Party Apps Guide` 的 “Available Now” 只列 Gmail、GitHub、Twitter、LinkedIn、Instagram，却把 Shopify 与 Alibaba 放在 “Coming Soon”。这与 2026-04 的 release notes 冲突，可能是区域/账户灰度、特定插件而非通用 Connector、文档滞后或功能回滚。
- 在目标商家实际 Accio Work 账户中看到 Alibaba 授权卡、授权同意页、scope 列表和工具清单之前，不能把该 Connector 视为普遍可购买/可部署能力。
- 因此当前只能把它列为“值得做受控 PoC 的候选商家操作工具”，不能直接承诺为本平台的商品同步 API。

### 当前方向性判断

- 有证据支持的 PoC 方向：`Accio Work Agent -> 本平台受控 API/MCP -> CloudBase 商品草稿/知识库`。
- 尚无证据支持的反向方向：`TCB Agent -> Accio API -> Alibaba.com 私有商品/询盘`。
- Accio Work 的浏览器自动化可用于人工监督的一次性迁移实验，但不应在没有官方授权 API 合同时承担持续生产同步。

## Alibaba.com 国际站 Open Platform 官方观察（2026-07-28）

来源：

- `https://open.alibaba.com/doc/doc.htm?docId=107343&docType=1`
- `https://open.alibaba.com/doc/doc.htm#/?docId=44`
- `https://open.alibaba.com/doc/doc.htm#/?docId=72`
- `https://open.alibaba.com/doc/doc.htm#/?docId=46`
- `https://open.alibaba.com/doc/doc.htm#/?docId=49`
- `https://open.alibaba.com/doc/api.htm`
- `https://open.alibaba.com/handler/share/apidoc/getApiCategoryMixed.json`
- `https://open.alibaba.com/handler/share/apidoc/getApi.json`

### 准入模型

- 官方开放平台简介明确支持两类开发者：
	- 自研型：Alibaba.com 国际站卖家为自己的店铺开发软件，或买家为自己的采购/分销开发软件。
	- 商用型：软件开发者面向多个国际站卖家提供商用软件；卖家需要在外贸服务市场购买后才能授权使用。
- 因此单个合作商家的内部集成可评估“卖家自研应用”；若本平台要把该能力卖给多个 Alibaba.com 商家，则应按商用型 ISV/服务市场路径评估，不能复用某一商家的 token。
- 官方 System API 列出 `/auth/token/create` 和 `/auth/token/refresh`；商品 API 公共参数要求 `app_key`、`access_token`、`timestamp`、`sign_method` 与 HMAC `sign`。这证明生产接入是应用授权 + access token，不是页面抓取。
- 官方 `API权限申请` 文档说明应用类目决定可调用/可申请的权限组；商家选择 `B2B国际站企业对接` 时默认获取“国际站订单管理权限包、国际站基础权限包、ICBU-物流-快递”。服务商需先通过 `fuwu.alibaba.com` 的应用工具类目服务商申请，之后才能申请基础、订单、RFQ、物流、数据管家等权限包。
- 应用创建成功后仍需在应用控制台对目标场景点击“申请”，审批通过且权限状态变为“有效”后才可调用；不能从公开 API 文档存在推导为任意账号立即可用。

### OAuth 与 token 生命周期

- 官方把商品、订单明确归入需要用户授权的隐私数据；采用 OAuth 2.0 authorization-code 流程，商家必须在 Alibaba.com 登录授权页主动授权。
- 授权地址为 `https://open.alibaba.com/oauth/authorize`；应用使用自身 `client_id/appKey` 与已配置 callback URL 获取短期 code，再调用 `/auth/token/create` 换取 `access_token` 和 `refresh_token`。
- 官方示例返回 `account_platform=seller_center`、`expires_in` 与 `refresh_expires_in`；示例值为 25,920,000 秒（300 天），但实现不能把示例值硬编码为平台保证，应以每次返回值为准。
- 自研 ISV 生成新 token 时到期时间重新计算；商用 ISV 的服务市场授权到期基于商家购买服务时间，新 token 不延长购买授权。老 token 未过期时仍可指向同一授权。
- `/auth/token/refresh` 可在 refresh token 有效时重新激活，官方建议 access token 到期前 30 分钟刷新；refresh token 过期后需要商家重新授权。服务市场授权 ISV 不支持文档所述的“激活授权”步骤，需按其购买/授权合同处理。

### API 面与数据规模

- 官方公开 API 树在本次读取时共有 12 类、235 个方法：商品 47、交易 29、物流 21、RFQ 7，另有广告、数据管家、视频、海外分销和服务市场。
- `alibaba.icbu.product.list`：商家商品概要查询。支持商品 ID、负责人、审核状态、上下架、类目、名称、分组、`gmt_modified_from/to`；按修改时间倒序；每页最多 30；最多查询到第 5000 个商品，超出时应使用修改时间窗口缩小范围。
- `product.list` 返回商品明文/混淆 ID、标题、关键词、主图、商品类型、语种、上下架与审核状态、类目、负责人、公开详情 URL、创建/修改时间等。
- `alibaba.icbu.product.get`：单商品详情。返回结构化详情、公司/商品摘要、FAQ、属性、主图/详情图、描述、MOQ、FOB 价格区间、币种、付款方式、供货能力、交期、港口、包装、批发价格、SKU、阶梯价、SKU code、库存、定制项和公开详情 URL。
- `alibaba.icbu.product.schema.render`：按商品 ID/类目渲染新商品 schema 与已有填写数据；适合完整编辑数据读取。
- `alibaba.icbu.product.schema.update`：增量更新商品，只修改传入字段；另有 `schema.add`、轻量接口、草稿、批量上下架、库存、图片银行、类目/属性、质量分等接口。
- 上述公开文档已证明构建“定期拉取获授权商家的已上架商品 -> 规范化 -> 本站草稿/知识库”的技术 API 面存在。目标应用能否获批、独立站展示/Agent 检索是否在授权目的内仍未验证；后台是否有 CSV 导出按钮不再是决定性限制。

### 询盘与消息边界

- 完整公开 API 树中未发现明显的店铺私信、TradeManager 消息或买家询盘正文读写 API。
- `ICBU-RFQ` 域的 `rfq.search/rfqdetail.get/quotation.post` 是查询公开 RFQ 并由供应商报价，不等同于商家店铺收到的私信询盘。
- 数据管家的“公司询盘流量行业表现”是指标，不是询盘内容。
- 因此“商品目录同步”有明确官方接口证据；“把本站访客对话/询盘同步回 Alibaba.com 消息中心”目前没有同等级证据，应标为待 Alibaba Open Platform/客户经理确认，而不是默认可做。

### 架构含义

- 对商品数据，优先级应为 `Alibaba Open Platform API > 商家提供的获许可文件导入 > Accio Work 辅助 API 操作`。浏览器抓取不作为推荐数据路线。
- Accio 可以帮助选品、分析、生成文案或操作草稿，但不应取代 Open Platform 作为数据合同和同步真相源。
- 首期最好只读导入，写入本站 `IMPORT_DRAFT`，由商家审核发布；不要一开始做双向自动改价/改商品，以免形成循环覆盖和错误商业承诺。

### 数据与合规边界

- 官方个人信息规范明确禁止合作伙伴以任何方式爬取 Alibaba.com 及关联公司旗下平台数据。因此，不应使用 Accio Work 浏览器 Agent、Playwright 或自写脚本长期抓取商家后台；即使用户已登录也不能替代 Open Platform 授权。
- 对通过平台功能授权取得的个人信息，只能在用户授权范围和履行用户合同所必需的目的内处理；超范围使用需要另行取得合法性基础。
- 官方规范特别写明不得将授权个人信息用于超出授权范围的用途，包括自动化决策，也不得转委托他人处理。将询盘/联系人数据发送到 Accio 模型、其他 LLM 或第三方 SaaS 前，必须确认授权、数据处理协议和模型数据保留政策。
- 未经用户单独同意不得向第三方披露；跨境传输需要完成适用评估程序。商品本身未必都是个人信息，但负责人、账号、询盘联系人、订单和行为数据可能属于个人信息，应做字段级分类而不是整包喂给 Agent。
- 传输与存储个人信息必须加密或去标识化，密钥安全存储；仅授权人员可访问；需完整日志、审计能力、至少每年自查，并保存个人信息保护影响评估 3 年以上。
- 必须支持查阅、复制、更正、删除、撤回同意；目的完成、期限届满、撤回同意或合作终止时应删除相关个人信息。授权证据必须可追溯。
- 平台有权在异常或泄露时限流、关停接口并要求删除数据；集成必须有连接禁用、密钥销毁、数据清除与事件响应 runbook。官方已读资料未提供 revoke endpoint 或撤权事件合同，需通过认证错误/到期检测与账户内实测补齐。
- 入驻规则明确写明获授权商家数据仅可展示和使用于数据来源的同一卖家，不得共享给其他组织/个人，也不允许聚合多个店铺数据。该限制要求 tenant-scoped 存储、查询、索引和 Agent 工具授权。

## 待核验

- Accio Work 是否提供公开 Agent API、入站 Webhook、MCP Server 或跨厂商 Agent-to-Agent 协议；当前只验证到 MCP Client 与出站通知。
- Accio 是否能读取特定商家的 Alibaba.com 私有/已上架商品，而不只是搜索公开商品。
- Alibaba.com Connector 与 `alibaba-publish-skill` 的实际 OAuth scopes、读写字段、账号资格、批量/增量能力、限流和许可。
- Alibaba.com 商品 API 的具体权限包、应用审核、token 有效期、调用配额、push topic 与目标商家授权流程。
- Alibaba.com token 主动 revoke endpoint、撤权事件/错误码与授权终止后的缓存数据处理合同。
- Alibaba.com 是否另有非公开/申请制的店铺询盘或消息 API；公开 API 树本次未发现。
- 商品标题、图片、详情、商标/认证等内容跨站再发布的知识产权许可与平台规则；商家 OAuth 授权不自动等于拥有所有素材版权。

## 暂定判断

- 不把经典 Accio 或 Accio Work 视作商品主数据源或跨平台消息总线；Alibaba Open Platform 才是已有官方字段合同的首选候选。
- Accio Work 可能作为内部员工桌面上的编排/操作助手，但商品真相源与同步状态仍应归本平台控制平面所有。
