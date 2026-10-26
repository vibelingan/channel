# 发到内容助手群里的测试任务

下面这段可直接发送。发送前应由服务器操作人完成 GUIDE 的接线和工具发现检查；本地 Hermes 跑通不能代替这一步。

> 请帮我写一篇发到 supplychainsai.com Blog 的英文文章草稿，主题是“How to prepare a clear OEM headphone enquiry”。读者是第一次向工厂询价的海外采购，400–600 词，简洁实用，包含：用途和目标用户、连接方式、预计数量、样品确认、包装和交期信息。不要编造我们公司的产能、价格、证书或客户案例。
>
> 给出 SEO 标题、简介、作者 Diversity Technology Limited，以及 slug `oem-headphone-enquiry-wecom-20261026`。正文用 H2、小段落和清单，不用 H1、HTML、Markdown 图片或表格。
>
> 我想配两张图：① 耳机、包装盒、笔记本组成的简洁采购准备场景，不出现品牌和虚构认证；② 六项询价准备清单的简洁信息图。先提供英文生成提示词、建议放置位置和准确 alt；如果你已有图片生成能力，可以另给我图片文件，正文仍不嵌入图片链接。
>
> 创作完成后，请按现有协作方式交给发布小助手。发布小助手只调用网站“保存草稿”工具，使用 `externalTaskId=wecom-oem-enquiry-20261026`、`idempotencyKey=wecom-oem-enquiry-20261026-v1`。保存失败重试不得换号或改正文。保存成功再查一次结果，把真实后台编辑链接给我。不要直接公开，不要调用其他平台发布。
>
> 如果当前找不到网站草稿工具，请明确说“网站草稿工具尚未配置”，不要把微信群里发出正文当成已保存到网站。

同一篇草稿重试必须保留这两个编号。如果你已经人工编辑过，不要求助手重新投递改写正文；直接在网站后台继续编辑。开始另一篇文章时，再使用新的任务编号。

## 配图提示词示例

1. `Editorial still life for an OEM headphone purchasing guide: unbranded over-ear headphones, a plain kraft packaging box, a notebook with blank pages and a pen on a light desk, soft natural daylight, clean neutral palette, no logos, no certificates, no readable text, 16:9.`
   - 建议放在开头第二段之后。
   - 生成后按实际画面填写 alt，例如：`Unbranded headphones, a plain box and a notebook on a desk`。
2. `A clean six-step infographic for preparing a headphone OEM enquiry, using simple line icons for audience, connection type, quantity, sample, packaging, and delivery; generous white space, teal accent, no company logos or certification badges. Avoid small readable text; labels will be added separately.`
   - 建议放在文章结尾的检查清单之前。
   - 根据最后实际生成的图调整 alt，不能只写“SEO image”。

当前接口保存文字草稿，不接收或下载任意图片 URL。人拿到图片文件后，在后台上传、填写 alt、预览，再决定发布。图片自动导入需要另做受限上传接口，不能把网站管理员账号交给助手绕过去。
