# 本轮工作记录

2026-10-26。实际工作目录为原 SEO Git 工作树的可读源文件镜像，仍绑定原 Git dir 和 `feat/seo-foundation`；没有创建分支或 worktree。默认 channel 目录有别人的未提交改动，保持不动。

实际阅读：humanizer/SKILL.md 和 plain-technical-writing.md、deepen-task/SKILL.md、CloudBase 与 CloudRun/Web/code-review 参考、TypeScript 规范、Engineering Craft、SDK 验证门禁、现有文章发布/存储/HTTP/页面/编辑器、HermesInfra AGENTS、内容助手配置与工具扩展说明。Context7 不可用；用官方 Astro6 / Node、Vite、Google 搜索文档，CloudBase 知识库和安装包运行测试核对。

表达修正：把“提交公开投影后由页面服务按需交付”改为“管理员确认某个保存版本公开，访客打开网址时收到包含正文的 HTML”。保留谁发布、何时生效和故障状态的条件。核对过：文章内容更新不需要 GitHub 构建，程序更新仍需构建；本地 SDK 测试不是真实云端验收；既有数据库结构可继续读取，发布检查没有放宽。

已完成并运行的新行为：直接发布事务、更新/撤回与去重、旧队列切换保护、只读公开文章/API、发布引用保护的图片字节、独立 Astro Node 服务、实际 HTTP 故障状态、动态 sitemap、现有页面样式、独立部署包。新增远端 CI 只做离线检查和产物保存，没有云端写入。

发现并修复的验证问题：独立配置起初未启用共享导航需要的 React renderer；独立运行时缺少根静态托管的品牌图标；下划线开头的 Astro 健康文件不会成为路由。分别补足真实 renderer、测试网关的原静态资源读取和可访问的 health.json 路由。没有删掉断言或拦截请求把失败改成成功。

按 simplify 复核，复用原七个集合和既有 PublishedArticle 格式，抽出同一份公开版本计算逻辑供静态验收和直接发布共用。没有另造第二套 CMS、文章数据库或 SDK 声明。旧静态方式为默认关闭切换，保护现有部署，待正式接线完成后再决定是否移除旧文章 worker。

本地回归：文章66项、DB2468项、public-api原182项与新增HTTP边界2项通过；site完整检查1472项中1471通过、1项原有跳过，新增静态/动态sitemap门禁另做定向8项通过。脚本最终1147项通过，SDK合同检查、各相关类型检查通过。全量脚本初轮两项失败分别是新增索引数量的旧期望、真实admin入口新增模式校验导入的旧测试桩；补充精确索引断言和实际模式schema的static/server/typo执行验证后全量通过，没有删掉用例。并发测试的临时构建产物曾被lint扫描；待测试自行清理后重跑，不把生成代码格式化成源码。

独立文章服务在项目外、无 node_modules 的目录启动，通过实际 HTTP 与 Chromium 页面操作。已有静态构建也用两件本地商品fixture和 `BLOG_SERVER_ENABLED=1` 完成，逐页SEO检查、商品初始正文和sitemap-index通过；未用fixture冒充线上商品全量。截图见 evidence。图按实际代码更新：页面服务调用只读API，服务器不持数据库密钥；图上仍明确真实接线未验收。

Archify 图完成9项产物检查与四种桌面尺寸的浏览器检查。实际查看2048×1320浅色截图时发现冗余分段标题被参与者框遮挡，移除重复分段，保留全部十次调用及“无须GitHub构建”的文字含义后重新交付和检查。浏览器回执仍标注visualReview=pending，图像审阅单独记录，不篡改机器回执。

第一段代码已推送原分支，提交6cf3f14bf15cde8479fdb1fc00ff2e864df8d9ba。远端三项均成功：完整SEO回归40219023674、原Blog检查40219023869、新文章服务HTTP检查40219023794。随后准备下一段受控入口，并补上产物网站域名、运行版本读回、临时服务禁止收录、原共享队列和精确函数恢复范围。6cf3f14b 的旧CI产物默认网站域名为localhost，只用于验收；后续实际部署仅接受带正确网站域名的新版CI产物。

额外只读核对：HermesInfra为ff066b1，本机实际Hermes运行库为590d547。跨仓库运行git或Hermes命令时须清除Channel源镜像的GIT_DIR/GIT_WORK_TREE，避免版本显示串到Channel；未改其生产配置或工作目录文件。

受控接线入口的本地检查：完整脚本1155项通过，文章服务生产/预览两种响应模式通过，HTTP检查禁止自动跟随重定向，确认正文、health.json与sitemap.xml直接返回预期状态。相关类型检查和全仓lint通过。函数代码替换复用旧逻辑并限制在admin/public-api两者，新增public-api恢复范围及其他函数拒绝用例；旧人工入口的所有mode仍只选择一个job，共享锁未改变。还未执行新入口或写入CloudBase。
