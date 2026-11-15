# 高层设计图与验证

2026-11-12补充两张图，当前事实与目标方案分别标识：

- [当前部署分工](runtime-20261112.html)：普通访客向静态托管、public-api和Blog服务器分别请求什么；Blog经公开API读取文章和图片，不直连COS。
- [待实施图片时序](image-target-20261112.html)：受控准备现有三张图、公开引用检查、尺寸交付与撤回后拒绝。图中200是目标验收行为，不是已经上线。

两图使用各自 `*.delivery.json` 和 `*.visual-check.json` 保存最终字节与浏览器测量；本次人工看图记录另存 `review-20261112.json`。下文为11月5日旧图的历史回执，不覆盖新范围。CDN延后、发布提速已交其他工作流，旧九模块图不作为当前执行顺序。

- [模块分工与协作](next-phase.html)：九模块的边界及合作关系；连线不表示所有工作必须串行。
- [商品与 Blog 交付时序](public-content.html)：商品变化怎样更新 HTML、浏览器怎样读实时 API、文章怎样直接可读，以及搜索抓取和恢复的边界。

两张均为目标设计，不能当作线上已实现的新功能。

Archify 2.17 生成，`showcase` 检查各 9/9、0 错误、0 警告。最终 HTML 的 SHA-256 和字节数在各自 `.delivery.json`；对应 `.visual-check.json` 绑定同一 HTML，自动浏览器验证通过。1440×900、1600×1000、1920×1080、2048×1320 的视口，以及明暗主题端点均通过测量，没有页面溢出。

实际查看了最终 1440×900 明/暗截图和 2048×1320 明色截图，检查节点、连线、标签及底部说明。初版溢出已通过调整纵向间隔及去掉重复说明修正；没有裁切、隐藏溢出或缩小字体伪造通过。自动回执的 `visualReview: pending` 不改写；另记人工可视核对在 [review-receipt.json](review-receipt.json)。

源文件分别为 [architecture JSON](next-phase.architecture.json)、[sequence JSON](public-content.sequence.json)，可继续编辑后重新交付和验证。截图联系表为 [模块图](next-phase.visual-check.html)、[时序图](public-content.visual-check.html)。
