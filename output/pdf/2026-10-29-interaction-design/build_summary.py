"""Produce a short handoff alongside the complete screen books."""
from pathlib import Path
import importlib.util
import json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
DESIGN = REPO/'output/design/2026-10-29-wecom-mvp-v2'
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
    c.drawString(38,19,'2026-10-29 · V2：第一期不做暂停/恢复/接管；交互为样例，尚未接线')
    c.drawRightString(w-38,19,f'{number} / 6')
    return y


def picture(c,file,x,top,maxw,maxh):
    im=ImageReader(str(DESIGN/file));w,h=im.getSize();s=min(maxw/w,maxh/h)
    c.drawImage(im,x,top-h*s,width=w*s,height=h*s,mask='auto')
    return top-h*s


def main():
    c=canvas.Canvas(str(ROOT/'Agent-Interaction-Design-and-Delivery.pdf'),pagesize=A4)
    c.setTitle('Agent interaction design and delivery · V2 · 第一期范围')
    c.setAuthor('Channel / Hermes 项目')
    y=page(c,'第一期先跑通准备、审稿与发送','按2026-10-29最新决定更新；旧版完整控制设计继续保留',1)
    y=box(c,'第一期不实现销售任务暂停、恢复、人工接管或主动终止入口。\n保留这些功能的后续交互样稿，默认MVP模式不显示其操作。',y,kind='plan',size=12)
    y=section(c,'第一期要完成的业务闭环',y)
    for text in ['客户确认提交询盘，Channel保存业务事实，自动产生独立销售准备任务。','Agent读取获准资料，准备需求摘要、邮件正文和必要附件，固定成果版本。','企微通知只显示关键待办。销售查看标为“企微摘要预览”的内容，需要时打开完整邮件。','销售在同一群引用任务讨论或改稿；新稿保留版本，再由人明确批准具体收件人与内容。','发送服务按固定版本执行，记录受理、投递、失败或结果未知；重试不能重复发信。']:
        y=bullet(c,text,y)
    y=section(c,'本轮交付与开发分开',y)
    y=table(c,[['范围','本轮结果'],['企微交互','V2独立HTML，可连续体验每个按钮的后续画面；没有接真实机器人。'],['交付说明','本PDF更新第一期与后续功能范围；不再把暂停/接管列为本期必做。'],['基础开发','继续SG3.1销售准备规则、结构化结果与离线程序校验；不实施交互控制。'],['保留材料','官网29状态及旧企微18场景保留，旧完整控制流程作为历史/后续设计。']],y,[115,404],9.5)
    para(c,'第一期缩小范围不等于现在已可上线。来源核验、模型工具接线、邮件与操作者权限仍按模块逐项完成和验收。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'企业微信能显示什么','原生卡片与网页CSS是两种显示机制；本轮查的是公开官方协议',2)
    y=table(c,[['接入','能做的事与限制'],['群Webhook','支持文字、Markdown、图片、文件和规定的展示卡片等。主要用于推送；不能单靠它接收销售的按钮操作。'],['智能机器人长连接','当前Hermes使用的方向。官方SDK有原生交互卡片、按钮事件、任务标识及媒体消息；现有适配器尚未接Sales按钮。'],['自建应用','某些图文消息详情允许HTML，部分文字卡片只支持有限标签；不能套成群Webhook可渲染任意邮件HTML。'],['按钮外观','只能选择平台支持的卡片结构与样式。样稿的外部布局和CSS不代表企微客户端可完全复现。'],['完整邮件','HTML/CSS、内嵌CID图片和邮件附件不自动变成群消息。需要转换摘要或按需查看原邮件。']],y,[112,407],9.5)
    y=box(c,'可以做“查看、改稿、确认发送”等原生操作，但必须按实际机器人协议接线。不能向Webhook拼一段任意HTML，就当作整封邮件和自定义按钮已经可用。',y,kind='existing')
    y=section(c,'本轮验证的边界',y)
    y=para(c,'已核对企业微信官方公开文档与WecomTeam SDK；没有发送真实业务群消息、读取Webhook密钥或登录客户邮箱。HTML原型证明的是设计可体验，不能替代真实客户端外观与按钮回调验收。',38,y,519)
    para(c,'官方来源：developer.work.weixin.qq.com/document/path/91770、/90236；WecomTeam/aibot-node-sdk 的api、message、event及client定义。完整来源和本地样例见V2目录的WECom-CAPABILITIES.md。',38,y,519,9,color=MUTED)
    c.showPage()

    y=page(c,'邮件预览：简单邮件留在群里核对','正文、HTML版式与附件分开说明，不能把摘要当完整邮件',3)
    y=table(c,[['邮件情况','默认交互'],['纯文字、无附件','群内展示完整正文及收发件人、主题和版本。确认没有截断后，可以在企微核对并批准。'],['HTML版式或图片','展示可读文字摘要，说明未展示的图片/版式；完整邮件在外部工作台示意中查看。'],['带附件','列出名称、数量和大小等已知信息，明确群内没有预览附件。按需打开完整邮件/附件检查。'],['正文截断或资料缺失','明确标注缺少部分；不能把摘要批准当成对缺失内容的审核。'],['查看原邮件后返回','回到原任务和原版本，保留尚未提交的意见；查看动作本身不表示已经批准发送。']],y,[124,395],9.5)
    y=section(c,'一个预览消息至少包含',y)
    y=box(c,'【企微摘要预览 · 尚未发送】\n任务Q-1042 / 稿件v3 / 明确的发件人与收件人 / 主题\n正文摘要……\n附件2个：产品规格.pdf、采购方案.pdf；此处未预览\n完整HTML与附件请打开邮件工作台查看。',y,kind='existing')
    y=para(c,'图片和文件可以作为独立企微消息发送，但第一期不默认把所有邮件附件复制进群。这样可减少噪音，也不把私人附件的存储地址暴露到群中。',38,y,519)
    para(c,'完整查看页面是明确标注的外部平台示意，未伪造客户真实Resend页面、登录状态或草稿直达链接。正式接入优先复用已有登录和授权。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'每个按钮点完，下一步是什么','新版HTML按连续旅程演示，不只是在目录里切换静态状态',4)
    y=table(c,[['操作','后续界面与返回路径'],['查看邮件','同群出现摘要预览，标明任务/版本、完整性与附件清单。'],['查看完整邮件','进入“外部邮件工作台示意”，可检查HTML和附件，再返回同一任务。'],['改稿','机器人先在原群回复带任务短号的提示；用户手动引用后输入意见，发送后收到回执，完成后展示新版和修改要点。'],['讨论问题','同群引用并提问，助手解释或给建议；没有明确改稿要求时不生成新版本。'],['直接引用通知@机器人','进入同一任务的讨论上下文；对象不清时先选择，不要求必须点按钮。'],['返回检查','回到当前稿件预览，不丢任务定位；不会暗中发送。'],['确认发送','显示当前收发件人、主题、正文/附件版本和审核状态，明确确认后才进入发送中。'],['发送中／结果未知','区分提交与投递。结果未知先核对，不提供会重复发信的盲目重跑。'],['任务切换／旧卡片','A/B任务不混上下文；旧v3不能批准新v4。改稿或相关新来信使旧批准失效。']],y,[115,404],9.4)
    y=para(c,'第一期默认同群引用讨论，不突然另开群或私聊。需要私聊时明确说明用户如何主动进入，并携带任务引用；没有虚构企微群线程。',38,y,519)
    para(c,'无按钮的备选路径同样保留：引用通知后说“查看邮件”“修改这条”“批准发送这一版”。模型只解析意图；任务、个人权限和版本仍由后端确定。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'短任务先用运行上限，控制功能后置','10–15分钟是用户描述的典型预期，不是已验证的运行时长承诺',5)
    y=box(c,'暂停、恢复、接管的交互设计仍可在“后续设计”模式体验。它们不进入本期产品实现与上线验收门槛。',y,kind='plan')
    y=table(c,[['第一期需要的保护','实际含义'],['最长运行时间','由宿主限制单次运行时长，超限停止新步骤并记录失败；不能让模型自行延长。'],['次数和费用预算','限制模型/工具调用、重试、token或费用，以及单客户并发和队列。'],['有界重试','只有可重试且安全的准备步骤重跑，保留来源、失败原因和旧成果。'],['发送结果核对','邮件超时不等于未发出。先查发送账/provider结果，不整任务重跑后再发一遍。'],['运维兜底','运行宿主需要受权的禁用/停止路径；这不等于已交付销售任务暂停与接管UI。']],y,[120,399],9.6)
    y=section(c,'引用一句“终止”是否就够',y)
    y=para(c,'可以作为未来的操作入口，但仍需可靠定位任务、核对人员权限、向正确运行发取消信号，并确认实际结果。当前通用会话中断不等于这套业务终止能力，不能只靠模型回“好的”保证停止消耗。',38,y,519)
    para(c,'真实模型循环尚未接入，本轮不会把上述运行上限说成生产已经生效。下一阶段接执行宿主时必须落实，不为减少交互范围删掉安全门禁。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'代码也继续推进：销售准备基础','SG3.1不依赖企微暂停/接管，也不等待这些屏幕实现',6)
    y=table(c,[['模块','当前范围'],['已经有的基础','客户/任务读取门禁、持久接入和成果归档切片已有代码；仍未上线。'],['本轮SG3.1','Sales岗位规则、内部结构化结果schema、确定性校验和离线样例；复用既有询盘/邮件合同及归档清单。'],['程序核对','区分原文事实、推断、缺项、获准产品依据与结构化商务数字。错误客户/业务/资料引用、无依据报价不放行。'],['程序不能证明的事','schema与字段核对不能证明自由正文完全无幻觉，不能证明商业文案已被客户接受。人工内容审核仍必需。'],['仍待下一步','来源核验/短期授权签发、实际模型工具循环、邮件草稿/回调、个人身份和受控发送。']],y,[116,403],9.5)
    y=section(c,'本轮代码验证',y)
    y=para(c,'SG3.1实现提交5b76452已推送，23项针对性测试和8个离线样例通过；Hub为95通过/33明确跳过，dispatcher为33通过。对应实现提交的Sales runtime 40802563126远端检查成功；仍未部署或连接真实模型/邮件。',38,y,519,9.6)
    y=section(c,'验收与交付位置',y)
    y=para(c,'V2交互HTML、平台能力核对和原型检查在output/design/2026-10-29-wecom-mvp-v2/。旧版屏幕集继续保留；官网29状态本轮未重新实施。SG3.1代码、review、测试与对应提交的远端结果见本轮开发交接，不用设计稿或旧提交的CI代替。',38,y,519)
    y=para(c,'本轮不修改其他Agent、官网运行组件、价格/SEO代码或线上群配置。设计与基础开发分别记录：样稿可点击不等于真实机器人已接线，代码测试通过不等于已部署或真实邮件验收。',38,y,519)
    para(c,'同一封邮件第一期默认一个发送通路：精确批准后由发送网关执行。外部平台用于完整查看；原生手动编辑/已发送一旦被系统观察到，旧批准失效并对账。未被观察到的原生操作仍有竞争边界，不宣称全局恰好一次。',38,y,519,9.5,color=MUTED)
    c.save()
    print(ROOT/'Agent-Interaction-Design-and-Delivery.pdf')


if __name__=='__main__':
    main()
