# 案例页现场核对

2026-11-12，只读。**`https://supplychainsai.com/portfolio/`正常存在，没有复现截图所说的“无法完整抓取正文”。** 它是案例集合页，不是单个案例详情页。

| 实际检查 | 结果 | 能证明什么 |
|---|---|---|
| 正式HTTPS带/不带尾斜杠GET | 都200，正文摘要相同，78,688字节 | 当前入口存在，不是404或跳回首页 |
| 首次HTML | 含两个案例及各4段Situation/Task/Action/Result | 正文不是等待浏览器接口后才生成 |
| 正常浏览器 | main可读取3383字符，案例标题两项 | 当前页面可渲染和读取 |
| 禁用JavaScript，1440×900与390×844 | 都200，两项案例均未隐藏，各4段正文；无横向溢出 | 电脑和手机不靠脚本也能读案例 |
| robots与HTTP头 | `/portfolio/`未被屏蔽，无noindex响应头；HTML也未设noindex | 未发现网站主动排除抓取 |
| canonical与地图 | 正式canonical为带尾斜杠地址，sitemap-0列出该页 | 网址身份与发现入口一致 |

两个案例为 Children's Sleep Training Clock、Disc Repair System。内容来自现有网站，本次没有核实其中公司的年限、累计客户/证书数量和具体商业事实，不把可抓取当真实性审计。

截图是Google生成的一次回答，可能只选取了部分来源，也可能当时读取失败；仅凭该截图不能确定它后台哪一次抓取发生了什么。本次网页工具自身也未能打开该URL，但普通完整GET和真实浏览器均成功，所以不能把工具内部报错直接归为本站故障。没有伪装UA就声称“真实Googlebot已通过”，也没有拿本次检查声称该页已被AI完整引用。

本次不改案例页代码、不新建案例详情页、不修改公开业务文案。若再出现某个明确时间/URL的实际HTTP失败，可用对应平台抓取记录继续定位。

证据：[原始HTML压缩文件](evidence/2026-11-12/portfolio-initial.html.gz)、[入口与robots/map回执](evidence/2026-11-12/portfolio-entry-and-crawling.json)、[真实浏览器测量](evidence/2026-11-12/portfolio-browser.json)、[手机无JS截图](evidence/2026-11-12/portfolio-nojs-390.png)、[电脑无JS截图](evidence/2026-11-12/portfolio-nojs-1440.png)。
