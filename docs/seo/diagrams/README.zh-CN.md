# SEO 交付图的阅读顺序

当前综合大图为 `output/seo-design-r2-2026-10-20/DELIVERY-COMPLETE-FLOW.html` 和
`DELIVERY-COMPLETE-SEQUENCE.html`。每个主体都是一张完整 SVG，不嵌入其他图。
图源为 `delivery-complete.workflow.json`、`delivery-complete.sequence.json`，包含有条件自动恢复、数据兼容和搜索通知时机。当前方案与审核边界见
[最终交付索引](../FINAL_DELIVERY.zh-CN.md)和[最终流程审阅](../FINAL_REVIEW.zh-CN.md)。
以下是第一轮图的历史阅读说明；`SEO-DELIVERY-ATLAS.html` 为多图合集，其中手动恢复策略已被上述新设计取代。旧文件保留用于追溯，不代表当前政策。

本组图依据 `feat/seo-foundation` 的实现提交 `14e8ad8b` 绘制。它们是代码与目标设计的说明，不是一次线上发布的执行记录。原有总流程保留，新增三张时序图，把参与方、请求先后、输入输出和失败位置拆开。

| 阅读顺序 | 图源 | 要回答的问题 |
| --- | --- | --- |
| 1 | [总流程](hosting-delivery.workflow.json) | 构建、备份、交付、恢复之间有什么依赖？ |
| 2 | [发布时序](hosting-publish.sequence.json) | 哪些步骤在云端写入前完成，哪些失败会留下部分发布状态？ |
| 3 | [备份时序](hosting-backup.sequence.json) | 下载回执成功以后，怎样证明备份完整、稳定而且可核验？ |
| 4 | [恢复时序](hosting-recovery.sequence.json) | 如何从固定产物生成恢复计划，按什么顺序执行，哪里仍待接入？ |

对应 HTML 均在仓库 `output/hosting-2026-10-20/`：`hosting-delivery.html`、`hosting-publish.html`、`hosting-backup.html`、`hosting-recovery.html`。HTML 提供搜索、缩放和浅深色切换；图从上往下读，箭头旁标出动作，底部卡片记录失败条件与实现边界。每个参与方表示一个逻辑职责，不代表都要部署一个独立服务；Astro 构建、备份脚本和验收脚本都可以在同一个 Actions runner 内运行。

## 发布时序

前提是现有 `test` 分支条件、同 SHA 的完整 CI、函数打包与运行时校验通过，整个 workflow 持有 `cloudbase-deploy-test` 共享锁。图从随后发生的公开商品采集开始：保存 JSON 后构建，核对产物并归档新站，再备份/归档当前线上文件。部署脚本随后运行缓存前检，通过后才进入原云端部署流程。

图中刻意保留“后端先更新、静态站后上传”：这是当前脚本的实际顺序。静态上传、hash 校验或后续验收失败时，不能推断函数已经恢复到旧版。逐文件上传也存在混合版本窗口。新产物 artifact 和旧站 backup artifact 用途不同，二者都不能单独证明一次发布成功，更不能自动成为 last-successful。

主要依据：`.github/workflows/deploy-test.yml`、`scripts/deploy-cloudbase-test.mjs`、`scripts/product-seo-release.mjs`、`scripts/hosting-contract.mjs`。目前保留正常流水线的必需步骤；应急 skip、自动内容发布和 last-successful 登记仍未接入。

## 备份时序

备份脚本先确认登录环境，然后分页取得文件清单 A，并保存网站及域名路由配置 A。下载目录后，只对明确缺失的文件补取一次；即使 SDK 报告 success，后面的校验仍会执行。

普通 ETag 文件比较长度和 MD5。分片 ETag 不能当作正文 MD5，脚本会通过公开域名独立读取，核对 ETag、长度与正文 SHA-256。随后重新取得清单 B、配置 B，排除请求 ID、响应日期等观测字段后比较前后状态，所有文件再计算 SHA-256。只有全量通过，才生成 recovery-manifest 并允许备份归档；备份或归档失败时，发布停止。

主要依据：`scripts/capture-hosting-backup.mjs`、`scripts/hosting-recovery.mjs` 中的 `inventoryIdentity` 和 `sealHostingBackup`。本轮已有人为执行的线上备份证据及本地脚本测试；自动备份在真实 GitHub workflow 中的执行尚待验收。备份范围是静态托管对象及读回配置，不包含数据库、云函数、外部商品图片服务或对象级缓存元数据。

## 恢复时序

图的整体标题和消息括号标出待接入部分。已有内核会校验输入环境、路径、符号链接、长度、文件 hash 和配置 hash；规划时要求调用方明确提供当前拥有的文件路径以及公开商品路径。旧产物若包含已撤回商品，整份拒绝，避免恢复旧 sitemap 后继续传播撤回地址。

执行内核的顺序是依赖资源、HTML、发现文件；每个文件先上传再读回，通过后才继续。然后只删除明确拥有、目标产物不含的 HTML/发现文件，再执行配置动作，最后运行真实地址验收。旧 hash 资源、平台路径及搜索验证文件保留。上传、读回、删除、配置、验收任一步抛错都不能报告恢复完成；失败以后也不能假定已自动撤销之前成功的步骤。

锁内 job、可信产物下载、实时公开状态读取和 CloudBase 操作适配器仍待实现。当前公开路径列表由调用方提供，不能把示例空数组当成生产证据。共享部署锁只串行遵守该锁的 workflow，不能冻结后台发布，也无法阻止绕开 workflow 的云端写入；执行期间发生撤回或其他变更，仍需要后续协调逻辑。

配置动作也需要单独确定：旧备份可能使用旧缓存头或首页错误正文，不能把整份历史配置直接回放后就称为安全恢复。已准备的缓存反向参数只恢复原 HTTP 响应策略，不能证明云配置逐字段还原。真实恢复耗时、缓存收敛、上传中断后的处理和与当前后端的兼容性，均待目标环境验收。

主要依据：`scripts/hosting-recovery.mjs` 中的 `verifyRecoveryInput`、`planHostingRecovery`、`executeHostingRecovery`，以及只读入口 `scripts/prepare-hosting-recovery.mjs`。静态恢复不会回滚函数和数据库；本图没有引入 Next.js、另一套站点架构、额外测试环境或另一条部署通道。
