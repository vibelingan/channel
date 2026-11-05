# 本轮证据怎么读

全部是2026-11-05的只读核查；只有25号记录涉及向Google尝试申请重抓，明确失败，没有成功提交。没有部署网站、修改商品/文章或改权限。

| 文件组 | 说明 |
|---|---|
| 01～04 | 页面索引旧汇总及三类历史原因；清单里7个网址全部枚举 |
| url-ai-gadgets / electronics-toys / misc / oem / toys | 五个历史未收录页的Google单页检查 |
| url-page-one / bluetooth-parameters | 两个参数网址，Google选择正式耳机页 |
| url-product、23-product-snippet-error | 代表商品已索引，但Product摘要缺报价/评论/评分 |
| url-blog-* | Blog列表及两篇公开文章的历史索引状态 |
| 24 / 26 / 27 | OEM、旧noindex文章、Toys的Google实时测试，均允许收录；不等于已入索引 |
| 25 | OEM申请重抓失败，Google提示reCAPTCHA服务无法连接，未重复提交 |
| 05 / 06 | 视频未索引的具体原因和首页视频地址 |
| 07 / 29 | 地图列表、子地图读取日期、Success及发现数量 |
| 08～10 | CWV样本不足、HTTPS及面包屑报告 |
| 11 / 19～22 | 搜索词、页面、国家、设备与Google AI报告；窗口和计数范围分别记录 |
| 12 / 13 / 18 | 人工处罚、安全及临时移除报告 |
| 14～17 | 设置、抓取统计、图片4xx和链接报告 |
| 28 | 404样例是favicon.ico，不是商品页 |
| property-scope.json | 当前本站URL前缀属性；未保存其他项目的属性信息 |
| public-audit.json / robots.txt | 当前540个地图网址清单与代表页初始HTTP HTML检查 |
| image-errors*.json | 三个真实图片地址仍400，三条错误均为函数6MB响应上限 |
| image-route-comparison.json | 另一张图片在服务域名可读；主域一次读取超时，不能外推所有图片都坏 |
| entry-and-icon.json | 主域HTTP200、www301且保留路径查询串、favicon.ico404与SVG200 |

文本记录隐去了账户邮箱。页面上第三方浏览器扩展的浮层文字不是网站或Google报告内容，不作为结论。早期保存过程中识别出的错名截图已移除并从固定核查标签补采；没有将它们当成专项结果。

HTTP耗时是本次网络完整读取耗时，**不是**同条件性能基准。性能仍引用11月4日美国及本机原始基准；本轮没有优化后数值。图文中的图片属性检查不等于每张图的文件都已经下载成功；另行对错误图片做了真实GET。

`SHA256SUMS`覆盖本目录和整套本轮产物（清单自身除外），便于后续会话核对文件。Archify目录另有固定产物收据、四种桌面尺寸的容纳检查及大小桌面截图；自动检查与人工看图分别记录。

## 复现公开HTTP抽样

在仓库根目录，用Node22运行：

```sh
node docs/seo/continuation/audit-2026-11-05/reproduce-public-http.mjs /tmp/channel-seo-audit-new
```

需要提供新的输出目录，脚本拒绝覆盖已有public-audit.json。它仅允许本站origin、GET、最多三个并发，每次25秒/4MiB上限，沿地图选代表商品；不会写网站、登录或调用管理API。执行日期不同，结果自然可能变化；保留新目录，不覆盖本轮原件。Google账户内的检查仍需合法登录，不能用这个脚本冒充Google索引数据。
