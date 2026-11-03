请修复 feat/sales-assistant@004e534c 的以下四个问题，修复前先 fetch 核对他人更新，保留其工作。详细证据见同目录 FINDINGS.zh-CN.md。

1. canonical.ts:4 直接导入 jsonc-parser/lib/esm/main.js，在固定 Node 22.13.0 + tsx 下报 visit 无导出。复现：运行随附 canonical-import.mts（其中相对导入路径请按仓库位置调整），或用当前整合树运行 playwright.assistant-site.config.ts。官网全包有20个文件因此失败。Node25对照通过，Node22打包产物及两个Docker运行镜像冷导入通过。修复须同时保住源码执行与函数打包兼容性，不能只改回UMD后遗漏产物检查。
2. need.ts:198–204：先说 Please add our logo，再说 Cancel all customization; use standard packaging.，即使模型更新为 customization:[]，mergeNeed 仍保留 logo。见 edge-probes.json。为明确整体取消提供带原话依据的处理，保留防止推测覆盖明确要求的保护。
3. ai-engine-vibekb/index.ts:294–306：同样的响应和 usage，finish_reason=stop 会记用量，length 则直接抛错，丢失已返回的用量。见 edge-probes.json。正文不可用也要保留消耗记录，补失败响应回归。
4. tsconfig.assistant-chat.json 缺 DOM.Iterable，connected.spec.ts:620/622 展开 HTMLCollection/NodeList 报 TS2488。pnpm exec tsc -p tsconfig.assistant-chat.json 可复现；临时加 --lib ES2023,DOM,DOM.Iterable 则通过。远端聊天CI41621189754因此失败，未到E2E；UI CI41621179523通过。

请修完提交推远端，给我准确SHA和实际验证结果，由Codex另行独立复验。当前不要合并或部署，不发邮件，不改现有Hermes/Agent配置。真实模型超时由Codex继续排查，别为解决它切换或重启现有Agent。

验收至少包括固定Node22源码启动、受影响官网回归、真实Astro本地路径、聊天专用类型检查和完整聊天CI，以及取消全部定制/截断仍记用量两个新增边界。已有58项连接、98项组件和4项整站测试在Node25通过，不能代替Node22。8个缺陷注入需先验证正常代码能通过，再注入，并隔离本地队列残留。
