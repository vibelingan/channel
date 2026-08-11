# Hermes 智能小助手 · 运维手册

> **服务形态**：企业微信/元宝/LightClaw 消息渠道 bot，由轻量服务器上 `hermes-gateway.service`
> （systemd user service，`hermes_cli.main gateway run`，消息平台网关）驱动；模型走 OpenAI 兼容
> provider（当前 zenmux）。本机**无 HTTP API server**——如未来要给网站悬浮 widget 用，需显式设置
> `API_SERVER_HOST` + `API_SERVER_KEY` 启用（见仓库 docker-compose.yml 注释）。
>
> **文档结构**：Part 0 脱敏铁律 → Part 1 通用排查 SOP → Part 2 事故 RCA 完整案例（2026-07-21）→
> Part 3 监控方案 → 附录 分组命令速查。

---

## Part 0 · 脱敏铁律（血泪条款，先读）

1. **查看 env/配置文件一律"默认遮蔽值"，绝不按关键字排除行**：

```bash
# ✅ 正确：只看键名，值全部打码
awk -F= '{print $1"=<redacted>"}' /home/ubuntu/.hermes/.env
# ✅ 正确：yaml 只看结构
grep -E '^[a-z_]+:|^\s{2}[a-z_]+:' /home/ubuntu/.hermes/config.yaml

# ❌ 错误（2026-07-21 实战翻车）：grep -vE 'key|token|secret' /path/.env
#    翻车原因：环境变量名全大写（API_KEY/WECOM_SECRET），grep 默认大小写敏感，
#    一行都没过滤掉；且 BOT_ID 这类新命名不在排除词里。排除式过滤必然漏，遮蔽式才不会。
```

2. 贴任何终端输出前，人工扫描含 `sk-`、`xoxb-`、`xapp-`、`-----BEGIN`、32 位以上 hex/JWT 形态的行。
3. **密钥一旦进入第三方信道（AI 对话、IM、工单、截图）= 视为已泄露。** 删除记录只是安慰剂，
   **轮换（吊销 + 重发）是唯一有效处置**。
4. 文档/日志/工单/聊天记录中永不记录密钥值；引用时用「`.env` 中 `XXX` 字段」指代。

---

## Part 1 · 通用排查 SOP

### Step 0 · 30 秒快速定性

```bash
ps aux | grep -i hermes | grep -v grep          # 进程在不在
sudo ss -ltnp | grep <PID>                       # 该进程该听的端口在不在听（消息网关形态本来就没端口，跳过）
systemctl status <PID> --no-pager                # 一条命令看穿：归属哪个 unit、有无自动拉起
```

| 结果 | 结论 | 跳转 |
|---|---|---|
| 进程不在 | 崩了/没拉起 | Step 1(OOM) → Step 5 |
| 进程在 | 看日志找下游失败 | Step 2 |

### Step 1 · 资源大盘

```bash
uptime && nproc                                  # 负载 vs 核数
free -h                                          # 内存（小内存跑 Agent 警惕 OOM）
df -h                                            # 磁盘（日志/SQLite 写满是常见死因）
sudo dmesg -T | grep -iE 'out of memory|oom' | tail -5
```

带宽看轻量服务器控制台监控图表。

### Step 2 · 日志（本案例形态：systemd user service）

```bash
journalctl --user -u hermes-gateway.service --since '1 hour ago' --no-pager | \
  grep -iE 'timeout|timed out|error|econn|429|402|401|connection'
```

**关键判据：分清 `Connection error`（链路层不通）和 `timeout`（通了但慢/配置短）——两者处置完全不同。**
日志里要找：是哪一跳失败（Hermes→模型，还是 Hermes→乐享 MCP）、用的是哪个 provider/模型/域名。

### Step 3 · AI API 连通性（网络问题用对照实验，别猜）

```bash
# ① DNS 双端对比（服务器 vs 办公机）：识别 DNS 污染
nslookup <provider域名>
#   污染指纹：解析到 Twitter(199.59.x.x)/Facebook(2a03:2880, face:b00c) 等明显无关 IP

# ② 全链路计时：卡在哪一段一眼可见
curl -sS -o /dev/null -m 15 \
  -w 'dns:%{time_namelookup}s connect:%{time_connect}s tls:%{time_appconnect}s total:%{time_total}s http:%{http_code}\n' \
  <provider地址>/models

# ③ 绕 DNS 直连真 IP：区分「DNS 污染」vs「IP/TLS 层阻断」
curl -sS -o /dev/null -m 15 --resolve <域名>:443:<真IP> \
  -w 'connect:%{time_connect}s total:%{time_total}s http:%{http_code}\n' https://<域名>/api/v1/models
#   connect 成功但 TLS 被 RST = SNI 阻断（GFW 特征）

# ④ 同类域对照：是「针对这个域」还是「整段出站被封」
curl -sS -o /dev/null -m 8 -w '%{http_code}\n' https://www.cloudflare.com
curl -sS -o /dev/null -m 8 -w '%{http_code}\n' https://api.deepseek.com

# ⑤ 带 Key 验证（Key 从 .env 手动复制填入本条命令，绝不要打印整个 env 文件）
curl -sS -m 15 -o /dev/null -w 'http:%{http_code}\n' <provider地址>/models -H "Authorization: Bearer <手动粘贴Key>"

# ⑥ 真实生成探测（大模型首 token 慢，-m ≥ 60s）
time curl -sS -m 90 <provider地址>/chat/completions \
  -H "Authorization: Bearer <手动粘贴Key>" -H 'Content-Type: application/json' \
  -d '{"model":"<模型名>","messages":[{"role":"user","content":"ping"}],"max_tokens":8}'
```

| 返回 | 含义 | 处置 |
|---|---|---|
| `200` | 链路+Key 通 | 查 Hermes 超时/重试配置 |
| `401/403` | Key 失效 | 换 Key |
| `402` | 欠费 | 充值 |
| `429` | 限流 | 降并发/升额度 |
| connect 卡满超时 + ①污染 | GFW 封锁 | 换 provider/备用域，**配置层无解** |

### Step 4 · 安全组与防火墙

```bash
sudo iptables -L OUTPUT -n | head -10
sudo ufw status verbose            # Ubuntu
```
控制台确认出站未收紧；入站只放行业务端口。

### Step 5 · 重启 + 自动拉起 + 配置生效

```bash
systemctl --user cat hermes-gateway.service          # 看 Restart=/EnvironmentFile=/ExecStart=
systemctl --user restart hermes-gateway.service
systemctl --user is-enabled hermes-gateway.service
loginctl show-user $USER | grep Linger               # Linger=yes 才会登出后继续跑
```

**配置生效铁律：进程 env 冻结于启动时刻。** 改完 `~/.hermes/.env` 或 `config.yaml` 必须
`systemctl --user restart`，否则进程一直用旧配置（本次事故的促成因子）。
快速自检「配置是否比进程新」：

```bash
# .env/config.yaml 的 mtime 晚于进程启动时间 = 有人在改配置后没重启
ls -l ~/.hermes/.env ~/.hermes/config.yaml; ps -o lstart= -p <PID>
```

---

## Part 2 · 事故 RCA：2026-07-21 企微小助手失联

### 2.1 摘要（电梯陈述）

企微渠道小助手无响应。**主根因**：模型 provider 域名 `zenmux.ai` 被骨干网封锁
（GFW：DNS 污染 + TLS SNI reset），服务器→provider 链路中断。**促成因子**：运维已于 7/17 将
配置切换到备用域 `zenmux.dev`，但**改完未重启服务**，进程继续使用 7/1 启动时冻结的旧配置
（旧域名 + 旧模型），恢复机会被白白浪费。无监控告警，故障由用户报告发现。

### 2.2 时间线

| 时间 | 事件 | 依据（事实/推断） |
|---|---|---|
| 7/1 10:24 | `hermes-gateway.service` 启动，加载旧配置（`zenmux.ai` + `kimi-k3`） | 事实：ps STIME、`/proc/PID/environ` |
| 7/10 | 服务器被当开发机用（LSP、astro dev 残留进程） | 事实：ps |
| 7/17 18:43 | `config.yaml` 改为 `zenmux.dev` + `deepseek/deepseek-v4-pro`；**未重启服务** | 事实：文件 mtime 与进程 env 差异；动机为规避 .ai 故障：推断 |
| 7/21 17:39–17:40 | 用户消息触发 conversation_loop，3 次 `APIConnectionError: Connection error`（目标 `zenmux.ai`、model `kimi-k3`）后放弃 | 事实：journal |
| 7/21 18:39–21:00 | 排障、定位、本文档 | 事实 |

### 2.3 完整证据链（假设 → 实验 → 证据 → 结论）

| # | 假设 | 实验 | 证据 | 结论 |
|---|---|---|---|---|
| H1 | 进程崩溃 | `ps aux \| grep hermes` | 进程在（7/1 起，内存 365MB 正常） | 否 |
| H2 | OOM/资源耗尽 | `uptime/free -h/df -h` | load 0.00；5.2G 可用；磁盘 12% | 否 |
| H3 | 服务内部/下游失败 | `journalctl --user -u hermes-gateway` | `APIConnectionError: Connection error` ×3（每次约 30s），provider=custom(zenmux)、model=kimi-k3 | **是：Hermes→模型一跳；且是连接错误，不是超时** |
| H4 | provider 服务挂了 | Mac 对照：`curl zenmux.ai` | HTTP 200，total 3.3s | 否：provider 存活 → 服务器链路问题 |
| H5 | DNS 污染 | 双端 `nslookup zenmux.ai` | 服务器：199.59.149.234（Twitter 段）+ `face:b00c`（Facebook 段）；Mac：172.65.90.66（Cloudflare） | **是：教科书级 GFW 污染指纹** |
| H6 | IP/TLS 层也封？ | `curl --resolve` 直连真 IP | TCP connect 0.23s 成功，TLS `Connection reset` | **是：SNI reset，双重封锁** |
| H7 | 整网出站被封？ | 同机 curl `cloudflare.com` / `api.deepseek.com` | 200 / 401（通） | 否：封锁仅针对 zenmux.ai |
| H8 | 配置未生效 | 对比进程 env vs `.env`/`config.yaml` | 进程=`zenmux.ai`+`kimi-k3`；文件=`zenmux.dev`+`deepseek-v4-pro`；config mtime(7/17) > 进程启动(7/1) | **是：改配置未重启，env 冻结** |
| H9 | HTTP API server 缺失（初始误判） | Caddyfile / units / history / docker-compose 注释 | 无反代、无 api unit、无 8787 历史；compose 注释：API server 默认关闭 | **误报撤回**：小助手=企微 bot（`.env` 含 WECOM/YUANBAO/LIGHTCLAW 集成），消息网关本无 HTTP 端口 |

### 2.4 方法论复盘（为什么是这个排查顺序）

- **分层排除**：进程 → 资源 → 日志（定位到哪一跳）→ 网络（DNS/TCP/TLS 逐层）→ 配置。每层用一条命令证伪，不跳跃。
- **对照实验是定位网络问题的唯一可靠手段**：Mac vs 服务器（H4）、假 IP vs 真 IP（H5/H6）、被封域 vs 同类域（H7）。没有对照组，一切"网络不通"都是猜。
- **关键判据**：
  - `Connection error` ≠ `timeout`：前者链路层（路由/DNS/封锁），后者性能或超时配置层，处置完全不同；
  - DNS 污染指纹 = 解析到 Twitter/Facebook 等无关 IP；
  - **进程 env 冻结于启动时刻**——改配置不重启等于没改。
- **走过的弯路**：开局误判"网站 widget → 8787 API server"（本地 PoC 记忆干扰），C 组证据（无反代/无 unit/`.env` 含 WECOM）推翻假设，修正为"企微 bot 消息网关"。**教训：先确认被排障对象的真实形态，再套拓扑假设。**

### 2.5 根因与促成因子

- **主根因**：`zenmux.ai` 被骨干网封锁（GFW）。服务器→provider 链路中断，配置层无解。
- **促成因子**：
  1. 7/17 配置切换备用域后未重启（若 `.dev` 可达且当时重启，事故不会发生）；
  2. 无监控告警，故障发现靠用户报告；
  3. provider 单点，无 fallback；
  4. 排障过程中发生密钥明文外泄（见 Part 0 与 2.6 Step B）。

### 2.6 修复 Runbook（按序执行）

**Step A · 验证备用域可达（决定性，一条命令定路线）**

```bash
nslookup zenmux.dev
curl -sS -o /dev/null -m 15 \
  -w 'dns:%{time_namelookup}s connect:%{time_connect}s tls:%{time_appconnect}s total:%{time_total}s http:%{http_code}\n' \
  https://zenmux.dev/api/v1/models
```

**Step B · 轮换已泄露密钥（必做，与恢复并行；不粘贴任何旧密钥）**

1. zenmux 控制台 → API Keys → 吊销 `.env` 中 `CUSTOM_ZENMUX_AI_API_KEY` 当前那把 → 签发新 key
   （注意：该 key 疑似同时被本机 opencode 等工具复用，轮换后需同步更新各工具的 auth 配置）
2. 企业微信管理后台 → 重置 `WECOM_SECRET`（BOT_ID 如后台支持一并更换）
3. 更新服务器 `~/.hermes/.env` 对应字段，保持权限 `chmod 600`

**Step C · 重启使配置生效**

```bash
systemctl --user restart hermes-gateway.service
sleep 8 && systemctl --user status hermes-gateway.service --no-pager | head -8
journalctl --user -u hermes-gateway.service -f     # 观察启动日志
```

**Step D · 端到端验证**：企微里给 bot 发一条消息 → journal 无 `Connection error`/401 → bot 正常回复。

**Fallback（Step A 显示 `.dev` 也不通时）**：provider 切国内直连——`config.yaml` 的 provider
`base_url` 改为 `https://api.deepseek.com/v1`、model 改 `deepseek-chat`、`.env` 换 DeepSeek key
（服务器→`api.deepseek.com` 已验证可达），然后 Step C/D。

### 2.7 预防措施

1. **配置变更纪律**：改 `.env`/`config.yaml` 后必须 `systemctl --user restart`；把「配置 mtime > 进程启动时间」做成监控项（见 Part 3）。
2. **provider 双供应商 fallback**（ADR-001 D1）：主 provider 不可达时自动切国内直连。
3. **监控告警**（Part 3）：provider 链路探测必须纳入。
4. **配置漂移治理**：journal 出现 `unknown config keys ignored: available_models_json, model_display_name, protocol`——配置文件是其他版本/工具写的，当前版本不认这些键；固定版本后清理或对齐。
5. **服务器卫生**：清理 cgroup 里残留的两个重复 `astro dev`（4321/4322）与多余 tsserver；生产服务机不当开发机用。

### 2.8 FAQ：域名"之前能用、突然被封"，找谁？

- **找谁都无法"解封"**。GFW 是骨干网国家级过滤，腾讯/阿里/华为云都无权解除，也没有申诉渠道；
  云厂商客服的 SOP 覆盖不到这一层（本次腾讯客服 5 步建议全部落空即为例证）。
- 无论 zenmux 是不是阿里系服务（其归属无法从外部证实），**域名被封这件事任何国内厂商都解不了**；
  能有效回答的只有 **provider 官方客服**——问他们有没有面向中国大陆的可达端点/镜像
  （zenmux 显然已有 `zenmux.dev` 备用域，先按 Step A 验证）。
- **生产答案**：面向国内用户的服务，provider 必须选国内合规可达（DeepSeek 直连/腾讯混元/阿里百炼），
  与 ADR-001 D1 决策点一致。境外聚合网关只适合做开发调试，不适合做生产依赖。

---

## Part 3 · 监控方案（候选，未定 —— 根因闭环后按成本决策）

**决策状态（2026-07-21）：暂缓实施。** 按 infra 成本权衡「外部探针 vs 内部守护」后定。
核心原则：探针必须在机器外面（同机监控 = 机器一死监控陪葬）。

### 本次事故对监控设计的新增输入

1. 探针必须覆盖「服务器 → 模型 provider」链路（curl provider `/models`），否则本次事故照样看不见；
2. 必须监控「配置 mtime > 进程启动时间」这种漂移（一条 cron 即可，零成本）；
3. 消息渠道 bot 的 E2E 探测难以合成，可用 journal 错误率（`Connection error` 出现频率）做代理指标；
4. 告警渠道注意依赖反转：被监控对象本身就是企微 bot 时，告警要走另一个独立渠道（另一个机器人/邮件/短信）。

### Tier 0 · 保底（10 分钟，零额外成本）

- unit 已有 `Restart=always`；确认 `is-enabled` + `Linger=yes`
- 轻量控制台云监控告警：CPU/内存/带宽/磁盘 → 微信/邮件
- 本机 cron 三件套：① journal 错误率监控（`Connection error` 连续出现 → 告警）② 配置漂移检测（`.env`/`config.yaml` mtime vs 进程启动时间）③ 可选 provider 链路探测 → 企业微信群机器人 webhook

### Tier 1 · 推荐候选（1~2 小时，栈内原生）

- **外部合成探针 = CloudBase 定时触发云函数**：每 1~2 分钟探测对外入口；每 5 分钟探测 provider 链路；失败/超阈值 → 企业微信机器人
- 指标：入口可达性、provider 链路延迟、unit active 状态、RestartCount
- 成本：Serverless 基本免费，不依赖轻量服务器存活

### Tier 2 · 完整可观测（后续迭代）

- node_exporter + 托管 Prometheus + Grafana；journal 错误率告警；告警分级 微信→短信→电话

---

## 附录 · 分组命令速查（本次实战编排）

- **A 组（链路定位）**：nslookup 双端对比 → 全链路计时 curl → `--resolve` 绕 DNS → 同类域对照 → 带 Key 验证 → 真实生成探测
- **B 组（端口/进程形态）**：`sudo ss -ltnp` 全量 → `systemctl --user cat <unit>` → journal grep `listen|bind|port`
- **C 组（入口形态确认）**：Caddyfile/nginx 配置 → `systemctl --user list-units --all` → journal/bash_history 考古 → 仓库 cli.py/docker-compose 找真实启动命令 → `.env` 键名遮蔽查看（`awk -F= '{print $1"=<redacted>"}'`）
- **D 组（修复验证）**：备用域可达性 → 重启 → status → journal -f → 渠道内发消息 E2E

> 变更记录：2026-07-21 初版（含当日事故 RCA 全流程）。

### D 组结果与 RCA 修订（2026-07-22 上午）

- **D1**：`zenmux.dev` DNS 干净（104.18.x.x = Cloudflare 真 IP），TCP 通、TLS 完成（12s 偏慢），但 **HTTP 522**（Cloudflare 连不上源站）。Mac 对照 3 次全部 522 → **源站故障是全球性的，与 GFW、服务器路径均无关**
- **结论升级**：两条 zenmux 路由全灭——`.ai` 被 GFW 封锁（服务器侧），`.dev` 源站宕机（全球）。**Fallback（切国内直连 provider）从备选升级为唯一路线**
- **D2 时间线修正**：`.env`/`config.yaml` mtime 为 **7/21 22:04–22:05**（非此前推断的仅 7/17；7/17 18:43 为首次观察到的较早编辑）——配置在事故发生后又被编辑过一次
- **D3**：服务已于 7/22 10:52 重启加载新配置；但启动日志显示 **`LightClawBot` 平台配置校验失败、adapter 创建失败**（该渠道当前不可用）；unit 状态 enabled + Restart=always ✓
- **新风险项**：unit Memory peak 5.8G / 机器 7.4G——叠加残留的 astro dev 进程，OOM 风险真实存在；残留进程在重启时成为 systemd "left-over process" 警告

### 522 定性与 E2E 恢复（2026-07-22 下午）

- Mac 侧两轮复测 `zenmux.dev/api/v1/models` 均 **522 ×3**；但同事报告**企微 bot 已恢复回复**
- 两者不矛盾：522 是「CF 边缘 → 源站」错误，具有**边缘节点特异性和/或 endpoint 特异性**——Mac（日本边缘）到的路径仍坏，服务器所在边缘可能正常；也可能 `/models` 端点本身故障而 `/chat/completions` 正常
- **判级原则：真实渠道的 E2E 证据 > 外部探针的单端点结果**；以服务器侧 curl + journal 成功调用记录为准
- 待确认：同事是否改动过配置（影响 RCA 归因）；LightClawBot adapter 是否恢复
