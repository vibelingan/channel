# 公开联系方式更新（2026-11-17）

用户指定电话 +852 9545 3560、邮箱 sales@supplychainsai.com，要求官网新开 feature 分支，并直接更新小助手 diversity-public 公开知识库。

## 已完成

- 分支 feat/update-public-contact-20261117，从 origin/main 66c915dc67c5a6f7b5edcece316e1f1cabe44864 创建；本工作区原为干净 detached a298f1ef，其他工作区未改动。
- 官网仅两份源码变化：i18n/content/en-US.md 的页脚文字和 tel:+85295453560；layouts/BaseLayout.astro 的 Organization.contactPoint.telephone。邮箱原本正确，隐私页与两个结构化邮箱均保留 sales@supplychainsai.com。沿用现有 SiteFooter，不新增不必要的联系方式区域。
- 真实 VibeKB MCP list_workspaces 确认 diversity-public 为公开工作区6，5篇资料。旧兼容工作区 supplychainsai-public-prod /4不是当前小助手的目标，未修改；旧运行文档中的 workspace2也不能当现状。
- 通过现有 MCP update_document 更新298公司简介、289销售规则下半、287客户FAQ、286客户筛选资料，只改正文联系方式；288不变。298新增中英联系信息，另外3篇在原有正确邮箱旁新增电话。改前这5篇均无电话号码。
- 更新前5篇全文保存在原知识库主机 $HOME/.local/state/channel-contact-20261117/public-before.json（仅所有者可读）；凭据由原主机加载，不复制到本机。未改服务配置、模型、工作区或标签，无重启和群/邮件发送。
- 通过真实 https://kb.supplychainsai.com/mcp 的 diversity-public 只读 key 重新读取全部5篇，服务名 knowledge-base-public、工作区6；4篇正文与预定内容完全相等，288正文未变，无旧电话。按新电话号码检索返回298、287、289、286等记录。服务端 receipt.json 保存摘要、更新时间和读回证据。

## 验证

- 网站现有全套测试：1599项，1598通过、0失败、1既有跳过，211.7秒。
- Astro类型检查：322文件，0错误、0警告、12提示。
- 本地两件合成商品夹具构建：20个HTML、11个可收录地址、sitemap与验证文件全部通过；合成产物不用于正式发布。
- 真浏览器桌面1440与手机390：新电话号码与mailto链接正确、电话链接可键盘聚焦、无横向溢出；结构化公司信息电话正确。截图 output/contact-20261117-{desktop,mobile}.png 已实际查看。
- 预览用静态HTTP服务器没有 /api/catalog-taxonomy 后端，因此4个分类请求404；此预览只证明联系信息的渲染与链接，不宣称分类API已验收。
- 第一次手机截图因滚动后绘制尚未完成为空白；等待实际绘制后重新截图并查看通过。没有用空白图充当验收。
- pnpm自动加入的空 importer 已恢复，未改锁文件或依赖。

## 表达与范围核对

实际阅读：humanizer/SKILL.md、plain-technical-writing.md、technical-explanation.zh-CN.md、TypeScript规范、simplify、公开页面SEO合同、BaseLayout、SiteFooter、联系邮箱测试、真实聊天接线说明、知识库现有update/get/list工具声明及已安装服务源码。项目 .agents/skills 目录不存在；沿用现有检查，不声称执行了缺失adapter。本轮没有UI改版或图像设计，不涉及SDK改造、媒体、调度或跨后台授权设计。

具体措辞修正：“知识库已接通”改为“通过小助手的HTTPS只读入口读回5篇公开文档，新电话可以检索到”，分别说明实际读取结果和服务范围。

## 发布边界

官网源码在新feature分支，尚未合并/发布。检查时现有test分支另一轮Deploy Test 44041810162正在运行；本轮不覆盖该发布来源或改动其他工作流。知识库修改已生效，不需要部署网站或重启小助手。

## 真实问答与CI续作

官网小助手真实会话42b7c86f-5d9d-4dab-8a87-845f7f0057e1：普通问法“最新的联系电话和联系邮箱”得到团队确认的兜底答复；明确要求查公司公开资料后，回答正确的 +852 9545 3560 和 sales@supplychainsai.com，并有来源入口。截图 output/contact-20261117-assistant-live.png 已查看。不能把这一成功样例表述成所有自然问法都稳定通过，未扩大修改助手意图路由。

首轮远端CI 44046117817：网站两组测试在实际运行前因 core limit unlimited 与脚本假设不符失败；其余AI库、构建、packages、scripts、services均通过。精确复用现站test已有修复05823f8c（本分支094b4c07），配套16项部署门禁测试通过，不放宽任何业务断言。

首轮浏览器回归44046117816的WebKit启动失败：运行机已变为ubuntu26.04，却从仅按Linux和锁文件命名的缓存恢复了依赖libicudata.so.74的旧系统浏览器；系统现有libicu78。将两个使用缓存的浏览器任务固定为ubuntu-24.04，并在缓存键加入架构与ubuntu24.04，隔离系统版本。没有升级Playwright或跳过WebKit。修复后需用新精确提交重新跑远端检查。

官网PR #92：https://github.com/vibelingan/channel/pull/92。现有其他发布44041810162已成功；尚未改动其test分支。已向用户确认本次新feature是否一并合并上线，等待明确选择。
