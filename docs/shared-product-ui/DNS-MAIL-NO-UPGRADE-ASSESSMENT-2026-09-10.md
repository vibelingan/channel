# 官网与企业邮箱：不升级 DNSPod 的方案评估

日期：2026-09-10。范围：只读调查与方案，不授权修改 DNS、注册商 NS、
邮件配置或购买服务。用户选择先评估不升级方案。

## 结论

建议候选：把 **权威 DNS 托管**迁到 Cloudflare Free，使用根域名自动
CNAME 展平；**网站仍在 TCB、企业邮箱仍在腾讯、域名注册商不迁移**。
这不是已经执行的迁移，也不能在下面的预检通过前承诺零中断。

Cloudflare 官方说明所有套餐默认支持根域名 CNAME 展平，因此无需购买
DNSPod 展平套餐。[官方说明](https://developers.cloudflare.com/dns/cname-flattening/set-up-cname-flattening/)
Free 使用完整权威 DNS 接入，需要更换注册商处的 NS，不是仅添加一条
CNAME 就能使用。[接入方式](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)

## 当前实际情况

- TCB 中根域名和 www 都正常绑定 `channel-test`，证书/状态正常。
- DNSPod 当前免费版，共 11 条有效记录。根域名同时配置了网站 CNAME、
  腾讯企业邮箱的两个 MX 和 SPF TXT。
- Google/Cloudflare DoH 能查到 MX；本机最初只得到 CNAME，稍后又能查到 MX。
  所以不是“邮箱记录完全没有”，而是存在根 CNAME 共存的解析兼容风险。
  [DNSPod 对此冲突的说明](https://docs.dnspod.cn/dns/help-type/)
- 官网联系地址 `sales@supplychainsai.com` 是页面内容。是否存在同名邮箱或
  别名、是否能收发，仍需企业邮箱后台和真实收发验证，改 DNS 不会创建邮箱。
- DMARC 的报告地址仍是 `your@supplychainsai.com`；不能擅自换成未经确认的
  地址。当前 11 条中未见 DKIM selector，需向企业邮箱后台核对，而非猜测生成。

## 迁移中保留什么

| 用途 | 迁移规则 |
| --- | --- |
| 官网 @ | 保留当前 TCB CNAME 目标；DNS-only，根记录自动展平 |
| 官网 www | 保留当前 TCB CNAME 目标；DNS-only，不增加代理/CDN 层 |
| 收件 MX | 完整保留 `5 mxbiz1.qq.com`、`10 mxbiz2.qq.com` |
| SPF | 保留现有单条 SPF；不要新建第二条冲突 SPF |
| 邮箱验证 | 保留 `qqmail4261b488` CNAME，DNS-only，不展平此验证记录 |
| DMARC | 先原样保留，报告地址更正另行确认 |
| 两条域名验证 TXT | 从原 DNS 导出逐条保留，用于现有服务/证书验证 |
| kb、marketagents | 原值保留，防止其他站点随 NS 迁移失效 |

只使用 Cloudflare DNS，不开启橙云代理、Email Routing、Workers 或更换
腾讯 MX。DNS-only 不把网页流量代理到 Cloudflare，避免把 HTTPS、回源、
缓存、跨境访问的变化混入本次修复。[代理状态说明](https://developers.cloudflare.com/dns/proxy-status/)
自动扫描并不保证发现所有记录，必须对照 DNSPod 导出清单核对，而非照单接受扫描结果。

## 执行前必须通过的门槛

1. 确认域名注册商/NS 修改权限、客户持有的 Cloudflare 账号和维护窗口。
   此次评估没有创建 zone、授权新应用或更改 NS。
2. 导出 DNSPod 全量记录及 TTL/线路/启用状态；重新核对迁移时是否仍为 11 条。
   保留原 DNSPod zone，不删除任何记录。冻结迁移窗口内的并行 DNS 修改。
3. 核查父区 DS/DNSSEC；如已启用，按双方文档处理签名切换，不能只换 NS
   留下旧 DS 导致验证失败。本次 Google 和 Cloudflare DoH 的 DS 查询均为成功空答案，未发现
   已发布 DS；实际切换前仍需与注册商配置及父区状态再次核对。
4. **核查 TCB 的根域名验证与证书续期能否接受展平返回的 A/AAAA。**
   TCB 文档以 CNAME 为常规验证方式；Cloudflare 根展平不会直接返回该 CNAME。
   这是兼容性预检，不应因为 HTTPS 此刻能打开就假定后续续期一定正常。
   保留既有绑定和验证 TXT，必要时由腾讯支持确认，不删除重建线上域名。
   [TCB 自定义域名](https://docs.cloudbase.net/service/custom-domain)
   腾讯 SSL 的自动 DNS 验证依赖腾讯解析托管，第三方 DNS 可能需要手动添加
   验证记录。迁移前需确认当前 TCB 证书采用哪种托管/验证方式；不要将普通
   SSL 产品的续期规则直接假定为本环境的自动证书规则。
   [腾讯自动 DNS 验证](https://cloud.tencent.com/document/product/400/54502)
5. 候选 zone 准备好后，直接查询分配的新权威 NS，核对 @ 的 A/AAAA、MX、TXT，
   www、邮箱验证记录和其余子域名。新旧记录逐项一致才允许切换。
6. 再次取得明确迁移批准后，仅修改 NS。该操作与网站 CI/CD 分开记录。

## 验收与回退

- 使用多家递归解析器和新权威 NS 检查 @/www、MX/SPF/DMARC/验证记录。
- 验证根域名和 www 的 HTTPS、证书、首页、Admin 登录、公开商品和 API。
- 核对 kb、marketagents，不只测试主站。
- 用已确认存在的 sales 邮箱与独立外部邮箱互相收发，查看完整邮件头中的
  SPF/DKIM/DMARC 结果；没有真实收发，不声称邮件修好。
- 不把上述邮件测试顺手扩展成开启网站询价通知或向客户群发测试邮件。
- 若出现记录遗漏、证书/解析异常，先修正候选 zone；严重问题按记录恢复原 NS。
  NS/递归缓存的生效与回退都不是即时的，因此需保留双方一致记录与观察窗口。
  当前 NS 为 `purple.dnspod.net` / `tipsy.dnspod.net`；本次查询显示 NS TTL
  为 21600 秒，不能用网页记录较短的 TTL 推断 NS 切换或回退也能立即完成。

## 不采用的捷径

- 不把当前 CDN 解析 IP 写死为根域名 A：IP 不是 TCB 承诺的固定入口。
- 不删除网站 CNAME 给邮箱“腾位置”，也不把根域名改到 mail.qq.com。
- 只保留 www 可以绕开部分根域名冲突，但根网址还需要可靠 HTTPS 重定向服务；
  这会引入新入口及 URL 行为变化，不能作为免费的无成本替代直接执行。
- 继续 DNSPod Free 原样共存不会消除已观察到的兼容风险。

本评估的下一步是完成上述预检并给出明确切换窗口/回退清单；不是立即改 DNS。
