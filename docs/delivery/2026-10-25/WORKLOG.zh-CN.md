# 本轮工作与验收

2026-10-25。沿用原 SEO Git 工作区；原 `projects/channel` 的 AI platform 未提交文件没有改动，pricing 没有改动。本轮没有写云资源，没有修改 main / test，没有启用自动部署，也没有创建远端 issue / PR。

已完成：附件技能9个文件逐字节安装；读取野心工作法与方法参考；对比现有静态发布和按需返回HTML；统计完整备份的文件 / 媒体 / 历史版本；读回远端CI各job时间；检查本机及官方hosting skill；核对准确SDK / Node / MCP / Astro版本；补充工程规则、故障记录、上游草稿、分模块计划和完整图。

源码核对包括：`apps/site/astro.config.ts`，商品 / Blog / 文章媒体路由，`CatalogDetailController.tsx`，`catalog-detail-api.ts`，`apps/functions/admin/src/article-media.ts`，`packages/articles/src/publication.ts` 与修订 / 发布类型，`scripts/run-site-delivery.ts`，`scripts/release/site-files.mjs`，`hosting-delta.mjs`，备份 / COS / HTTP helper，三条发布workflow与CI依赖关系。官方资料包括Astro6的混合渲染与Node adapter、Payload官方模板及发布hook、COS签名、CloudBase知识库的Node云托管部署和Toolkit贡献指南。无Context7工具，使用官方知识库、包源码、npm peer声明和实际运行交叉验证。

文字校对实际修改：将“正常部署有明确凭据时命令直接用绑定目标环境的管理SDK……”改成“GitHub发布程序使用专门配置的发布账号，读取明确指定的网站环境……”；将“绕过网关”解释为“已有权限下直接读取源文件”。保留鉴权、目标环境、只读范围和未实测状态，不以白话为由删掉限制。

下载相关31项定向测试再次通过，包括实际SDK重现。没有更改下载算法或SDK版本；上轮1142项和远端CI是历史基线，不冒充本轮重新执行。

隔离的Astro6.4.6 / Node adapter10.1.4实验实际构建并启动Node服务，用本机JSON数据模拟内容：不重新构建、不重启，更新和撤回反映于HTTP HTML，静态商品字节不变，共九项通过。未连接真实数据库，未部署CloudBase；实验只证明框架路径可行。安装包只写本机实验目录，未修改产品lockfile。

图由Archify生成，最终HTML与archify.json配套。四张图都完成9项产物检查，零错误 / 警告；真实浏览器检查1440×900、1600×1000、1920×1080、2048×1320，含端点尺寸的明暗截图。初轮图过高，按诊断压缩了空白间隔，重新生成；没有隐藏溢出、裁切或改渲染器。浏览器原始回执随图保留。人工图像检查与自动检查分别记录，未把自动回执中的visualReview=pending改成passed。

验收附录 `evidence/` 保存已脱敏的资源统计、CI时间、技能安装、框架实验和Archify交付回执。原始下载文件、环境配置和带权限信息的日志不复制进仓库。未来SDK更新按版本重新检查，不把本次缺陷固化为永久结论。

新的Blog服务、公开内容 / 图片读取、免整站下载归档与CI加速仍是设计，需按模块实施并在test验证。八分钟总交付、五分钟稳定备份、十秒文章发布都是目标，尚未证明达成。

推送调查文档后补查真实环境：仅执行auth(status)、云托管开通状态 / 服务列表及网关域名 / 路由读取；确认Shanghai目标环境、云托管已开通、无Blog服务。发现主域名DIRECT及域名级no-cache覆盖，已纳入实施前提；没有修改服务、网关、响应头、凭据或业务数据。CI慢步骤也进一步读回：site测试命令442秒、正式后台浏览器执行533秒，浏览器安装各53/61秒，不能把所有耗时归因安装依赖。

二次源码审查实际读了Manager的`types/index.d.ts`、`types/environment.d.ts`、`types/context.d.ts`和`getManagerConfig()`方法，发现我们的脚本直接访问private字段。最终采用SDK已有公开getter，未新增配置传递框架；签名器取副本，所有原有环境和region检查保留。COS改为显式直接开发依赖，版本仍2.15.4；冻结lockfile的离线检查通过。先观察禁止私有字段的新增测试失败，再修复；定向43项通过，最终完整脚本1146项通过，SDK和Blog脚本类型检查通过。未执行云端写入或新一轮全量备份。

依据CloudBase code review的规则边界做语义审查：本次仅修改管理SDK读取方式，没有Web登录、RLS、数据库结构或私有媒体授权规则变动。没有执行可选的第三方正则lint脚本。依simplify复核后，用现成的公开getter替代一度考虑的额外配置包装层；原有错误、跨环境拒绝和写入结果不明时停止的行为继续由回归验证。

最终全量回归曾出现1145通过、1失败：流异常诊断在文件异步落盘前结束进程，导致预期半截文件偶发为空。已将reset / stream-error的故障注入改为先观察半截字节落盘，再断开；保留退出码、未处理异常、未报告成功及半截内容断言，并增加预条件标记。没有通过接纳空文件或删测试来放行。修复后全量1146项通过，原失败日志仍保留。
