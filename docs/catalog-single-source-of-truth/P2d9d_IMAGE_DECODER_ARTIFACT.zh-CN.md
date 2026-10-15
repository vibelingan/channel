# P2d9d：函数原生解码器打包

这一单元让引用 #catalog-image-decoder 的构建产物携带可执行的固定依赖，不改变商品、分类、来源、图片记录或发布状态。当前正式 handler 仍未引用像素模块；fullDeliveryReady=false。

## 打包与运行边界

三个函数的 tsup 配置保留私有导入为 external。package-functions 检查构建文件实际引用，只有使用者才复制解码器。pnpm-workspace 使用官方 supportedArchitectures 的 os/cpu/libc 映射形式，保留 current 并准备 Linux x64/glibc；frozen-lockfile 安装成功，lockfile没有改动。映射会安装轴的组合，发布包只选 Linux x64，避免把 Mac 库一同部署。未使用 pnpm12新增的平台列表语法。

新打包模块按消费包的 exact sharp 版本定位已安装依赖，复制完整 required JS 闭包及该版本声明的两个 Linux 原生包，解析所有 pnpm 链接为普通文件。缺失依赖、冲突版本或 native 版本不一致立即失败，打包和请求阶段均不访问网络、不在线安装。根 package imports 指向 vendor/image-decoder.mjs，由它加载 vendor/node_modules；MCP强制在线安装过滤根node_modules时仍能保留这套依赖。

当前 Linux vendor 共126文件、20,301,236字节、6包：sharp0.35.5、colour1.1.0、detect-libc2.1.2、semver7.8.5、sharp-linux-x64@0.35.5及libvips-linux-x64@1.3.4。两个原生二进制与前单元已核验归档逐字节一致。清单记录每个文件长度/SHA及包版本；产物门禁核对导入映射、完整文件清单及版本，并在清空NODE_PATH/预加载环境的子进程中真正生成、读取四种图片，坏JPEG必须拒绝。检查自身写入的临时脚本在finally删除。

Linux包在Mac执行会明确失败，不能把Mac成功当Linux证明。测试使用独立的本机ABI包验证迁移，另将默认Linux包交给真实云端；CI的既有Node20产物门禁会自动执行像素检查，没有新增可关闭的验证开关。

## 验证

初版16项红测1通过/15失败；实现后扩展至23项，覆盖三函数配置与默认像素模块的完整串联、移动到裸目录、删除根node_modules、缺失原生/JS依赖、版本与字节漂移、导入映射和真实CLI门禁。测试从源文件构建临时public-api，不依赖旧dist或.cloudbase-artifacts；暂时移开此前自有产物后23项仍通过，目录在finally恢复。初版漏导入realpathSync导致运行失败，补齐后重跑，不将失败计为通过。

七种实际代码缺陷均被同一23项基线检出，每轮仍有14–20项正控通过，零跳过/取消，finally恢复源码并核对8文件hash。包括直接移除自动像素门禁，这种修改若只看函数启动或搜索调用名字会假通过。Node20.19.0组合23项通过；完整部署脚本485项通过，零失败/跳过/取消。7文件Biome及CloudBase SDK106通过。13对SDK/工具调用登记后逐项核对：前单元10Sharp对，加esbuild0.27.7 buildSync、tsx4.22.4 require、tsup8.5.1 defineConfig；安装声明和运行时函数均可读，generated smoke中的Sharp调用由实际子进程执行验证，不伪称动态字符串有完整类型覆盖。

同一新模块生成的Linux vendor在真实Node20.19.3/Linux x64/glibc2.28/256MB探针通过24例，三件时钟各一张实际图片长度/SHA一致；仍用原默认像素加载器。第7轮有效临时实例已删除并读回确认，环境仅原三个应用函数。两个显式临时代码对象保持此前已删除状态；业务写入0、应用部署0。

证据位于output/pricing-clock-repair-2026-10-13/p2d9/pixel-pack-*。下一步先验证大图/动画与原生并发资源边界，再组合存储字节、像素和当前记录保护；本单元不证明已resync、可发布或20件验收通过。

## 实际文字复核

复核新打包模块/23项测试、三tsup配置、package-functions、smoke-function-artifacts、workspace配置、安装声明和本文。将“依赖安装完成就可运行”改为逐文件核验及真正像素执行，将“Linux包本机通过”改为本机ABI迁移对照加真实Linux证明；保留旧构建依赖和漏导入两次验证缺陷的修正记录。

来源：[Sharp安装](https://sharp.pixelplumbing.com/install/)、[pnpm架构配置](https://pnpm.io/settings/dependency-resolution#supportedarchitectures)、[esbuild构建API](https://esbuild.github.io/api/#build)、[tsx require](https://tsx.hirok.io/dev-api/tsx-require)、Node20 package imports及前单元官方MCP/manager取证。Context7不可用，没有新增CloudBase SDK方法或类型shim。
