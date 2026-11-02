# 官网真实聊天与统一询盘保存验收

2026-11-02。沿用 `feat/sales-agent-integration`；官网组件在 `feat/website-assistant-ui-foundation`，Sales runtime 在 Hermes 的 `feat/sales-agent-runtime`。本轮没有发布官网、修改其他工作流或发送邮件。

官网九个真实浏览器场景已通过：DeepSeek 与 VibeKB MCP 回答、当前产品与图片、比较、多轮需求修改、确认后保存、越界处理、无匹配、停止后重新回答及故障恢复。另测新询盘保存后自动进入本地隔离的 Hermes Sales 服务，调用真实模型并归档待审核成果。测试使用现有 Channel 云库；不需要新建云环境。

保存继续使用 `createAssistantInquiryStore` 原事务，把询盘、来源登记和待派发记录一起写入。普通聊天不保存；模型不能代客户勾选同意或提交。测试只允许 `[TEST ...]` 公司与 `@example.invalid` 邮箱，固定验收安装归属；既有产品只读，未改原客户记录。

新增 `apps/functions/sales-integration/scripts/assistant-inquiry-live.mts` 仅供显式验收：私有临时凭据文件、回环接口、原保存端与读取门禁、原来源签发和通知器。只派发本轮选中的合成询盘，持久接收后停止重复检查；没有邮件客户端或发送实现。它不进入正式函数包，也不能代替生产常驻服务。

实际跨机读取超过旧截止时间。新增 `SALES_PERMIT_TIMEOUT_MS`，默认仍为 3000 毫秒，只允许 100–10000；Hermes 对应配置见其 Sales 说明。十秒授权有效期、前后验权、来源复核、归属校验和去重规则保持不变。

本地验证：Sales integration 113 项全部通过；正式配置和验收 helper 类型检查通过；CloudBase SDK 契约检查通过；真实云保存、读回和自动 Sales 成果另有联动证据。完整官网报告位于 UI 分支 `docs/ai-platform/assistant-ui/REAL-CHAT-DELIVERY.md`，Hermes 结果在 `docs/sales-agent/evidence/SG3.2-REAL-CHANNEL-VERIFICATION.json`。

实际云资源：原环境 `diversity-123-d9grnqfux221323bb` 的验收安装及合成记录；所有新增 Sales 集合保持仅管理员可读写。模型和 MCP 凭据留在既有 Hermes 主机；临时云授权仅进本轮私有目录，验收结束清理自己的远端进程和目录。不操作现有 Agent 任务库。
