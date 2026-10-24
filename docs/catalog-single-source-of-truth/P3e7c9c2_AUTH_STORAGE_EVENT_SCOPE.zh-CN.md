# P3e7c9c2 会话事件只响应会话字段

基线67091f62。原 `onAuthChange` 将 `storage` 的所有键直接转给登录订阅者：

```ts
window.addEventListener('storage', handler);
```

C9c每个任务独立写入恢复键。另一个标签的 `useSession` 因无关进度调用sync，读取/重建用户对象并通知React订阅者。批量发布时这会把进度写转换成反复的登录同步，给表单/列表异步生命周期带来额外刷新。因此在启用producer前于原共享会话入口过滤，所有现有订阅者共用同一规则。

范围只有事件订阅：`channel.token`、`channel.user`、`localStorage.clear()`的null key仍通知；本标签 `channel:auth`照常通知。恢复键、其他业务键、缺key普通事件不通知。注销时清理两个实际安装的监听器，不留下闭包；不更改JWT/身份/权限、token/user存储格式、登录或后端授权。

先运行真实共享函数的事件控制，覆盖三种有效键、本地自定义事件、无关键、取消订阅与两个独立订阅；同时增强C9c的两浏览器双标签测试，在另一标签写恢复记录后再写token作为事件队列哨兵，确认只有真实会话变化通知一次。Chromium/WebKit必须失败一次再转绿。随后对应全site、类型/构建和故障检出，review精确提交；旧storage getter故障仍是另一个启用门槛，不将本改动说成完整会话容错。原UI/JSON80/真实test矩阵继续开放，fullDeliveryReady=false。


## 复现与修复

两浏览器双标签都实际复现：两个恢复键写入后发一个token哨兵，原共享订阅收到3次，正确为1次。哨兵的原生storage事件到达说明前面同一来源标签的恢复写已处理，没有靠sleep或只在一瞬间断言0。同步事件控制的5个无关键也失败，12项合计5过/7败；定位为原监听器直接转发全部事件，因果已由真实共享函数和原生事件两路确认。

仅在原onAuthChange增加storageChanged闭包，条件为key null、TOKEN_KEY或USER_KEY。注销订阅移除真实安装的同一闭包，本地AUTH_EVENT保留原handler。未改getToken/getUser、setSession/clearSession，未改变用户角色或后端重验。既有useSession继续使用同一入口，已有媒体准备的无关storage负控制保留。

10新增控制与2条增强浏览器测试转绿，6故障全部检出、12重叠失败、源码SHA恢复：全转发、漏token、漏user、漏clear、漏本地事件、卸载错回调均可被检出。完整site978、Node20客户端组合179（含原发布/恢复/实际Admin-JSON-PNG）无失败/取消/跳过；19包与E2E类型、既有site测试类型、3文件Biome及15页构建通过。Node20全部关联3266仍是67091f62证据，本步重跑179客户端组合，不将其冒充全量后端；native/contract源码哈希与C8核对未变，651安装SDK及精确后端仍为4e5e13bf。相关证据合计6243中的其他包复用原未变基线。

实际review/simplify核对session入口、useSession消费者、媒体准备已有负控制、两浏览器哨兵和10控制及两个记录文档。humanizer把“避免刷新”收窄为“避免无关键通知登录订阅”，没有宣称所有表单重新加载问题都修完。原native权限检查仍是依据；此改动不把本地storage事件当登录授权。没有新增SDK/env/表、无需新部署资源。

C9c的unfiltered-storage启用阻断已由本次实际红绿关闭；storage getter被禁时的会话读取、原UI整笔回应丢失、JSON80一次begin原因未明及其余真实test门槛继续开放。客户发布producer尚未切换，fullDeliveryReady=false。下一小流程继续共享4并发/20分组与实际Classification发布入口，不以本提交当完成验收。
