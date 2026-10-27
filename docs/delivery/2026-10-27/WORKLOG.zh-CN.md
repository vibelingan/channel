# 10月27日：客户业务提示与安装阻塞

本轮沿用原SEO分支，不新建分支/worktree。不修改HermesInfra、不SSH登录、不传凭证、不向群发消息、不改网站或云资源。用户安排操作人安装，不必把SSH账号交给Codex。

## 核对与修正

- 读原GUIDE、TEST-PROMPT、START-HERE和MCP的client/server源码。旧包只有工具，没有专用Hermes技能；客户提示词却带SEO/alt/slug/请求号。将客户话语改成业务需求，技术规则移入写作和草稿两个技能，保留MCP接口及已验收程序原样。
- 读HermesInfra的docs/known-issues.md、deploy/hub/hub/main.py、docker-compose.yml和native skills_tool.py。两处记录指向发布助手xianqu-agent2/43.131.44.211:9876；旧111.230.142.195明确废弃。Docker示例不能当作当前裸机部署清单。
- 仅GET探测：marketagents.supplychainsai.com解析43.157.121.79，/health为200；Mac到两台Agent的9876端口直接读取均超时，不能据此判断进程停止。未发A2A消息，未触发模型。真实发布主机身份由操作人通过既有Hub和本机核对。
- 只读确认本机原credential.json存在、权限0600、owner匹配；不打印内容，不重新生成同名密钥。精确配置名为CHANNEL_BLOG_CREDENTIAL_FILE；转述丢下划线不能照抄。

具体措辞修正：“请提供SEO标题、alt和任务号”改为“客户说主题和读者，助手准备搜索摘要和图片说明，并按内部绑定保存草稿”。客户无需向Codex提供SSH，管理员通过既有SSH/SFTP一次放置网站授权，之后群里照常讲业务。

## 已做检查

两个技能通过结构校验；本机原生Hermes在独立HERMES_HOME中实际发现两个技能并读取绑定参考，没有调用模型、改全局技能或写生产。现有工具5项用例通过，传输示例仅bash -n语法检查，没有执行SSH/SCP。技能被识别不代表生产已安装或业务行为已群测。

MCP主文件SHA-256仍为4f388524a91a6275234dd8cd99cc2abe9f58c6290a0978253c1d10f58dd13d2a，工具代码不变。图片自动上传、一键网页授权和正式多客户隔离没有在本轮实现，不作已完成承诺。

本机工作目录另有既有未提交缺失文件，未恢复或暂存它们；本轮仅提交明确的文档和技能。没有为文档更新重新部署网站。

用户进一步要求给管理员逐步操作，新增ADMIN-STEPS：分清Mac/发布机/内容机，列出身份、运行账号、程序摘要、私有文件权限、技能、单条MCP配置、重载、群测和退出条件。示例凭证检查只输出通过/失败，不输出内容；所有SSH/SCP步骤均交操作人自行执行。

## 后续授权后的真实SSH接线

用户允许Mac专用SSH直连，管理员添加公钥后已登录真实发布机ubuntu/xianqu-agent2。公钥和网站凭证是两种授权，未混用其他App密钥。严格固定此前首次观察的主机指纹，没有收到带外指纹回传，记录为首次使用信任。

现场MCP主文件及3份技能文件与交付摘要一致，未重装；仅补原路径的0600凭证，能力清单6→8，SOUL追加本站规则。备份保留在服务器私有目录。实际原生0.19.0技能发现、两工具注册、MCP受保护读请求404/匿名401均通过，模型调用与文章写入0。

发现原USR1重载会向LIGHTCLAWBOT_HOME_CHANNEL广播，故采用原生有意停止标记+该网关正常重启，不创建广播标记。空闲检查通过，A2A进程未重启，网关重连后的四平台connected，端口及原配置值比对一致。未修改a2a-server源码、systemd单元、HermesInfra仓库或CloudBase资源。

本轮实际读过服务器agent_server.py、原生mcp_tool.py/skills_tool.py/gateway源码及当前配置的结构；只输出白名单字段，不输出其他MCP或模型凭据。将“技能文件存在=已接通”改为“原生技能/工具发现、受保护接口和常驻网关分别通过，群测仍待用户执行”。记录和恢复步骤见INSTALLATION-RESULT。
