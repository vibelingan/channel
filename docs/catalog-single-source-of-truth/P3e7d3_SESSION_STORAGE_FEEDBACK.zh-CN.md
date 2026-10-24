# P3e7d3 会话存储失败的错误反馈与旧响应保护

基线c865a3ed。read getter保护已完成，但AdminApp在跳转/退出前clearSession仍可能抛错，AccountMenu退出同样可能没有反馈；AuthForm会把存储写失败当“Something went wrong”。另一个确定风险是me旧回应到达时读取当前新token，再写旧用户，账号切换会被污染。此MIU修复这些现有入口，之后再接分类发布队列。

setSession/clearSession失败给出SessionApiError/STORAGE_UNAVAILABLE及明确重试动作，不吞掉失败，不伪称持久登录或退出成功。AdminApp清除失败留在现有错误页，重试同一次退出目标；AccountMenu在现有菜单/导航提供错误提示与原按钮重试。后台preflight绑定发出时token/缓存账号，旧回应不得覆盖新会话，会话检查进行中token/账号变化重做检查并清除旧查询缓存；已进入后台后的账号切换与表单保留仍留在后续P4，不能用此局部检查冒称完成。原服务端授权不变。

先写存储getter/写删失败和正常事件控制；Chromium/WebKit真实组件+CSS依次验证后台不可读到可恢复、两种菜单退出失败重试、登录保存失败重试、延迟旧me与账号切换。浏览器的me/login HTTP仅合成对照，不能当真实云授权证明。照片/发布队列不改，旧恢复指针不删除。通过子流程后完整站点/Node20、类型/构建、精确review，再分类接线。React专用skill本机缺失，使用已读取的frontend-audit-fix、安装React19.2.6/types与[官方useEffect](https://react.dev/reference/react/useEffect)、[事件处理](https://react.dev/learn/responding-to-events)约束；不引入新React API。fullDeliveryReady=false。

补充反例：token先移除而user移除失败时，AccountMenu会转未登录分支，原Sign out按钮消失。必须仍提供Retry sign out并重试同一清除动作；不能把部分写删当原子事务或持久退出成功。登录第二个写入失败同样必须保留明确失败，不发成功事件。


## 实施与验证

setSession/clearSession把getter、第一或第二个写删失败转为明确STORAGE_UNAVAILABLE，不声称两个localStorage调用是原子事务。成功才发原auth事件；失败保留错误事实。AdminApp沿现有错误卡片保存失败原因与退出目标，重试实际清除并回到原目标；AccountMenu的菜单/导航都有提示，token先移除后user失败转未登录分支时仍提供Retry sign out。错误状态采用一个带message/retryLogout的联合类型，避免渲染依赖可变ref。

正在进行的me检查绑定开始时token/缓存账号；旧成功或401回应都不能覆盖/退出新账号，改为启动下一次检查。cleanup的active与代次配合，保持hook依赖和代码一致；不自动重启发布。此处只处理检查中的竞争，已进入后台后切换账号时的表单保留/缓存治理仍属P4，未冒称全链路已完成。安装React19.2.6/types与实际TanStack Query5.101.0源码已核对，使用的clear/订阅原本就存在；未新增CloudBase SDK表面。

30新增检查＝8个Node控制、20个实际UI子流程和2个浏览器父项。首轮18项2过16败；初修全绿后，部分退出新增控制发现未登录分支丢重试按钮，24项18过6败（含2父项），补入口后通过。之后扩大到后台自身两种退出、旧401回应等30项全绿。两浏览器覆盖恢复到login/home的正确目标、完整/部分清除、两种菜单、登录保存失败重试与账号A/B延迟回应。HTTP仅合成me/login/空Users列表/能力响应，不能冒称真实云授权或发布验收。注入脚本只在fixture入口执行，避免目标页重新注入身份或故障；原型/描述符及上下文均恢复清理。

10种顺序故障在第二轮全部检出，29重叠失败、3生产文件SHA恢复。首轮第10项等待缺失按钮触发55秒看门狗，只有前9项有效检出，没有计通过；首轮stdout未由旧harness写入，保留工具异常摘要并明确缺口。随后给按钮增加可见性断言，并让harness保留今后超时stdout，30控制重过后最终10项检出。没有用延长等待掩盖缺入口。

最终site1105/Node20客户端284、站点/E2E/既有测试类型、6Biome/15页构建通过，无失败/跳过。相关证据6388含未变包，完整Node203349仍5024700b、657SDK和14精确后端进程仍9efd824c。本步没有更改服务端授权、真实账号、目录/分类或云资源。

保存16张合成账号UI截图到唯一session-feedback-ui-r4目录，并记录SHA；实际视觉审阅chromium-1（1280后台错误卡片）及webkit-5（390部分退出后未登录分支），文字与重试按钮可见、沿用原组件样式。未把独立AccountMenu夹具当整站Header验收。实际review/simplify/humanizer核对6代码/测试、原会话调用者/React effect、官方文档和本文/实施记录，将“整个账号切换修复”限定为“正在检查的旧回应保护”，将“存储两项原子成功”改成“部分失败明确报告并可重试”。

原分类UI、P4其他角色/编辑组合、P5、旧JSON80原因及真实test选品/恢复门槛开放，fullDeliveryReady=false。接着接分类发布入口，不bless/部署。
