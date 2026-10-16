# P2f4：持久图片检查观察

状态：实施中；fullDeliveryReady=false。保存当前任务下已经发生的字节/像素检查观察，供有界worker恢复；这些记录不是封印、不可变存储保证或发布权限，不写product preparation=ready。

## Runtime Problem / Data Shape

P2f3能取得完整候选，但请求中断会丢掉已检查图片。新增私有catalogImageObservations，按policy/job nonce/product input/image ID/image-record digest计算确定性_id。只存安全检查结果、scope与时间，每件数百字节，不保存图片、signed URL或第二份来源内容。verified包含现有stored-image-health-v1的SHA/尺寸/帧数，invalid/retry只含白名单reason。

新get-image-check/put-image-check是后端DbAdapter任务命令，均要求当前不可JSON复制lease。每次在同一事务读当前job、product/source/observation/link、image和已有记录，再复核lease；put核对被观察图片版本、verified的imageId/SHA/字节数。图片目标变化返回CONFLICT，产品输入变化标记job stale；计数合法变化保持相同图片digest，新鲜修改锁BUSY，损坏锁/计数拒绝。

## Technology Constraint / Choice

复用两adapter的原子边界和confirmed write。所有读取先于写入，事务不下载图片或跑codec。纯图片记录fingerprint/shape校验从现有字节reader移到DB独立子入口，保持原字节合约的字段和hash算法，避免存储与reader校验漂移。

每次技术写入推进独立mutationRevision，确保固定毫秒内的续期/读回也实际改变job文档；leaseVersion继续只表示持有者epoch，不因观察写入撤销当前grant。新字段属于尚未发布的job协议，所有新建job初始化0，溢出拒绝。旧ready报告和用户发布意图不由这个counter控制。

## Risk / Test

先红测：默认健康结果持久化/重开/重复ACK、imageId/目标digest/字节SHA篡改、产品/来源变化、取消/接管/过期/读中到期、共享引用计数、新鲜/坏锁、私有字段拒绝、nonce轮换不复用旧记录、坏存储记录以及第二次写入失败整笔回滚。新集合必须先声明ADMINONLY并测试部署幂等性。原字节/像素/健康和任务小流程一起回归。

记录只能说明当时检查结果与当前metadata相符。仍可被写入的对象可能在之后变化；最终producer必须完成相应目标保护和当前采用计划绑定，再签发ready。这一限制明确保留，不用进度或观察计数替代实际检查。

## 当前结果与review边界

26项观察状态测试、真实文件3项、云事务包装5项和源输入预算1项已覆盖。原字节/健康/像素/任务合计276项组合通过；补源预算用例后Node20加权限共343项通过，均0失败/跳过/取消。默认真实文件小流程通过普通上传完成helper激活，再由默认storage reader与默认sharp0.35.5读取/解码PNG，SHA和24×16尺寸准确，保存观察、释放租约、重开DB和换新authority后可恢复。落盘失败同时回退job版本和观察，丢ACK重放只有一条记录。

云包装测试验证所有读先于两次写；无source为6个实际操作，有source/observation/link为9个。第二次写的抛异常、零updated、错误码、错upsertId全部整笔回滚，连前面的job mutationRevision也恢复。这是本地SDK形状测试，不当成现场云并发验收；sdkAnswer保留code，安装SDK遇冲突会重试。

14种实际源码故障全部检出，正控至少273项，3源码hash恢复；2种资源配置故障分别19/17项正控。首次移除target guard仍被verified.health.inputDigest的第二道检查挡住，未计检出；新增旧invalid/retry不能落在替换目标的反例后重跑全部14轮。新增NoSQL ADMINONLY集合，资源数32→33；部署脚本487项通过。广泛DB最终824、admin535、local352=1711项，零失败/跳过/取消；四后台types、9文件Biome与CloudBase106通过。原1710广泛结果加最后一个仅测试的源预算用例，DB824单独完整重跑，生产源码相同。

仍然是历史观察：CloudBase快照读不锁image，图片记录或可写对象可以在快照之后变化。这里只对私有job写围栏，不把观察直接当成当前不可变target或ready。最终producer要绑定完整采用计划、当前产品/来源和相应媒体目标保护，这一工作继续。

实际复核移出的fingerprint/shape函数、原byte factory、job命令/租约/计数器、失败投影、两adapter写确认、SDK冲突处理、私有资源及真实文件测试。把“检查结果可直接复用为发布证据”限定为历史观察；按cloudbase-code-review矩阵NOSQL-007/012核对写确认与服务端权限。AUTH001/Storage001涉及的CloudBase网页登录/浏览器域名本单元未改变，未套用到现有门户JWT或擅自增加域名。属性mapping与分类保持原范围，fullDeliveryReady=false。
