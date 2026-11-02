import json
from pathlib import Path
p=Path(__file__).parent
rows=[
('closed','入口收起','接待与提问','existing_partial','访客关闭面板或首次进站','welcome',['打开助手'],'关闭只是收起界面；不暗示取消后台任务。'),
('welcome','欢迎与能力边界','接待与提问','existing_partial','点击 Ask our AI','composing,queued',['选择建议问题','输入问题','关闭面板'],'说明可以做什么，使用简短建议问题，不以拒绝话术作为开场。'),
('composing','正在输入','接待与提问','existing_partial','用户在输入框编辑','queued',['发送','换行','清空'],'Enter 发送，Shift+Enter 换行；中文输入法组合输入期间不提交。'),
('queued','已收到，等待处理','回答与工具','missing','消息已提交且收到受理回执','retrieving,stop_requested,network_failure',['停止当前回答'],'显示已收到；排队序号只有服务端确实提供时才显示。'),
('retrieving','查询获准资料','回答与工具','missing','开始检索知识资料','streaming,tool_progress,no_match,stop_requested',['停止当前回答'],'不显示虚构百分比；等待提示、取消和用户问题始终可见。'),
('streaming','回答逐步出现','回答与工具','existing_partial','收到属于本次问题的文本事件','product_results,stop_requested',['停止当前回答','滚动阅读'],'现有组件有拼接逻辑；实际 worker 尚未交付真实即时流式。'),
('tool_progress','多步产品查询','回答与工具','planned','服务器允许产品查询工具','product_results,no_match,network_failure,stop_requested',['停止当前回答','查看当前步骤'],'只展示可信工具步骤；不展示模型推理或内部工作日志。'),
('product_results','产品卡片与后续选择','回答与工具','planned','获准产品接口返回有效产品','comparison,inquiry_review,clarification',['比较示例产品','准备询盘','追问'],'示例卡片不代表库存或商业承诺；真实卡片必须查实时获准产品。'),
('comparison','产品比较','回答与工具','planned','选择两款产品后确认比较','inquiry_review,source_changed',['准备询盘','返回产品'],'窄屏用纵向卡片比较；不能用压缩小字或横向大表格承载核心信息。'),
('clarification','信息不足，继续澄清','回答与工具','missing','有采购意图但用途或要求模糊','queued,inquiry_review',['回答补充问题','先准备未选型号询盘'],'未选 SKU 也能提交需求；普通咨询不创建 Sales 任务。'),
('no_match','没有合适的产品或依据','恢复与边界','missing','检索没有匹配项','clarification,inquiry_review',['调整条件','交给团队'],'解释查不到什么，保留输入，助手继续可用。'),
('out_of_scope','问题超出可回答范围','恢复与边界','existing_partial','请求无法由允许知识和工具处理','welcome,queued',['询问产品','联系团队'],'普通越界用可恢复答复；不能把整台助手锁定为不可用。'),
('network_failure','网络或服务暂时失败','恢复与边界','existing_partial','受理或读取超时、服务报错','queued,handoff',['重试本条','联系团队'],'保留问题和已有内容；重试同一提交用同一幂等键。'),
('reconnecting','连接中断，恢复当前回答','恢复与边界','missing','事件流断开且任务可能仍运行','streaming,network_failure,stop_requested',['恢复连接','停止当前回答'],'从服务端序号恢复原 run，不重开任务，不重复加同一段回答。'),
('rate_limit','请求过于频繁','恢复与边界','missing','服务端返回限流或明确重试时间','queued,handoff',['稍后重试','联系团队'],'只显示服务端 Retry-After；不编造倒计时。'),
('stop_requested','已请求停止','停止与恢复','missing','用户点击 Stop generation','stopped,stop_unconfirmed',['等待确认'],'按钮点击后立即反馈；收到服务器确认前不能写成已停止。'),
('stop_unconfirmed','停止结果尚未确认','停止与恢复','missing','停止请求超时，原回答状态不明','stopped,streaming',['检查当前状态'],'不自动重开同一任务；让用户明确知道请求可能仍在结束中。'),
('stopped','本次回答已停止','停止与恢复','existing_partial','服务端确认当前 run 已取消或已终止','retry_after_stop,queued',['重新回答','改写问题'],'保留用户问题与已生成内容；停止不撤销已保存询盘。'),
('retry_after_stop','重新回答前确认','停止与恢复','missing','用户在已停止回答下点击重新回答','queued,stopped',['重新回答','返回'],'从保留的问题新建一次回答，旧回答保留并标记已停止。'),
('history_restoring','正在恢复对话','历史与连续性','missing','重新打开面板且存在有效会话','history_restored,history_expired',['等待恢复','关闭面板'],'先确认会话归属和有效期；不能凭浏览器本地 ID 拉取其他人的历史。'),
('history_restored','已恢复，阅读长对话','历史与连续性','missing','服务端返回有权读取的历史','queued,source_changed',['继续提问','跳到最新消息'],'用户上滚时不强制拉到底部；有新内容时显示跳到最新消息。'),
('history_expired','会话过期，开始新对话','历史与连续性','missing','会话已过期、撤销或无法验证','welcome',['开始新对话'],'不回显无权读取的旧消息；不悄悄带入旧联系人或旧需求。'),
('inquiry_review','客户核对正式询盘','询盘与交接','planned','客户明确要求提交采购需求','inquiry_validation,inquiry_submitting',['编辑需求和联系方式','确认提交','返回聊天'],'表单对接现有 OEM 或正式单品流程；成功保存前不产生跟进任务。'),
('inquiry_validation','表单需要修正','询盘与交接','planned','提交前字段验证失败','inquiry_review,inquiry_submitting',['修正字段','重新提交'],'字段旁显示错误，焦点到第一处错误，不丢失其他已填内容。'),
('inquiry_submitting','正在保存询盘','询盘与交接','planned','确认提交后持久化请求在途','inquiry_saved,inquiry_unknown',['等待保存结果'],'防重复提交；关闭界面不代表能撤销已经发出的保存请求。'),
('inquiry_unknown','保存结果待核对','询盘与交接','planned','保存请求超时且没有明确结果','inquiry_saved,inquiry_review',['查询提交结果'],'先用原提交身份查询或幂等重试；不能当失败后创建新询盘。'),
('inquiry_saved','询盘已记录','询盘与交接','planned','服务器返回真实保存回执','queued,handoff',['继续咨询','查看已提交摘要'],'保存成功自动触发后续 Sales 准备；不承诺邮件已发出或销售已在线。'),
('handoff','交给团队跟进','询盘与交接','existing_partial','客户要求人工或服务暂不可用','inquiry_review,welcome',['准备询盘','继续浏览'],'一期是留资和异步跟进；没有在线客服系统时不能显示真人已接入。'),
('source_changed','产品资料已更新','询盘与交接','planned','比较或提交前复查到产品修订','product_results,inquiry_review',['查看最新资料','重新核对询盘'],'用户需求保留；过时价格或下架型号不能沿用为承诺。'),
]
screens=[]
for i,(id,title,group,status,entry,exit,actions,note) in enumerate(rows,1):
 screens.append(dict(id=id,number=i,title=title,group=group,current_status=status,entry=entry,exit=exit.split(','),allowed_actions=actions,interaction_note=note,a11y=['有可见标签和键盘焦点','状态通过 aria-live=polite 简洁播报','操作目标至少44px','长内容在面板内滚动，页面不横向溢出']))
meta=dict(title='Channel 官网智能助手全状态设计',date='2026-10-28',scope='仅设计与本地演示，样例数据，无真实模型、提交或邮件调用',source_ref='origin/main b3d63ac14f0bd1fac700e9b7c403e61076cf1ba4',screen_count=len(screens),status_meanings={'existing_partial':'现有部分代码或外观可复用，不等于端到端验收通过','missing':'当前体验缺口，本次提供目标设计','planned':'已有规划能力，本次提供 screen 设计，尚未实现'},screens=screens)
p.joinpath('screens.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
p.joinpath('screen-data.js').write_text('const SCREEN_MODEL='+json.dumps(meta,ensure_ascii=False)+';\n')
print(len(screens))
