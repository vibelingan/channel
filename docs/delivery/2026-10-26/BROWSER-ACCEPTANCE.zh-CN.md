# 商品页验收误报：原因与修正

## 现场发生了什么

7a965c1 的完整远端 CI 40238806978、文章 HTTP 40238806974、原 Blog 40238806976 都成功。恢复点准备 40239656638 第 2 次成功，登记 site-40239656638-2，网站文件写入数为 0。

真实静态发布 40240318908 使用 509 个公开商品构建，509 个都有结构化详情，0 个走旧格式。浏览器已确认关闭 JavaScript 时有正文、独立 canonical、可收录设置和 Product 数据，随后在读取浏览器刷新请求正文时失败：`Network.getResponseBody: No data found for resource with given identifier`。

自动恢复实际完成，结果为 restored，恢复版本 site-40240318908-1-restore，验收时间 2026-10-25T23:09:46.831Z。函数与业务数据未回退。恢复后实际发布记录的 currentRunId、dirtyRunId、lease 和 unresolvedOperation 均为空。恢复约 16 分钟，目前没有达到期望速度，不能把 restored 写成发布成功。

## 怎样查清

在本地 HTTPS 中运行刚才归档的实际候选页面，浏览器保持客户域名作为 Origin；API 仍直接请求真实 CloudBase，没有代理或替换接口响应。观察到 200 后 requestfailed / ERR_ABORTED 与同样的正文读取异常；另两次请求成功。来自客户域名的真实 API CORS 正确。本地测试域名未在 CORS 白名单，因此没有用关闭浏览器安全策略来掩盖它。

另做完全独立的最小实验：本地 HTTP 服务只返回分两段发送的 11 字节 JSON，不含 React、CloudBase、AbortController、请求拦截或业务代码。实际版本 Playwright 1.61.1 / Chromium 149.0.7827.55。

| 组合 | 页面是否读全并解析成功 | Playwright 能否再次取得正文 |
| --- | --- | --- |
| no-store + stream，重复 3 次 | 全部成功 | 全部报相同 CDP 错误 |
| no-store + response.json，对照 3 次 | 全部成功 | 全部成功 |
| no-cache + stream，对照 3 次 | 全部成功 | 全部成功 |

机器结果见 [实验记录](evidence/browser-stream-observer.json)。[Playwright 的同类报告](https://github.com/microsoft/playwright/issues/42742)描述了更新版本上的相同行为，但上游最终修复和内部根因尚未确认。这里确认的是当前版本可独立复现的观察差异，不能泛化成所有取消都可以忽略。

## 验收怎样改

保留商品的 no-store、完整流读取、字节上限、解码校验和旧请求取消。页面增加不改变外观的诊断属性，区分快照、请求中、失败与最新数据已应用；只有真实请求通过已有解码器和状态处理后，才能成为 fresh。只收到 200 或只看到原快照都不能通过。

真实验收先读取当前公开 API 作为比较值，再要求浏览器确实发起同一商品请求，等待页面 fresh，并核对已应用的商品 ID、revision 和显示名称。继续操作图库、变体和询盘弹窗，不提交真实询盘。服务端和浏览器两条证据共同检查，避免依赖 CDP 对已消费流的第二次读取。

失败时保留公开页面截图、测试错误及 API 请求路径/状态，不保留身份凭证、请求头或客户后台会话。失败仍使发布不被接受；恢复规则没有放宽。离线状态用例确保快照、未完成请求和失败请求都不能误报 fresh。

修正后用509商品实际快照重新构建：526份HTML、517个可收录canonical检查通过。候选页面连接真实只读API重复3轮，全部实际应用最新revision，并操作图库、变体和询盘弹窗；其中1轮CDP仍报ERR_ABORTED，但页面已完整应用当前数据。结果见[本地实际API验证](evidence/product-refresh-local.json)。这仍是本地候选验证，不能代替线上重新发布后的验收。
