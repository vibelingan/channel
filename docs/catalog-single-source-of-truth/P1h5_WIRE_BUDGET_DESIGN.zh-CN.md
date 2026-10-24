# P1h5 整页响应预算与稳定分页

状态：本地实现及组合测试已完成，待精确提交 review；未部署/未启用大数据写端。沿现有pricing分支，无agent/worktree/新PR。前置5851cb8完整配置/job预检、a578309照片状态失效已本地复审；整体发布仍未完成。

## 已核实的缺口

- shared单配置预算128KiB，public/Preview/Review常量50；50份合法大配置能超过整页预算。
- 网站detail-limits.ts已有DETAIL_PAGE_BYTE_LIMIT=2MiB，累计8MiB/500配置/10页。必须遵守浏览器已有资源预算，不能只满足云端。
- 官方https://docs.cloudbase.net/error-code/EXCEED_MAX_RESPONSE_SIZE经MCP读取：云函数响应6MB。HTTP adapter的body是JSON字符串，函数返回还会再序列化；需按实际封装检查，不能只数字段字数。
- acceptDetailPage在累计超限时返回limit-exceeded；合法大集合必须能转现有paged模式并保留已选配置。
- 云端单文档大小当前契约仍未知，不采用未经核实的1MiB/16MiB假设；这仍是发布前门槛。

## 决定与实现顺序

1. 用实际HTTP adapter构造50个合法接近128KiB的配置，先证明现有成功响应超过浏览器预算。再测累计内存转分页/选中配置保留反例。
2. shared新增纯字节分页计划：整页应用预算1.75MiB，给浏览器2MiB及HTTP/函数序列化留余量。检查完整有效header/content/notes及认证Preview额外图片来源元数据；用最大单配置和最大单配置媒体项开销选择统一1..50页宽，页宽固定于输入/批准revision。普通样本仍50。只改变页宽，属性/选项/报价/图片不截断。
3. 批准计划对需要缩页的商品记录有界分页提示。提示放产品私有派生字段catalogDetailPagination，绑定批准revision和策略；不加到旧严格公开header或publication中。普通行写入不能伪造/递增这个字段；最终批准事务内与product/job切换一起写。内部job只给需要缩页的候选加可选页宽；正常候选原digest/shape保持。无额外finish记录读写。
4. public第一页客户端显式协商byte分页，随后携带实际页宽+revision；API、transport及reducer共同校验。旧small请求保持兼容；错误/陈旧提示拒绝，不能混页。兼容读端先部署并证明同SHA/旧writer drain，再允许新large写入；完整交付前不会启用不兼容写端。
5. source Preview和Review从完整计划及各自媒体元数据决定页宽，后续页使用同输入摘要；页数上限与10000配置及最小页宽一致。现有Preview/selector/分页组件及样式继续使用；fast approve只依赖全配置摘要，不能再假定页宽50。
6. 浏览器累计超过8MiB时转现有paged模式，只保留当前页及用户选中配置；继续校验revision/header/页宽/重复ID。不能吞掉未知响应、破损页或串revision，也不能谎称全集已加载。
7. 老批准数据走P5影子审计/分页提示回填；未覆盖的legacy异常仍是发版阻断，不能靠缺提示默认50掩盖。任何单个合法样本仍无法完整承载时，按既定L1条件分支处理；不能以截断、换图或丢选项解决。

## 必测门槛

实际HTTP body与函数返回JSON字节、CJK/引号/反斜杠/控制字符、完整/缺失媒体、长header/v2/v3、普通0/20/105与大50/70/105/10000界限；单页/最后页/随机回访/相同revision均无遗漏重复。测审批→immutable读回、旧hint错revision/损坏、普通写入保护、无hint迁移、公开opt-in及旧client、首个小配置后页超大、媒体元数据比配置更大的情况。集合跨8MiB转页保持选择且不继续增加内存，损坏数据仍报错。每项行为探针做可失败的mutation；对应类型/SDK/public媒体授权与消费者测试后，再跑构建组合与性能。不能用50件轻量fixture证明大配置链路。

此方案只处理响应和浏览器资源预算，不解决真正超过98操作的图片提交协议、报告producer/列表启用或durable操作恢复。上述门槛及原P1—P7全部保留。未来属性mapping仍仅为想法，不实施筛选或拆分来源存储。


本地退出证据：2437/0/0、九套类型、26 文件 Biome、SDK、构建浏览器 151 与 owned DB 清理、25 故障注入和正控已通过。完整记录在 IMPLEMENTATION_LOG 的 P1h5 节。旧数据迁移、平台单文档契约及原 P1—P7 其余门槛继续保留。
