# 官网助手：提问和停止的前后端闭环

2026-10-30。分支 `feat/website-assistant-ui-foundation`，代码 `75681301`。本轮从独立设计推进到实际组件 → HTTP adapter → BFF → PostgreSQL → 原 worker／ConversationEngine 的整段流程。新增功能用 `PUBLIC_AI_CHAT_V2=1` 显式启用；默认网站仍保留原 Widget。未部署，未发真实邮件。

## 按原模块号看本轮交付

| 原模块 | 这次已实现的部分 |
| --- | --- |
| MIU 5f | `/api/ai/v2` 和运行身份 envelope，严格解码，v1 保留；相同提交换正文拒绝 |
| MIU 6b | 同一次请求重试返回同一运行；v2 一次只处理一条问题，新并发问题拒绝，不悄悄排成另一项任务 |
| MIU 6c／5d | 停止绑定提交 key、runId、版本，在事务中核对；重复停止只登记一次，旧操作不误停新回答 |
| MIU 7 | 按 run 投影已提交 SSE，重连保留 cursor；持续验证会话授权，不从其他运行拼接内容 |
| MIU 11c | 原组件接 HTTP adapter；发送、停止、错误、过期、同 key 恢复和取消与完成竞争都走现有状态层 |
| worker | 供应商没有输出时也定期检查数据库控制状态，及时中断本地读取；保留来源核验和发布门禁 |

这里完成的是这些模块中支撑“提问到停止”的部分。产品工具、正式询盘保存、其他协议能力仍未全部完成，不把整个 MIU 5f 或 11 标为全部验收。

## 用户实际怎么操作

提问 → 网站保留本次提交身份 → 后台创建／找回该提交 → worker 用原引擎执行 → 来源核验通过后展示结果 → 继续问下一条。

停止 → 同 key 核对原提交 → 对它的 runId 和控制版本请求取消 → 后台关闭旧版本写入权限 → worker 中断读取并记录终态 → 网站显示已停止。取消受理不是已停止；未确认时显示待核对。供应商服务器的计算和计费是否立刻结束，仍取决于引擎能力，不能从本地断开 HTTP 推断。

断网、丢失受理回执 → 用同一个提交 key 和原正文重试 → 找回同一任务和 cursor。该流程不是恢复以前的聊天历史。

历史恢复先保留设计，不接后台：重新打开助手 → 验证原浏览器会话凭据 → 读取以前的消息 → 显示并继续问；凭据失效则新建会话。真实接线页面隐藏了历史和正式询盘按钮，避免点击尚未接好的能力。

## 真实服务和真实模型的区别

BFF、SQL 事务、worker、SSE 和浏览器是真的。联调页使用确定性测试引擎，明确标识，不代表真实 AI 的理解和回答质量。生产路径继续复用已有 AnythingLLM-compatible ConversationEngine，未换供应商，也没有打开原来被禁止的工具。

当前进程未配置 `PUBLIC_AI_API_BASE_URL`、`KB_BASE_URL`、`KB_API_KEY` 或真实 engine 选择；只检查了是否存在，没有读取或复制其他工作树的密钥。这轮没有做真实模型实测。后续在受控环境补上现有知识库／模型运行配置，再验收真实模型与产品查询；客户 Resend Key 是邮件连接凭据，不是聊天模型的凭据。

来源核验仍发生在输出发布前，因此页面等待期间给状态，不能把“后端使用 SSE”描述为“未经核验的模型 token 逐字直接显示”。

## 实际验证

- 11 项 BFF、27 项 worker、38 项 store 回归，共 76 项，使用独立本地 PostgreSQL，全部通过且无跳过。
- 2 项协议解码测试、21 项前端定向测试通过；各包类型及浏览器／联调脚本类型通过。
- 8 项实际前后端浏览器检查通过：桌面和 Chromium 手机尺寸各覆盖连续提问、静默生成时停止并继续、单次失败后继续、真实 POST 回执丢失后用原提交恢复。
- 原 90 项界面浏览器检查通过，保留设计预览和旧交互。
- 4 个既有状态突变加 3 个新增边界突变，最终 7／7 被测试抓到，原文件没有被修改。新增边界是取消版本、客户端 run 身份、服务端 SSE run 筛选。
- Astro 构建 18 页面通过；扫描构建文件，开发预览未发布；三个原允许路由和一个禁止路由的构建后浏览器检查通过。
- 28 个相关源码／脚本定向 Biome 和 diff 空白检查通过。没有增加依赖或数据库迁移。

缺陷注入第一次发现两个真实测试盲点。只测活跃运行时，取消版本突变会被另一个检查挡住；补“已取消运行的错误版本也拒绝”后才抓到。只检查 SSE envelope 身份也不够，因为错误的旧事件可能被套上正确 envelope；补“事件序号必须属于目标 run 的真实记录”后才抓到。最终结果并非第一次就全部有效。

本地原始证据在 `output/assistant-chat/`、`output/assistant-ui/`；远端对应 CI artifact 保留同类证据。本轮证据摘要见 [CHAT-SLICE-VERIFICATION.json](CHAT-SLICE-VERIFICATION.json)。远端 [Assistant chat integration](https://github.com/vibelingan/channel/actions/runs/40985051756) 和 [Assistant UI foundation](https://github.com/vibelingan/channel/actions/runs/40985051585) 均通过，检查的可执行代码均为 `7568130153a85c3f874096f1984f6033332703da`。

## 本机体验与复现

本轮已重启联调服务并实际测试：`http://127.0.0.1:62058/assistant-chat.html`。原 `assistant-preview.html` 继续是 29 状态模拟展示。localhost 链接只适用于运行服务的这台 Mac。

复现服务需要独立本地测试库，不能填写生产数据库。先由管理员准备本地 PostgreSQL，再运行：

```sh
CHAT_TEST_DATABASE_URL=postgres://chat_test@127.0.0.1:62381/chat_browser pnpm --filter @vibelingan-channel/ai-worker exec tsx ../../scripts/assistant-chat-local.ts
pnpm --filter @vibelingan-channel/site dev:assistant-preview --port 62058
```

`slow` 可测试静默等待时停止，`fail` 可测试失败后再问。测试引擎对其他问题给固定验收文案。服务端只监听本机；不配置邮件或正式询盘。

## 复核与下一步

两轮自审分别核对系统权限／事务与 UI／异步接线；没有派发子 agent。核对了 server、store、worker、wire decoder、HTTP adapter、hook、旧 Widget 开关、联调启动器和 CI 的每个连接点。措辞把“新的 AI chat 已打通”改成“前后端链路已打通，真实模型效果未实测”，避免混淆测试引擎与真实模型。

下一条完整业务流程是原 MIU 4／5a 的获准产品查询和多轮澄清，再接 MIU 8a／6d／11e 的正式询盘。历史恢复等用户决定。Resend 准备资料可以同时收集，见 [客户资料清单](RESEND-CUSTOMER-SETUP.md)。
