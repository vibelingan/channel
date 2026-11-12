# 04 商品搜索展示：先去掉无效标记，再适配真实报价

> 2026-11-12评审后修订。普通页面收录与带价格的商品搜索展示分别验收。本模块仍未实施。

## 当前缺口与事实

`apps/site/src/lib/seo/product-page.ts` 为商品生成不含offers的Product节点；没有真实review/aggregateRating时，不符合Google商品摘要的必要字段要求。商品正文仍可作为普通网页收录。先修无效标记，不必等完整报价适配。

新的批准来源报价有五种模式：`fixed`、`range`、`tiered`、`negotiable`、`unavailable`，来自 `packages/shared/src/catalog/offer-pricing.ts`。Alibaba来源报价向访客公开一致。这是本模块事实来源，不改pricing算法、货币计算或同步数据。

评审称“仓库没有登录专属价”不准确：`public-api/src/handler.ts` 仍有 `canSeeVipPricing`，既有测试同时验证Alibaba报价一致和旧VIP字段权限。SEO不扩展这项兼容功能；保留既有公开字段白名单与权限边界，不因评审删掉安全代码。相关源码位置及实际核验见[逐条回应R6](EXECUTION.zh-CN.md#r6-模块04没有会员价按实际报价模式处理)。

## 第一段：小范围清理无效Product

先用当前快照统计五种模式实数、报价字段完整性与缺失原因，不预判无价商品很少。无真实可用报价，也无真实评价的商品，停止输出不满足要求的富结果Product节点；保留WebPage、Breadcrumb、标题、canonical、完整正文和询盘，不加noindex、不隐藏商品。

同段更新 `lib/seo/page.ts` 及构建检查中“商品必须含Product”的断言，使普通网页模式合法。检查应继续拒绝无效Product，不能简单关闭全部schema验证。已有代码尚未提供合格Offer的有价商品，也先使用普通网页模式，等第二段完成再输出Product/Offer，避免留下另一批无效节点。

这一段只改SEO描述生成与检查，无需改数据库、请求层、CloudBase SDK或部署工具。验收用有价/无价/缺字段fixture构建，读回HTML检查正文与canonical；部署后做少量代表网址检查。无需为这类小改动创建测试云函数或重跑后台批量商品发布。

## 第二段：公开报价与页面同源

以完整批准报价、当前商品身份、币种、数量/配置条件和内容revision生成 `public-offer.ts` 的适用结果。只能挑允许公开字段，不能展开原始文档。页面、初始HTML、API及JSON-LD采用同一报价事实；不为schema另发云请求。

| 来源模式 | 处理 |
|---|---|
| fixed | 金额、币种和适用条件真实完整时输出Offer，与页面可见值一致 |
| range | 核对是否确为同一商品的有效公开报价范围；仅在Google支持的适用语义下用AggregateOffer，不混不同变体 |
| tiered | 页面显示数量阶梯；实施前核对Google当前支持的数量/价格表达。不能完整准确表达时保留普通网页模式，不取最低阶冒充所有数量报价 |
| negotiable / unavailable | 保留普通网页及询价，不捏造零元或评价 |
| 缺币种、条件不完整、错误金额 | 给可查原因，暂不输出富结果节点；不要把共享类型允许的真实零价与伪造“免费”混同 |

Google要求Product名称之外至少具备offers、review、aggregateRating中的一项；Product标记也不能保证一定展示价格。[官方规范](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)。没有业务证据时不加星级、销量或认证。

## 图片、权限和恢复

结构化数据的image与正文使用可读的公开图片入口；三张坏图仍影响对应商品，真实富结果验收依赖IMG-2修复。公开报价适配不能泄露旧VIP字段，但不因此新增会员价逻辑或重写定价。

报价真实变化仍推进既有revision与商品HTML更新，不建第二条价格队列。程序恢复继续读当前报价和内容；格式不兼容则拒绝恢复。失败可退回WebPage/Breadcrumb及完整正文，不倒退业务价格。

## 小任务与验收

| MIU | 最小结果 | 检查 | 依赖 |
|---|---|---|---|
| OFFER-1 去掉无效标记 | 统计现况；无合格报价/评价时采用普通网页模式；修改对应构建断言 | fixture生成HTML、无无效Product、正文/标题/canonical/询盘入口保留；轻量规则检查 | 不依赖public-offer或请求重构 |
| OFFER-2 真报价与平台 | 适用公开报价与可见内容一致，代表页通过真实测试 | 五模式及不完整条件；HTML/API/JSON-LD一致；若触及既有权限则用原测试验证不泄露；Rich Results Test回执 | OFFER-1、IMG-2、报价事实及Google表达核对 |

真实价格适配不是等同“消除所有红色提示”，统计与平台验证都要有日期。普通索引、富结果资格与最终展示分别报告。
