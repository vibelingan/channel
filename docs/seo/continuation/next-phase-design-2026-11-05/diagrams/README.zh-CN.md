# 高层设计图与验证

- [模块分工与协作](next-phase.html)：九模块的边界及合作关系；连线不表示所有工作必须串行。
- [商品与 Blog 交付时序](public-content.html)：商品变化怎样更新 HTML、浏览器怎样读实时 API、文章怎样直接可读，以及搜索抓取和恢复的边界。

两张均为目标设计，不能当作线上已实现的新功能。

Archify 2.17 生成，`showcase` 检查各 9/9、0 错误、0 警告。最终 HTML 的 SHA-256 和字节数在各自 `.delivery.json`；对应 `.visual-check.json` 绑定同一 HTML，自动浏览器验证通过。1440×900、1600×1000、1920×1080、2048×1320 的视口，以及明暗主题端点均通过测量，没有页面溢出。

实际查看了最终 1440×900 明/暗截图和 2048×1320 明色截图，检查节点、连线、标签及底部说明。初版溢出已通过调整纵向间隔及去掉重复说明修正；没有裁切、隐藏溢出或缩小字体伪造通过。自动回执的 `visualReview: pending` 不改写；另记人工可视核对在 [review-receipt.json](review-receipt.json)。

源文件分别为 [architecture JSON](next-phase.architecture.json)、[sequence JSON](public-content.sequence.json)，可继续编辑后重新交付和验证。截图联系表为 [模块图](next-phase.visual-check.html)、[时序图](public-content.visual-check.html)。
