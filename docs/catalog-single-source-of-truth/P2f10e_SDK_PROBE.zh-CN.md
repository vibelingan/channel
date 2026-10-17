# P2f10e SDK调用合约

官方来源：https://docs.cloudbase.net/api-reference/server/node-sdk/functions 。本轮通过CloudBase知识库readDoc实际读取；Context7不可用。已安装@cloudbase/node-sdk3.17.2的types/index.d.ts、dist/functions/index.js、src/utils/tcbapirequester.ts、src/utils/request.ts及request-core.ts一起核对，未新增SDK类型shim或包版本。

callFunction接收{name,data}及第二参数ICustomReqOpts。事件函数发送functions.invokeFunction，function_name固定为alibaba-catalog-sync，request_data为签名call的JSON，method为POST。正常返回result/requestId，provider错误码分支可能直接返回错误对象而不抛异常；response_data不能JSON解析时保留字符串。控制器不能把SDK resolve或HTTP200当完成依据，必须检查受限回执并读取持久化的当前报告。

每次请求retryOptions.retries=0覆盖SDK配置的重试默认值。实际安装SDK测试拦截最底层连接失败，观察一次请求；编解码测试经过实际SDK函数层，断言固定目标、参数和timeout。request-core的req.setTimeout限制闲置时间，持续收到字节时不能限制总时长。因此用共享总时长保护，默认8000ms，并处理晚到的成功与拒绝；SDK本身仍设置同样timeout。只把超时表示为结果未确认，不能声称远端取消或已成功启动。

本地loopback HTTP持续返回空白字节，实测80ms测试预算触发自有PREPARATION_RESULT_TIMEOUT，SDK收到一次请求；这个测试在没有总时长保护时应失败。测试专用SDK配置只使用自有假密钥和127.0.0.1地址，结束恢复配置并关闭连接。测试不调用腾讯云业务API。调用时间预算测试可注入1–8000ms，生产默认固定8000ms，浏览器不能设置。

verify:cloudbase-sdk新增确切SDK函数体断言、生产调用方全量枚举及实际SDK运行测试，测试不得空选或跳过。完整控制器、类型、Node20、源码反例及真实bundled admin/sync串联的结果在本单元实施记录追加；这些本地结果不替代云端权限、实际调用丢响应、现场数据与发布性能验收。

调用还显式设置qualifier=$LATEST，匹配现有部署对$LATEST更新和逐函数SHA检查，避免依赖SDK文档中的默认版本流量分配。真实SDK编解码探针检查qualifier确实进入请求。没有创建或修改云端别名/版本配置。
