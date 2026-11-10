# 分支整合与本轮核对

2026-11-10。本轮新增产品代码只有小署名／来源展示的位置调整；其余代码来自既有分支。Hermes合并引起的通知导入作用域冲突已修正：`configured_notifications` 放回使用它的 `configured_service()`，没有新增任务行为或重启线上服务。

## 已有工作收拢

- Channel：已有 `release/assistant-seo-20261104` 先快进包含线上热修的 `origin/test@f3a4de9a`，再合入 `fix/assistant-feedback-20261109@e2af36a1`、`fix/sales-live-wiring-20261108@6b1b6bc0`、`docs/apollo-integration-20261106@d8abd1d8`。`feat/sales-assistant`、UI foundation和progressive-delivery的远端提交已在这条分支历史内，没有再复制一份实现。当前工作目录仅包含本轮已列文件。
- Hermes：已有 `feat/apollo-prospecting-flow-20261109@97b492d` 合入 `fix/sales-deployment-20261108@c14a44f`，以及 `feat/apollo-readonly-20261106@1422083`。旧只读分支的三项add/add冲突保留较新客户端、测试和guard，历史说明和CI保留；新版本已有旧版有界只读能力并增加错误原因、可用查询路由和字段。
- 旧分支保留、不强推或删除。主仓库、SEO后续、其他客户和共享Hub20项未提交未纳入。其他评审Agent使用同一交付分支。
- 已有UI／Sales工作流增加本次统一分支触发，不增加部署触发器。周一10点只读待办提醒仍使用原自动化 `ai`，更新读取统一分支，没有新增重复提醒。

## 本地与只读检查

| 检查 | 本轮结果 | 具体范围 |
|---|---|---|
| 官网UI浏览器 | 110通过 | 桌面／手机，旧版final-only、新版状态／恢复、现有交互；模拟接口，不是线上KB修复验收 |
| 官网相关单元 | 55通过 | 聊天组件、状态、公开链接、组件挂载；无数据库／模型 |
| 网站类型 | Astro 0 errors／0 warnings，12 hints | 合并后实际源码；另有测试和浏览器规格类型检查通过 |
| Sales协议 | 67通过 | 客户／任务／来源／审批等已有合同 |
| Channel资料接口 | 131通过，类型检查通过 | 业务资料与落盘逻辑；不当成腾讯真实入口／运行凭据通过 |
| 合并的函数打包配置 | 19通过 | 已启用Sales产物的环境隔离、manifest和默认开关 |
| Python完整回归 | 472项中333通过、139因外部数据库等条件跳过 | 复用现有用例；真实MySQL在远端既有CI验收，未启动本机OrbStack |
| Python静态与Apollo缺陷注入 | pyflakes通过，5项guard缺陷被对应断言抓到 | 合并后较新实现；不调用真实Apollo |
| Archify图 | 5份源规格每份9项检查通过 | 复用已交付HTML，完整标签；既有四桌面尺寸浏览器检查，核对复制后的内容一致，再实际打开看图 |
| 真知识与模型 | 文档285可检索但未获公开范围；一次真实追问无knowledge_search、citations为空 | 用生产同款模型和公开KB范围，只读诊断；没有历史请求号，见FINDINGS |
| 线上服务 | 只读确认Hub版本／端口／20项未提交，CloudBase函数与AI配置 | 没有部署、重启或启用自动消费 |

## 复核时抓到并处理的事项

- 合并后静态检查和11项失败配置／TLS用例发现通知工厂被导入了错误函数作用域；移回使用处后，失败用例与完整回归重新通过。不是把旧部署重启去碰运气。
- 一次Sales测试命令筛选名没有匹配项目，已按实际包名 `fn-sales-integration` 重跑，只有131项实际执行结果计入上表。
- 旧的连续输出设计把源码写成stream:false，复查后更正为引擎已开流、Worker仍完整检查后发布。
- 自动审批拒绝过整份覆盖锁文件的命令。核对新工作区安装前的干净状态和实际diff后，只撤回本次pnpm新增的两行空importer；未动其他工作区的锁文件。
- 常规拒答没有来源时应保留输入框，已列修复设计；本轮未用取消依据检查来让问答看起来成功。

远端SHA与CI以最终交付回复和相应GitHub Actions运行链接为准。测试通过、推分支和正式发布分别报告；此表不宣称完整官网→Hermes→Resend生产验收通过。

远端检查：产品代码与主设计提交 `f332fd4decfc00260771fc99be2b997daab3b23d` 已推Channel；[UI检查](https://github.com/vibelingan/channel/actions/runs/42759645810)和[Sales合同](https://github.com/vibelingan/channel/actions/runs/42759646029)按该SHA核对。Hermes `bc18dffc51ed0fafb11aa0b7bd3ce23eaee402f7` 已推，[Apollo含真实MySQL检查](https://github.com/vibelingan/hermesinfra/actions/runs/42759641178)成功；[Sales运行检查](https://github.com/vibelingan/hermesinfra/actions/runs/42759641195)按该SHA核对。后续客服事实更新是文档变化，不改已经测试的产品代码；最终结果以交付回复注明的状态为准。

最终读回：上述四项GitHub Actions均成功。Channel产品代码SHA为f332fd4d（UI、Sales合同）；Hermes为bc18dff（Apollo、Sales runtime，含真实MySQL及既有容器边界验收）。Channel客服事实追加后的453af1e4只改文档，没有重跑相同产品测试，也没有把旧SHA的结果改写成另一SHA的CI结果。

## 晚间Fable公开工作区实现复核（独立于上面的CI）

按FINDINGS§J固定三个新分支SHA，fetch后以隔离快照运行：VibeKB原19项通过、Hermes新9项通过、Channel知识引擎25项／工厂2项／部署manifest23项通过，知识引擎类型通过。完整聊天规格类型检查失败，与远端Assistant chat integration的两处TS2353一致。Channel该提交的常规CI和Browser regression成功，Hermes regression成功；VibeKB分支未找到远端运行。不能因此称三仓全绿。

新增两个针对性复现均在原实现失败：向量结果补取正文的工作区竞态、门户public状态被名称推导覆盖。仅在临时源码拷贝修正第一处SQL后，竞态复现及原19项均通过；未修改Fable分支或线上服务。一次独立保护脚本因缺隔离DATABASE_URL而停止，未记通过；没有为它启动OrbStack或使用生产库。

服务器只读检查与局部／完整三方合并检查发现运行源码漂移；没有重启KB、Hub或任何现有Agent，没有移动公开资料。已准备一把未激活Key和Claude交接。源程序最初不支持KB_PUBLIC_KEYS，直接增加环境变量不等于配置生效。

跨项目公共包方案更新主稿§5并补Archify图。最终9项产物检查通过；实际浏览器四种桌面尺寸及浅深主题检查无溢出，实际查看1440和2048截图，未遮字。首次候选过长后合并重复的资料方框并保留文字含义，没有通过隐藏内容或缩字伪造通过。
