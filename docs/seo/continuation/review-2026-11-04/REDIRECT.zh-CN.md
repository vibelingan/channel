# HTTP及www的永久跳转

目标：http://supplychainsai.com/path?query 转到 https://supplychainsai.com/path?query；www最终也统一到HTTPS主域，保留路径与参数。301是HTTP响应状态码，不能只输出404/跳转页面正文，也不能用JS、canonical或DNS CNAME冒充。

## 现场事实与兼容边界

两域均HTTP_AND_HTTPS。主域有两静态路由及/blog容器路由；www只有静态路由。Google canonical使用不带www的HTTPS主域。另一个应用环境仍配置www为站点来源，实施www跳转前须检查登录回跳、跨域、Cookie/本地登录状态和AI入口。不得改其他app的配置来强行通过本次验收。

## 主域HTTP实施

使用已有共享maintenance队列，先保存完整域配置及已验收网站版本，确认队列锁实际运行、发布账本空闲，再仅改主域Protocol为HTTP_TO_HTTPS。源站文件、证书、路由、缓存和函数不改。官方依据：https://docs.cloudbase.net/api-reference/manager/node/domain ，MCP工具protocol枚举已核对。

旧恢复点仍记录HTTP_AND_HTTPS，因此先补明确允许该单项升级的checkpoint检查，其他设置必须完全相同。生成“文件不变、新协议已记录”的恢复点，再使用当前内容刷新交付并核对最终商品登记。未经这一步，不能说原恢复入口对新配置已验证。代码修复提交38be6de9，19项相关测试通过，远端检查及现场执行另记。

回退：如果路径/查询丢失、循环、HTTPS正文变动、路由/证书/缓存发生计划外变化，停止后续写入；仅在配置仍与本次预期一致时把Protocol恢复HTTP_AND_HTTPS并读回。未知写入先查实际配置，不盲目重复调用。保留原始请求编号和失败记录。

## www实施选择

当前网关公开更新接口支持协议301，不提供跨主机301字段。不能伪造Location响应头并保持200。本轮选择独立seo-canonical-redirect HTTP函数：只返回固定主域301，不加载SDK、不读取数据库、不接收云密钥。部署在既有上海环境，沿用云函数用量计费，不购买EdgeOne套餐。GET/HEAD原路径和查询保持；其他方法405，不接业务写入。13项本地HTTP测试通过，含伪造Host、编码参数和双斜杠；现场部署与路由切换结果另记。只调整www现有两条静态路由到该函数，开启完整路径透传；主域/blog保持原样。回退恢复保存的www两条STATIC_STORE设置，确认后才考虑删除本次函数。当前www尚未改，不能标为完成。

验收矩阵：首页、分类、商品、Blog、带中文/编码路径、带多个查询参数、不存在路径、GET/HEAD；主域HTTPS正文和404正常；www直接到最终HTTPS主域，尽量一次跳转；重复请求无循环。不在真实环境提交询盘或客户内容来测试跳转。
