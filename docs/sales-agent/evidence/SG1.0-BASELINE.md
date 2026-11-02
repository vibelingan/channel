# SG1.0 询盘代码核对与复用结论

2026-10-23。SG1.0完成的是指定提交的源码核对，不是询盘自动化上线。清单包含44份文件、7组链路、80处源码标记；机器检查固定提交、文件SHA-256、行号及分支关系。没有执行官网提交、读取客户记录或修改原业务代码。

## 选定哪个版本

后续Channel接入以 **main的404d1a257722175dcd70916e3f92ec6763fa0243** 为实现参考；客服Phase 2设计参考 **a7e16aa2c89792cbb3fe49f9330848aea0b05405**。两者都在本轮通过`git ls-remote`核对过远端身份。

| 对象 | 固定提交 | 本轮怎样使用 |
|---|---|---|
| 销售worktree起点 | 03be923c0d7f8cf0f8bfa86a9f8224ba07315f17 | 保持原有起点，叠加独立销售合同及文档 |
| Channel主线 | 404d1a257722175dcd70916e3f92ec6763fa0243 | 选为后续正式询盘集成的代码参考；只通过Git对象读取 |
| 客服Phase 2 | a7e16aa2c89792cbb3fe49f9330848aea0b05405 | 复用SPEC/PLAN，区分设计与已实现功能 |
| 正式单品询盘来源 | dbf802b270bf24ab32a666f591b1aaa4086da406 | 已同时进入以上main和Phase 2，无需为RFQ再搬一次整批提交 |

main与Phase 2共同祖先为`b0015c015c7410b9b1c383ee5a83bbc160b8d5b8`，两侧各有8、9个独有提交。Phase 2不是main的超集。清单列出的6份关键询盘实现文件逐字节相同；不能由此推断两个分支全部相同。

**本轮没有merge、rebase或复制这些产品实现到销售worktree。** SG1.1开始前，须在本分支明确完成所选主线的整合并检查冲突，再编写适配器；不能因旧起点缺少文件而重复开发RFQ。原Channel和HermesInfra工作区继续保持原样。

## 官网现在哪些链路可复用

下表源码行号均对应main的404d1a25；Phase 2设计单独标注。文件完整路径、哈希和精确标记见[源码清单](SG1.0-source-inventory.json)。

| 入口 | 页面、传输与保存 | 后台、邮件及结论 |
|---|---|---|
| 首页OEM、独立OEM页 | `pages/index.astro:68` → `CTASection.astro:55`，以及`pages/oem.astro:94`，均明确给ProjectForm传`/api/admin`；`ProjectForm.astro:245`提交`submitProject`；`admin/handler.ts:1181`保存`oemProjects` | 已有后台OEMRequests及状态编辑。`:1217-1226`尝试SMTP确认后返回ID；不是可靠发送账。可复用保存、限流和上传校验 |
| 正式单品页 | `pages/products/item.astro:26` → `SkuDetailPage.tsx:38-49` → `SharedDetailPreview.tsx:88-89`；review后`CatalogQuoteSheet.tsx:244-267`调用public transport | 经`POST /api/catalog-quote-requests`、HTTP校验、事务保存`catalogQuoteRequests`。已有专用Product Inquiries列表、详情、备注和历史；保存或跟进不发邮件 |
| 产品分类内打开详情 | `headphones.astro:176` → `CatalogFamilyPage.tsx:38,55-73` → `SharedCatalogPreview.tsx:198-200` | 生产模式同样使用`submitPublicQuote`。Preview命名不表示只有开发环境能提交；只有DEV且`preview=shared`才使用local transport |
| 官网智能客服 | 当前`AssistantWidget.tsx:105-114`只提交消息和幂等键，未接Phase 2询盘预填；不可用时提供首页OEM链接 | Phase 2 `SPEC.md:29`规定仅准备、由买家确认提交。第三来源尚未实现；经普通链接填OEM表不能自动称为已识别的`website_assistant`来源 |
| 旧modal／cart／overstock | `InquiryForm.tsx:30-35`仍是600ms模拟；旧ProductDetail、InquiryCartBar引用它；`_overstock.astro`保留历史调用链 | 不能将模拟成功当真实询盘。underscore页面在源码中隐藏，线上旧CDN路径是否已清除本轮未验证。当前正式目录详情走上述新链，不能统称“产品询盘都是dummy” |

无批准详情时，`CatalogDetailController.tsx:108-109`可以回退LegacySkuDetailPage；其询盘CTA通过`OEM_INQUIRY_HREF`指向首页OEM，仍可复用现有正式表单。某条产品是否有批准详情取决于运行数据，本轮没有读取线上数据。

## 哪个时刻才能交给Sales

### OEM：不能只看项目行是否存在

`admin/handler.ts:1092-1106`先校验和限流，然后分三种附件情况：

1. 无附件：创建`oemProjects`成功即完成原业务保存；确认邮件成功与否不改变询盘保存结果。
2. storage上传：先校验完整上传凭据并取得claim；创建项目时文件仍pending，随后`:1196-1202`激活并写`ownerProjectId`、大小和校验和。激活失败时`:1206-1213`尝试删项目、标文件failed并返回错误。
3. 旧inline附件：校验解码大小，按magic bytes推导存储MIME；未知类型存为`application/octet-stream`，未采用storage分支同等的类型匹配拒绝检查。随后保存`files.data`再关联项目；没有使用storage分支相同的active/ownerProjectId元数据，不能机械套同一附件条件。

项目创建与附件激活不是一个原子操作；补偿删除本身也可能失败。因此，后续补扫既不能捡到“项目已建、附件还未激活”的中间态，也不能把回滚残留当有效询盘。单靠`createdAt`、`status=new`或`drawing`非空都不足以证明完成。SG1.2须落地可恢复的最终完成标记及分支校验；SG1.1下载接口必须验证归属。缺少归属证明的旧inline附件不能直接交给Agent，默认不追溯历史发送。

这只是源码中观察到的失败窗口，没有声称线上已经发生。OEM上传claim的防重不等于整个询盘请求已幂等；尤其无附件表单重试仍可能产生多条项目。后续需区分“同一提交重放”与“同一邮箱再次提交”，不能按邮箱简单合并。

### 单品：复用原事务和不可变产品快照

`catalog-inquiry-cloud.ts:26-73`在同一事务内完成既有请求查重、产品及批准variant检查、限流计数和询盘写入。同一个idempotencyKey及相同内容返回原requestId，改内容复用key则冲突；重复成功请求不再次占用新提交限额。原记录保留target、fields、snapshot、createdAt、version及events。

`catalog-quote.ts:37-82`校验产品发布状态及批准revision，使用服务端批准资料生成快照，超过64KiB明确拒绝。后续Sales使用该提交快照；官网产品更新后，不能用最新产品内容覆盖当时的商业依据。通知交接应接在事务成功后，不能由点击按钮、开始HTTP请求或更新后台备注触发。

已有`catalog-inquiry-cloud.test.ts`覆盖并发创建、幂等冲突、事务失败和后台版本竞争，本轮读取了这些测试，没有在此旧起点执行它们。源码使用`runTransaction`不代表本轮已验证线上SDK事务。

### 客服：仍需买家确认

Phase 2 `PLAN.md:170-173,286-289`要求由买家在表单输入联系方式并确认摘要，不附完整conversation id。当前单品提交schema严格要求productId/revision；模糊采购没有SKU时不能硬塞这个接口。OEM现有schema也没有通用confirmed summary及可信客服来源字段。

客服工作后续需补预填、买家可编辑确认摘要和服务端可识别的来源，最终复用正式保存。Sales只消费最终有效询盘，不因普通聊天、感兴趣或中途离开就创建销售任务。该公开客服能力仍归原Phase 2工作范围，SG1.0未代写其实现。

## SG0.1合同怎样接原记录

两张原表继续保留；新增适配器的接口规则如下，具体实现留到SG1.1／SG1.2：

| InquirySubmitted字段 | 依据与限制 |
|---|---|
| `client_id`、`business_line`、`source_installation_id` | 必须从服务端授权的客户连接绑定取得，不能信任访客字段或模型猜测；依赖SG0.2 |
| `source_record_id`、`source` | 原表ID加明确的来源类型。事件身份还要包含安装身份及记录种类；OEM和单品不能只按裸ID去重 |
| `source_revision` | 指固定提交资料的版本，不能直接用会随备注/状态改变的管理version或updatedAt；OEM当前没有现成提交revision，需补稳定版本依据 |
| `submitted_at`、`contact` | 原创建时间及买家填写的联系方式；保留原资料，按SG0.1便携日期／邮箱格式校验。原表能接受的值未必全部符合新合同，失败须可见并可人工处理 |
| `requirements.confirmed_summary` | 从实际已提交字段确定性整理，保留买家原意，不由模型补商务承诺；模糊客服摘要须先由买家确认 |
| `requirements.quantity` | 新合同仅接受1至1,000,000,000的整数；单品原表允许更大的安全整数字符串，可保留原串及超界原因。OEM已先执行Number转换，仅保存转换结果；历史记录可能丢精度或丢弃无效原值，adapter不能恢复原文，须隔离并人工补充。不得截断或猜数量、默默丢询盘；未来若需精确原文须在来源保存边界保留，具体降级规则随adapter验收 |
| `product_snapshot_refs`、`attachment_refs` | 服务端受控读取的固定资料引用，既不是当前产品查询结果也不是公开桶URL；OEM通常无SKU快照，数组可为空 |

原单品后台`version`与`operationId`继续保护人员编辑。查询列表按attentionRank及createdAt排序，给人查看的offset分页不能直接充当集成补扫游标。后续扫描需独立、稳定且可恢复的读取方式，并按真实SDK合同实现；本轮未添加SDK类型或方法。

## 开关与邮件切换

正式单品后端要求`CATALOG_RFQ_ENABLED === '1'`，admin与public-api都检查；详情展示另有批准内容及相关开关。`api-url.ts`由`PUBLIC_API_BASE_URL`决定API地址。Origin白名单是浏览器来源限制，不是客户授权或机器人防护。以上只证明代码条件，未验证线上开关、路由及数据。

OEM现有确认信通过`packages/email`发SMTP；无配置时明确不发，失败不撤销询盘。单品`notification='disabled'`，后台保存/跟进也不发送。Resend接入后统一确认发送路径的决定保持不变：SG4.3正式切换前仅停旧OEM询盘确认hook，固定模板通过受控发送账发一次，不影响账号类邮件。本轮保留原SMTP代码，没有接Resend或发送邮件。

## 验收记录与后续边界

- `python3 docs/sales-agent/check_source_snapshot.py`：44份文件、80处标记、7组覆盖及6份跨分支相同文件通过。
- `check_design.py --schema`：23单元无循环，71个本地文档链接有效；历史副本和受保护原稿哈希一致；1个有效询盘接受、2个无效样例拒绝。
- 用临时清单故意替换一个源码哈希，检查器返回exit 1并拒绝；未修改原源码或正式清单。原始结果见[验证回执](SG1.0-validation.json)。
- SG0.1远端验证：提交`595a48495033b538d6393def52f8c2294a4325bc`的[GitHub Actions](https://github.com/vibelingan/channel/actions/runs/39882624469)已成功。

复查时若Git对象缺失，可先获取清单中的固定提交，再运行检查器；检查器自身不会联网、发邮件或读取客户账号。关键词及哈希只能证明复核的源码身份，业务结论来自以上跨文件核对，不能把它当端到端测试。

本轮授权的SG0.1、SG1.0到此分别具备离线实现证据及源码审计证据。其余21个单元仍未实现。SG1.1依赖SG0.2客户动作授权；本轮未开始这两项，也未替其他分支解决公开客服的预填功能。最大的剩余限制是：选定源码与线上部署尚未对应，OEM最终完成标记及三来源统一事件仍待后续实现。
