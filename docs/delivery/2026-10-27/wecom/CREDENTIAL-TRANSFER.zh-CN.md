# 一次性安全放置网站草稿凭证

不需要把SSH账号给Codex。用户或服务器管理员可用自己的SSH/SFTP工具完成。群助手负责服务器本地安装，管理员负责把网站授权交给正确的发布助手一次。

## 先确认接收方

先通过已有可信运维入口核对发布主机、SSH主机指纹、实际发布助手身份、运行用户和HERMES_HOME。仓库记录的目标是xianqu-agent2/43.131.44.211，但不是本轮已经登录验证的结论。不可仅凭一条公网健康回复或群里自称身份就上传。

不传到内容机43.157.53.132，不按废弃111.230.142.195模板操作，不通过群消息、提示词或普通附件发送明文。需要上传的是网站受限credential.json，不是腾讯SecretID/SecretKey，也不需要Github或模型密钥。

## 用SFTP界面

用户在Mac本机选择 `~/.config/channel-blog/wecom-20261026/credential.json`，传到已确认发布助手运行用户的私有目录。目录0700、文件0600，文件owner与工具运行用户相同。不要放到网站公开目录、共享素材目录、镜像或Git。

## 用现有SSH别名

下面是给操作人自行运行的模板，不会由Codex自动执行。仅当SSH登录用户就是运行发布助手的用户时直接采用；否则管理员应按实际运行账号安置文件，不能简单复制后放宽权限。

先在Mac设置自己已经核实的SSH别名，值只留本机：

```sh
PUBLISHER_SSH='填写已核实的SSH别名'
ssh -o StrictHostKeyChecking=yes "$PUBLISHER_SSH"   'curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9876/health'
```

确认回复属于当前登记的发布助手。若无可信主机指纹、身份不匹配、端口未确认或主机不可达，先停止，不关闭SSH验证、不换成内容机、不把钥匙贴群里。

核对后，一次运行以下整段；任一步失败即停止。目标已有凭证时不覆盖，先检查已有来源：

```sh
set -e
ssh -o StrictHostKeyChecking=yes "$PUBLISHER_SSH" '
  set -e
  umask 077
  target_dir="$HOME/.config/channel-blog/wecom-20261026"
  test ! -e "$target_dir/credential.json"
  mkdir -p "$target_dir"
  chmod 700 "$target_dir"
'
scp -p -o StrictHostKeyChecking=yes   "$HOME/.config/channel-blog/wecom-20261026/credential.json"   "$PUBLISHER_SSH:.config/channel-blog/wecom-20261026/credential.json"
```

随后在接收机只检查文件owner、权限和必需配置键是否齐全，不打印内容。MCP的CHANNEL_BLOG_CREDENTIAL_FILE指向该文件的实际绝对路径。程序使用现有账户的权限启动，不为通过检查把文件改成0644。

原文件已在网站登记，本轮到期时间2026-11-09 20:43（日本时间）。本轮没有自动轮换或续期，不要重新生成同名01密钥。需要长期连接时另行登记新身份/新keyId并停用旧凭证，不能靠改本地文件延长有效期。

## 安装后

重载该发布助手的MCP进程，或按实际服务方式仅重启它；先确认没有进行中的任务，不动内容助手、Hub或其他客户。先发现工具，再由用户发业务任务。凭证有误/泄露时走网站revoke入口停用它，保留客户草稿和证据。

更方便的“管理员登录网站后一键给助手授权”目前未实现；不要把这个后续方案说成现有群助手能自行领取网站凭证。
