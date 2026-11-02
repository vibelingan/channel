# Channel 官网智能客服现状核对 · 2026-10-28

本轮为调研与PDF交付，不改产品代码，不合并Phase2 PR，不部署。原有讨论文件保留；这里是新的调查快照。

- [开发状态报告（7页）](Channel-Assistant-Status-2026-10-28.pdf)：线上烟测、实测界面、UI状态、产品和多步工具规划、联网建议与交付顺序。
- [整体流程图（6页）](Channel-Agent-Flows-2026-10-28.pdf)：当前官网、目标工具循环、正式询盘到Sales/Resend、三业务线、控制审批与模块进度。

结论：官网仍是Phase1有限知识问答，Phase2主要能力未落地。主干代码核对为b3d63ac1，Phase2 PR #59仍OPEN、a7e16aa2。当前网站静态资源实际指向已记录的BFF；本轮两个基础问答均降级为不可用，www在提交约51秒后仍无明确反馈。healthz返回200而readyz在约10.9秒探测内未返回；未定位生产最终根因。

多步工具调用、实时产品、卡片比较、表单预填和完整UI是已有规划，不能把PR中的上下文/等待小修复或Sales后台权限进度当作全部完成。公开网页检索是建议的受控扩展，不是本轮已批准或实现的变化。

## 证据与复核

[investigation-evidence.json](investigation-evidence.json)记录版本、两次线上问题和观测时间；[public-health-probes.json](public-health-probes.json)只记录从源码确认的/api/ai/healthz与/api/ai/readyz，早先错误的短路径探测不作为健康证据。[live-asset-check.json](live-asset-check.json)记录线上组件资源hash与实际API地址，不读浏览器凭据。

[pdf-validation.json](pdf-validation.json)记录页数、文件hash、文本/边界检查及逐页视觉复核。本轮已实际查看全部7+6页渲染：中文、截图、表格、箭头与边界无明显截断、重叠或缺字。渲染预览留在本地忽略目录，PDF、文本和源脚本可追溯。

## 写作与来源

使用humanizer及plain-technical-writing规则复核PDF正文、图中文字和本说明。实际读取：main的AssistantWidget/BFF/worker/store/grounding policy，Phase2 PLAN/SPEC/TECH-REVIEW/CLIENT-ANSWERS/ADR-003、PR59状态与文件清单，及当前Sales计划和SG2.4证据。

具体措辞修正：把“智能客服功能已完成”收紧为“Phase1基础问答代码存在，当前实测发生失败；Phase2产品与动作能力未落地”；把“不能联网”拆成“已调用在线模型和KB，但未接公开网页检索”。没有把历史5份文档或128件产品写成当前盘点。

参考：
- [Phase2 PR #59](https://github.com/vibelingan/channel/pull/59)
- [Anthropic工具与工作流模式](https://www.anthropic.com/research/building-effective-agents)
- [OWASP提示注入与权限限制](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)

邮件发送凭证仅留本地，不提交浏览器邮箱页面或其他邮件内容。
