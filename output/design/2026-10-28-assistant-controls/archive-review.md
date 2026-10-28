# SG2.3 成果归档切片独立复核

2026-10-29。只读检查 `/Volumes/Lexar-Mac/Projects/hermesinfra-sales-agent`，基线 `f3937ea09358ab3caeeff9e0790e2836784f1df0` 的未提交修改及新文件。没有修改产品文件、启动或清理容器、提交或推送代码。

## 结论

本次范围内未发现能够确认、需要阻断提交的代码缺陷。可以继续做隔离 MySQL 和远端 CI 验证；这不代表整个 SG2.3、企微任务控制或销售自动化已经交付。

## 已按源码核对的行为

- `artifacts.py:134-194`：先验证 runtime 服务凭据和完整 manifest，再在客户专属事务内检查当前任务。归档版本、文件字节、当前版本指针和 `review_ready` 一起提交；任一步失败沿用事务回滚。重复的提交 ID 与相同摘要返回旧回执，换内容会冲突，已待审时不能靠另一个提交 ID 覆盖成果。
- `artifacts.py:269-331`：归档检查当前 task/run/revision/handoff、已核验来源、有效客户绑定、获准 `artifact.write` 连接、运行已接受及非终态 assignment。来源原始事件摘要、业务归属和修订也要一致。调用方不能在 manifest 自己填写“已核验”使其生效。
- `artifacts.py:208-250`：从客户私有目录逐段用目录描述符打开，拒绝符号链接、非普通文件、多硬链接、越界路径、大小和 hash 不符；读前后检查文件元数据。保存进数据库的是已读到并验证过的字节，不是继续指向可变的工作目录。
- `intake.py:_transaction`：复用数据库 owner 行锁，使同客户提交串行核对，事务结束前复查客户绑定。`schema.sql` 的 task/submission 与 task/version 唯一键为幂等和版本提供约束。
- `http.py`：新路由复用禁用开关、有限 JSON 正文、Bearer 格式与角色凭据校验，失败回复不回显 manifest 或文件内容。未增加发送、批准或公开文件下载入口。

## 独立执行的检查

使用仓库现有 `.venv`：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=deploy/hub .venv/bin/python -m unittest discover -s deploy/hub/tests -p test_sales_artifacts.py -v
```

共发现 15 项：7 项文件与 manifest 测试通过，8 项 MySQL 测试因未设置隔离数据库开关明确跳过。没有把跳过项写成通过，也没有运行作者的容器。系统默认 Python 和文档依赖运行时缺 `jsonschema` 导致最初导入失败；随后使用项目虚拟环境复核成功，这不是产品行为失败。

## 仍需保留的边界

1. 本切片没有生产多 run 创建、失败后重新调度或旧 run 历史成果接收入口。当前选择拒绝旧 run 提交，能防止覆盖；整体 SG2.3 应继续标记为部分完成。
2. 归档接口给受信任 worker/工具代理使用。runtime 凭据不能交给模型，实际工具接线必须由宿主固定 task/run 身份。它不是模型可任意填写 task ID 的公开工具。
3. 归档校验能证明“保存的是哪些字节和来源版本”，不能证明邮件商业内容正确，也不等于人工批准。后续 SG3/SG5 仍须做事实检查、个人身份和固定版本批准。
4. 文件签名检查只是基础格式检查，不是恶意附件扫描。HTML 只保存私有字节，正式预览还需要鉴权和隔离渲染。数据库留存、备份及静态加密依赖部署验收。
5. 真实数据库并发、回滚及远端工作流必须看实际执行结果。本次独立复核尚未验证线上、真实客户、Resend、Apollo 或企微卡片。

## 写作与范围复核

实际阅读 `artifacts.py`、`test_sales_artifacts.py`、`http.py`、`intake.py`、`boundary.py`、`authorization.py`、`schema.sql`、Sales README、SG2.3 切片计划、Channel 的 SG2 模块与权限/工具设计，以及当前 Sales CI 配置。按 `code-review` 的规范/需求两个方向与 `simplify` 的范围和可读性准则复核，没有为凑数报告风格意见。

把“归档完成即可审核发送”明确为“归档成功仅表示准备成果可审阅，事实核对和发送批准还没发生”，避免把准备状态误写成外部业务完成。
