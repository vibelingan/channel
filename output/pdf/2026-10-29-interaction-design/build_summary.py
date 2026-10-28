"""Produce a short handoff alongside the complete screen books."""
from pathlib import Path
import importlib.util
import json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
DESIGN = REPO/'output/design/2026-10-28-assistant-controls'
spec = importlib.util.spec_from_file_location('report_layout', ROOT.parent/'2026-10-28-assistant-review/build_reports.py')
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
para, table, box, section, bullet = layout.para, layout.table, layout.box, layout.section, layout.bullet
NAVY, INK, MUTED, TEAL, LINE = layout.NAVY, layout.INK, layout.MUTED, layout.TEAL, layout.LINE


def page(c, title, subtitle, number):
    w,h=A4
    c.setFillColor(NAVY); c.rect(0,h-13,w,13,fill=1,stroke=0)
    c.setFont('CJKB',9); c.setFillColor(TEAL); c.drawString(38,h-36,'CHANNEL / HERMES · INTERACTION DESIGN')
    y=para(c,title,38,h-52,w-76,20,bold=True,color=NAVY,gap=6)
    y=para(c,subtitle,38,y,w-76,9,color=MUTED,gap=15)
    c.setStrokeColor(LINE);c.line(38,33,w-38,33)
    c.setFont('CJK',8);c.setFillColor(MUTED)
    c.drawString(38,19,'2026-10-29 · 屏幕为设计样例；企微控制尚未接线；未部署')
    c.drawRightString(w-38,19,f'{number} / 6')
    return y


def picture(c,file,x,top,maxw,maxh):
    im=ImageReader(str(DESIGN/file));w,h=im.getSize();s=min(maxw/w,maxh/h)
    c.drawImage(im,x,top-h*s,width=w*s,height=h*s,mask='auto')
    return top-h*s


def main():
    c=canvas.Canvas(str(ROOT/'Agent-Interaction-Design-and-Delivery.pdf'),pagesize=A4)
    c.setTitle('官网客服与企微销售任务交互：设计与交付说明')
    c.setAuthor('Channel / Hermes 项目')
    y=page(c,'这次交付什么，做到哪一步','先看本说明，再按需要打开官网与企微的完整屏幕图册',1)
    y=box(c,'建议：企微保留一个主要入口。正常过程默认静默，只发关键待办和异常；通过卡片或引用选定任务，操作后给明确回执。长讨论按需私聊。',y,kind='done')
    y=table(c,[['产物','状态与边界'],['官网客服 29 个状态','已做可点击样稿；接待、等待、工具、恢复、停止、历史和询盘等。不是线上功能。'],['企微任务交互 18 个场景','已做可点击样稿和图册；含定位、暂停、接管、恢复、私聊、审批版本和异常。不是已接线的机器人。'],['任务控制时序图','展示任务引用、系统权限核对、持久状态和操作回执。'],['源码与官方能力核对','已区分当前适配器、通用会话中断、Sales 控制缺口与官方卡片能力。'],['后台成果归档切片','独立 Hermes 工作区推进；完成状态和实际测试结果另见本轮归档验证记录。未部署。']],y,[151,368],9.4)
    y=section(c,'“job done”和“迭代”怎么理解',y)
    y=para(c,'子 Agent 完成只代表分配给它的一部分结束。最终交付还要汇总、复核、保存材料并说明入口；上一轮主会话中断，统一交付没有收尾。',38,y,519)
    para(c,'“迭代”就是根据检查或意见再改一版。例如先回复“暂停请求已受理”，等后台确认停止点后再回复“已暂停”；它不是另一个服务，也不表示已经上线。',38,y,519)
    c.showPage()

    y=page(c,'企业微信端：人看到什么','卡片和引用负责选任务；后台负责判断是否有权操作',2)
    picture(c,'wecom-card.png',38,y,262,510)
    yy=y
    for title,text in [('一条通知对应一条任务','显示客户、需求摘要、短号、稿件版本、附件和是否已发送。人不需要记技术 ID。'),('点按钮或引用通知','“暂停这条”“先补目的地”都带着任务引用。没有选中任务时先选择，不能猜最近一条。'),('操作一定有回执','明确显示已定位的任务、已受理或已完成、实际状态和下一步。无权或无法定位也要回答。'),('网页按需要打开','日常控制留在企微。检查完整 HTML 和附件时，才打开 Resend 或 Hermes 的已鉴权预览。')]:
        yy=para(c,title,320,yy,237,12,bold=True,color=NAVY,gap=5)
        yy=para(c,text,320,yy,237,10,gap=19)
    para(c,'这是交互设计，不是企业微信实际截图。完整图册逐页展示18个场景；所有示例按钮都不会发送邮件或控制真实任务。',38,165,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'暂停、接管和恢复，必须分清','新 @ 可能打断模型回答；业务任务控制需要单独的系统能力',3)
    y=table(c,[['动作','含义'],['官网停止生成','停止买家当前这一次回答；保留问题和已生成文字，不撤销已提交询盘。'],['暂停销售任务','只暂停定位到的任务；先禁止新动作、撤销旧批准，再记录停止点。'],['人工接管','把该任务后续执行和发送交给人。若此前发送结果未知，先核对再移交。'],['继续准备／交回 Agent','人明确触发；重新核对最新资料、使用新获准运行和新审核版本，旧批准不恢复。'],['取消本任务','终止后续处理并保留记录。含义不清时先区分暂停和取消。']],y,[126,393],9.6)
    y=box(c,'已经提交给邮件服务的请求不能承诺撤回。结果不明时显示“正在核对，请勿重复发送”，而不是立即给出“接管完成”。',y,kind='plan')
    y=section(c,'一条询盘的具体例子',y)
    for text in ['销售引用 Q-1042 的通知说“暂停这条”。系统认证该销售，只锁定 Q-1042；另外49条任务继续。','先回“已受理，正在停止”；保存停止点后回“Q-1042已暂停，稿件v3保留”。','销售引用同一任务说“继续准备”。系统重新检查资料与授权，准备新版本；没有重新批准就不发送。']:
        y=bullet(c,text,y)
    c.showPage()

    y=page(c,'既要有回应，也要控制群消息量','状态记录、通知和操作回执分开；不需要一个额外模型持续播报',4)
    y=table(c,[['类型','默认策略'],['普通运行过程','排队、检索、生成、心跳、普通重试留后台；群里不逐条广播。'],['需要人的任务','待审阅、缺资料按负责人合并待办；有权限与送达条件时用私聊。'],['重要异常','授权失败、长时间阻塞、发送结果不明及时通知；去重后升级负责人。'],['人的主动操作','每次给简短、准确的回执；不能为了安静而不回复人。'],['详细讨论','按需在机器人私聊继续，始终显示任务对象；群里只同步结果。']],y,[122,397],9.5)
    y=section(c,'50 条询盘时，为什么只换一个群不够',y)
    y=para(c,'假设每条6个内部阶段，就是300条状态消息。新建一个状态群仍然是300条。若每10个待审任务合成一个摘要，则是5条待办摘要；这只是通知设计估算，50次必要审核并不会消失，操作回执和异常另计。',38,y,519)
    y=section(c,'第一期的选择',y)
    y=para(c,'默认一个主要工作入口，必要时设一个“销售待办”群。无需另开 worklog 群，更不默认每任务一个群。程序发标准通知可以沿用同一机器人身份，不必另起会思考的告警 Agent。',38,y,519)
    para(c,'私聊是可选的详细讨论空间。企微没有本方案假设的群线程；也不能保证点击后能自动带任务打开私聊。接入不支持时，让用户主动私聊并带任务短引用，或继续简短的有任务标识对话。',38,y,519)
    c.showPage()

    y=page(c,'官网客服：29个状态一起设计','沿用当前官网深蓝、黄色强调与助手面板；没有重做网站风格',5)
    y=table(c,[['工作流','本轮设计覆盖'],['接待与提问','入口收起、欢迎、输入、请求已受理、等待与检索。'],['回答与工具','生成中、工具进度、知识回答、产品结果、对比、澄清、没有匹配结果及能力边界。'],['异常与恢复','网络失败、可恢复重试、超时提示、停止受理、已停止、停止后重新请求。'],['会话与历史','历史恢复、凭据过期、新会话提示；关闭界面不暗示取消任务。'],['正式询盘','整理需求、确认表单、提交中、提交失败保留输入、提交成功和人工入口。']],y,[116,403],9.7)
    y=box(c,'官网买家确认提交之后，才进入 Channel 正式询盘和 Hermes Sales 流程。未提交聊天不自动变成销售任务；提交成功也不代表跟进邮件已经发送。',y,kind='done')
    y=section(c,'屏幕检查不能代替功能验收',y)
    y=para(c,'原型使用样例数据演示布局和点击路径，没有调用真实模型、产品接口、询盘提交或邮件服务。卡片能点、状态能切换，只证明设计稿可浏览；真实问答可用性、身份、工具与提交仍要在实施时验证。',38,y,519)
    para(c,'停止当前回答与暂停销售任务分开设计。前者作用于当前回答，后者作用于被明确定位的独立任务，不能共用一个模糊的“停止”含义。',38,y,519)
    c.showPage()

    y=page(c,'当前 Hermes 有什么，还没有什么','源码与线上部署分开；本轮没有向企微群发送消息或启用真实邮件',6)
    y=table(c,[['现状','核对结论'],['通用会话中断','有同会话忙时 interrupt/queue/steer。它不是持久业务任务的暂停、撤权或接管。'],['引用定位','当前适配器只有引用文字，quote字段使用本次消息ID。不能当作可靠原通知ID。'],['卡片与按钮','官方智能机器人SDK支持；现有适配器尚未把卡片事件接入Sales控制。'],['Sales控制入口','还没有销售人员暂停、恢复、接管或批准接口；状态字段和读取拒绝能力不等于按钮已交付。'],['已有产品门户','当前检出可读的是静态Portal和Python API。客户码token不足以识别具体批准人。']],y,[122,397],9.5)
    y=section(c,'落地时不能省掉的系统规则',y)
    for text in ['通知和按钮引用在服务器登记，仍须检查客户、群、人员角色与任务归属。复制短号不会获得权限。','暂停定位当前同一任务；批准发送必须绑定最新收件人、发件人、正文、附件和版本。模型只提出动作，不负责放行。','普通询问和新 @ 不应取消后台业务任务。100条任务并行、旧卡片、重复命令及发送结果不明都要有针对性验收。']:
        y=bullet(c,text,y)
    y=para(c,'官方依据：WecomTeam/aibot-node-sdk 的 message.ts、event.ts、client.ts。完整源码版本、行号和限制见 wecom-source-audit.md；本轮未核对线上机器人实际部署。',38,y,519,9,color=MUTED)
    para(c,'交付入口：assistant-ui.html（官网29状态）、wecom-controls.html（企微18场景）、task-control-flow.html（控制时序），以及两本屏幕PDF。所有产物的核对与代码进度以同目录README和本轮归档验证报告为准。',38,y,519,9,color=MUTED)
    c.save()
    print(ROOT/'Agent-Interaction-Design-and-Delivery.pdf')


if __name__=='__main__':
    main()
