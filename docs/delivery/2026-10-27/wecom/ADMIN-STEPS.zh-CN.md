# 给管理员：网站草稿助手一次性接线操作单

**当前状态已更新：[真实发布机安装结果](INSTALLATION-RESULT.zh-CN.md)。本轮已完成接线，下面作为运维复核参考，不要重复执行安装。**

2026-10-27。可将这份文件连同新版安装包交给负责服务器的人。用户不需要向Codex提供SSH账号、密码或token。以下操作由你们自己的管理员或已获权限的服务器助手完成，Codex没有远程执行。

目标：客户在微信群说业务需求，内容助手创作，发布助手保存到supplychainsai.com私有草稿，并返回后台编辑链接；管理员预览后才公开。

## 先分清两种工作

| 工作 | 谁做 | 频率 |
| --- | --- | --- |
| 确认发布主机、放置网站授权文件、装工具及技能 | 管理员协助现有发布助手 | 本轮一次 |
| 写文章、准备搜索摘要和图片说明、保存文字草稿 | 内容助手和发布助手 | 每次客户提出业务需求 |
| 登录后台补图、预览、确认公开 | 网站管理员/客户 | 每篇文章 |

这份credential.json只是网站授予“创建私有草稿、查自己的保存结果”的钥匙。它不是腾讯云管理密钥、管理员密码、模型API key；不要因此调整CloudBase权限、部署网站或复制其他密钥。

## 1. 确认真正的发布助手

在哪里做：先在现有Hub管理入口核对登记，再到实际发布主机上检查。不要仅凭旧Compose文件或公网端口超时作判断。

仓库迁移记录：内容助手为xianqu-agent1，43.157.53.132:9876；发布助手为xianqu-agent2，43.131.44.211:9876；111.230.142.195已明确废弃。记录可能过时，最终采用你们已确认的现场登记与运行身份。

在发布主机本机执行已核对的端口健康检查，例如当前记录的9876：

```sh
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9876/health
```

通过标准：返回的是当前登记的发布助手，通常包含xianqu-agent2或对应handle。若是内容助手、没有响应或身份不明，停止安装，先查当前登记和进程；不要在内容机新起一套，也不要为了连通开放公网端口。

本次Codex能访问现用Hub的HTTPS /health，但不能从外网成功读取两台Agent的9876。它不证明服务停止。无需把任何A2A消息发给用户来检查存活。

## 2. 核对实际运行账号和目录

在哪里做：发布主机，由管理员/该机助手读取现场配置，不把整个配置文件发回群。

记录以下四项：发布助手运行用户、实际HERMES_HOME、现有服务管理方式/服务名、该用户环境中的node版本。已有服务器助手若能读到这些，直接由它报告即可，不要求客户掌握命令。

```sh
node --version
```

需要Node20.19或以上，程序已在20.19做过独立运行检查。内容机的Node版本不能代替发布机检查。不要为安装此工具全局升级整个助手环境。

原生Hermes的技能和MCP配置属于实际HERMES_HOME，不一定是/root/.hermes，也不一定是SSH登录用户的家目录。若是原Compose容器部署，改读容器实际运行用户和持久卷，按原GUIDE的容器分支处理；不要把裸机和Docker步骤一起执行。

后面的安装文件由实际运行用户拥有。以其他管理员账号上传时，管理员需设置正确owner；不能靠放宽到0644来让程序启动。

## 3. 收到新版安装包并核验

在哪里做：发布主机的私有工作目录。把用户转交的新ZIP解压，保留目录结构，不执行自动重建或部署命令。

假设当前目录就是解压根目录：

```sh
sha256sum -c SHA256SUMS
sha256sum tool/channel-blog-mcp.mjs
node --check tool/channel-blog-mcp.mjs
```

主程序摘要必须为：

```text
4f388524a91a6275234dd8cd99cc2abe9f58c6290a0978253c1d10f58dd13d2a
```

本轮MCP程序没有更改，新增的是两份助手技能和接线说明。通过后，将程序保留在一个固定的版本目录；不要把args指向容易被清理的临时解压目录。程序不需在生产机器npm install。

## 4. 管理员安全放置凭证

在哪里做：用户Mac传出，核实后的发布主机接收。管理员用自己已有的SSH/SFTP或私有凭证渠道，无需向Codex提供账号。

源文件在用户Mac：

```text
~/.config/channel-blog/wecom-20261026/credential.json
```

它已经在网站登记。不要重新生成同名01密钥，不要把明文发群、贴进提示词或放进普通安装包。

将文件放到发布助手运行用户拥有的私有目录。目录0700、文件0600，记下实际绝对路径。具体SFTP/SSH操作和同账号复制模板见同目录的CREDENTIAL-TRANSFER.zh-CN.md；模板需先填本机已验证的SSH别名，不是交给Codex执行。

放好后，在实际运行用户身份下只核对owner/权限，不打印JSON。可用下面的Python检查，路径替换为实际绝对路径：

```sh
python3 - '/实际私有目录/credential.json' <<'PYTHON'
import os,sys,stat,json
from pathlib import Path
path=Path(sys.argv[1])
assert path.is_absolute(), '需要绝对路径'
info=path.stat()
assert stat.S_IMODE(info.st_mode)==0o600, '文件权限需为0600'
assert info.st_uid==os.getuid(), 'owner需与运行用户一致'
config=json.loads(path.read_text())
required=['CHANNEL_BLOG_API_ORIGIN','CHANNEL_BLOG_SITE_ORIGIN',
          'CHANNEL_BLOG_INTEGRATION_ID','CHANNEL_BLOG_CREDENTIAL',
          'CHANNEL_BLOG_TASK_ID','CHANNEL_BLOG_DRAFT_KEY']
assert all(config.get(key) for key in required), '配置键不完整'
print('凭证文件路径、owner、权限和必需配置键检查通过；未输出密钥')
PYTHON
```

本轮登记到2026-11-09 20:43（日本时间）。后续长期接入需按网站正式流程换新keyId并停用旧凭证，不是改本地文件就能延期。

## 5. 安装助手技能

在哪里做：各助手自己的实际HERMES_HOME/skills目录。安装前核对没有同名技能；有同名项时先比较/备份，不直接覆盖。

- 内容助手：安装skills/channel-blog-writing整个目录。它不需要网站凭证或MCP写入工具。
- 发布助手：安装skills/channel-blog-writing和skills/channel-blog-drafts整个目录，包含references子目录。保留所有既有技能。

可以由群里现有助手自己完成本机的技能安装；管理员仅在它缺文件权限时协助。

让各助手调用skills_list，再用skill_view读取自己负责的技能。发布助手还要能读取channel-blog-drafts中的references/pilot-binding.md。操作人仅回传已发现的名称，不发完整私有配置。

将这句站点工作说明合并进原规则，不替换全部系统提示词：

> 用户要求为已绑定网站创作文章或存草稿时，先读取channel-blog-writing；执行保存的发布助手还须读取channel-blog-drafts。客户只提供业务需求，技术字段和本轮稳定编号由助手处理。

## 6. 备份配置，仅新增一个MCP条目

在哪里做：发布助手实际HERMES_HOME里的config.yaml。先在私有目录备份，保留原权限；不要把备份上传群里。

只合并mcp_servers.channelblog，保留原模型、其他MCP、工具清单和群绑定。已有同名条目时先停下来检查。路径用第3、4步确认的实际绝对路径：

```yaml
mcp_servers:
  channelblog:
    command: node
    args:
      - /实际版本目录/channel-blog-mcp.mjs
    env:
      CHANNEL_BLOG_CREDENTIAL_FILE: /实际私有目录/credential.json
    trust: full
```

下划线必须保留。不能写成CHANNELBLOGCREDENTIALFILE，也不把网站REST API地址填到仅接受HTTP MCP的客户表单中。

若该配置由管理后台或同步器生成，先确认本条目能保留或在对应管理来源增加，不能只改一个下次重启就会被覆盖的副本。

如果原来显式限制tools.include，只增加这两个网站工具，不替换原清单；技能工具也应保持可用。实际Hermes版本和工具命名前缀以本机发现为准。

## 7. 只重载发布助手，先检查不写文章

在没有进行中任务的时间，按原服务管理方式重载MCP；若必须重启，仅重启已确认的发布助手服务。不要猜服务名、不要重启全部Compose、Hub或内容助手。

通过标准：能发现channel_blog_create_draft、channel_blog_get_import，其他原工具仍在；两个新技能可读。安装检查阶段不要发送真实文章，也不要触发WeCom/A2A测试消息。

如果工具启动失败，查实际进程错误：路径、owner、权限、Node版本和精确变量名。不要把密钥打印到日志，不复制新钥匙替换已登记的旧摘要。

## 8. 由用户在群里做一次业务测试

用户发送[业务版群测示例](../../2026-10-26/wecom/TEST-PROMPT.zh-CN.md)即可，不必说SEO、alt、任务号或JSON。助手自己准备搜索摘要和图片说明，再用内部固定绑定调用工具。

成功应同时满足：

- 发布助手通过真实工具保存并核对，返回真实网站后台编辑链接；不能只是群里出现正文。
- 用户登录后能看到私有草稿，刷新仍在；普通访客看不到。
- 本轮图片由人上传，采用助手准备的图片说明，预览后再人工公开。
- 公开后正文、图片、列表一致；日常发文不启动Github构建。
- 同一任务重试不另建文章，也不覆盖已人工修改的正文。

本轮固定一篇耳机询价文章。第二篇和长期多客户接入不是靠换提示词中的编号完成，需要相应的可信任务配置和授权。

## 9. 出问题怎样退出

- 安装失败：只撤回本轮新增的channelblog配置和站点工作说明，保留其他MCP、模型、群绑定及技能。若使用整份备份，必须先确认期间没有其他配置变化；否则逐项撤回。
- 凭证失败或疑似泄露：网站管理员按原GUIDE的revoke入口停用本轮密钥，不删除客户草稿或数据库。
- 接口超时：按原operationId查结果，保留原编号和正文，不换号重发。
- 出现非预期公开、重复文章或图片泄露：停止继续投递，保留错误和回执，再定位原因。

## 10. 管理员回传这份结果即可

```text
发布主机：已通过现有Hub登记及本机身份核对
Agent身份：
实际运行用户：
实际HERMES_HOME：
Node版本：
程序SHA核验：通过/失败
私有凭证owner及0600：通过/失败（不附内容）
写作技能可读：是/否
草稿技能及绑定参考可读：是/否
两个MCP工具可见：是/否
其他原有工具/群绑定：已保留
生产重载方式及结果：
用户群测：未开始/通过/失败
后台编辑链接及必要错误：
```

无需回传SSH密码、token、完整config.yaml、完整环境变量、WeCom secret或腾讯云密钥。
