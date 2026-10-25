# 上游贡献草稿：未提交

本轮建议先在 Channel 保存已验证规则，再向官方贡献，不新建一个长期复制官方 skills 的仓库。以下文字已参考 Toolkit 当前贡献格式，**没有创建外部 issue / PR，也没有发给腾讯支持**。

## Toolkit 文档 PR

建议标题：`docs: clarify hosting backup integrity and retained release assets`

基于读取时 `4f68e9060c94327c1a39aa282ad17a03a4d7dfe5`。改唯一语义源 `config/source/skills/cloudbase-cli/references/hosting.md`，不改 `config/.claude/skills` 生成镜像。提交类型用 `docs:`；按贡献指南核对相关生成 / 校验命令，不能只改本机安装副本。

建议增加以下“备份与恢复检查”段落：

> 下载命令完成不等于备份可恢复。对用于恢复的备份，保存完整对象清单和站点配置，核对全部正文长度及摘要，并确认备份前后的对象身份一致；任何失败都不得继续部署。
>
> COS 对象键不是本地目录树：`X` 和 `X/a.html` 可同时存在。导出到磁盘时使用可逆映射与清单，不能直接假设每个前缀都是目录。下载需要同时处理 HTTP 失败、读写流异常、整个响应体时限及有限重试。
>
> 线上旧页面和打开的标签页可能仍引用旧哈希资源。默认保留资源；清理全站再部署不是通用安全流程。若需清理，先确认恢复版本、引用和允许删除范围。批量上传不是整站原子版本切换。
>
> 遇到 SDK 下载异常，先记录准确 SDK / CLI / Node 版本并跑最小重现；不要把一次 MCP 连接关闭一概归因为网络故障。SDK 升级后重查，避免把旧版缺陷写成永久规则。

PR 描述应列明验证：Manager 5.9.1 实际重现；5.9.2 仅源码对比；现有 Channel 修复的本机测试和认证只读完整备份。不提交环境 ID、桶名、密钥、签名 URL、用户内容或内部操作日志。不能声称新版 CLI 必然仍有同一个 bug。

## Manager 产品缺陷反馈

建议标题：`hosting download may terminate or report incomplete responses as success (manager-node 5.9.1)`

- 环境：Node 22.13.0；Manager 5.9.1；COS 2.15.4；MCP 2.36.1 为外部调用方。
- 正常对照：本机 HTTP 返回完整 200，下载完成。
- 问题一：对象键 `X` / `X/a.html` 使本地文件与目录冲突；写入流 `EISDIR` 未处理导致进程退出。
- 问题二：HTTP 中途 reset 后下载 Promise 未完成。
- 问题三：读取流 error 未归属当前 Promise，进程异常退出。
- 问题四：HTTP 503 的正文保存后报告成功。
- 预期：请求失败应有可捕获错误，不能静默完成；目录任务汇总错误；不接受不完整内容；路径冲突明确拒绝或采用可逆导出格式。
- 可提供无账号、无密钥、仅 localhost 的最小复现。Channel 中入口为 `scripts/diagnostics/hosting-sdk-download.mjs`，五个场景测试为 `scripts/hosting-backup-sdk.test.mjs`。对外提交前需把仅为定位而替换地址的 seam、真实 SDK 调用和故障注入逐项解释。
- 5.9.2 的相关下载源码未见修复，但尚未运行该版本全部测试；不要把源码比较写成运行结果。

Manager 的 package.json 指向 GitHub `TencentCloudBase/cloudbase-manager-node`，本轮访问返回 404。提交前须确认官方接收入口；不要在错误项目提交代码补丁。Toolkit 的 skill 文档 PR 和 Manager 的实现修复属于不同项目，不能用更新一个 skill 声称修好了 SDK。

平台工单暂不需要用于阻塞处理：认证源文件读取已有可验证替代路径。若受权源站持续 5xx、返回不一致内容，或真实云端请求持续失败，再准备脱敏请求编号、时间、地域、重试记录和最小重现；由用户决定发送。
