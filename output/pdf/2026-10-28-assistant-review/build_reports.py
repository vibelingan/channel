from pathlib import Path
from math import atan2, cos, sin, pi
from xml.sax.saxutils import escape
import json

from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
pdfmetrics.registerFont(TTFont('CJK', '/System/Library/Fonts/STHeiti Light.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('CJKB', '/System/Library/Fonts/STHeiti Medium.ttc', subfontIndex=0))
NAVY = colors.HexColor('#101633')
INK = colors.HexColor('#24334b')
MUTED = colors.HexColor('#65748a')
LINE = colors.HexColor('#dce3ec')
LIGHT = colors.HexColor('#f3f6fa')
TEAL = colors.HexColor('#087f75')
AMBER = colors.HexColor('#986000')
RED = colors.HexColor('#b13d38')
TINTS = {'done': '#e7f5f0', 'plan': '#fff3d9', 'existing': '#edf1f7', 'issue': '#ffefeb'}


def para(c, text, x, top, width, size=10.6, leading=None, color=INK, bold=False, gap=8):
    st = ParagraphStyle('p', fontName='CJKB' if bold else 'CJK', fontSize=size,
                        leading=leading or size * 1.55, textColor=color, wordWrap='CJK',
                        splitLongWords=True, spaceAfter=0)
    p = Paragraph(text.replace('\n', '<br/>'), st)
    _, h = p.wrap(width, 1200)
    if top - h < 32:
        raise ValueError(f'Page overflow: {text[:70]} at {top}, height {h}')
    p.drawOn(c, x, top - h)
    return top - h - gap


def page(c, title, subtitle, n, total, wide=False):
    w, h = landscape(A4) if wide else A4
    c.setFillColor(NAVY)
    c.rect(0, h - 14, w, 14, fill=1, stroke=0)
    c.setFillColor(TEAL)
    c.setFont('CJKB', 9)
    c.drawString(38, h - 36, 'CHANNEL / AI DELIVERY REVIEW')
    y = para(c, title, 38, h - 52, w - 76, 21 if wide else 20, bold=True, color=NAVY, gap=5)
    y = para(c, subtitle, 38, y, w - 76, 8.8, color=MUTED, gap=13)
    c.setStrokeColor(LINE)
    c.line(38, 33, w - 38, 33)
    c.setFont('CJK', 8)
    c.setFillColor(MUTED)
    c.drawString(38, 19, '2026-10-28  /  源码、实测与规划分开记录  /  尚未执行本轮产品修复')
    c.drawRightString(w - 38, 19, f'{n} / {total}')
    return y


def section(c, text, y, width=519):
    return para(c, text, 38, y, width, 13, bold=True, color=NAVY, gap=7)


def box(c, text, y, width=519, kind='existing', size=10.8):
    st = ParagraphStyle('b', fontName='CJK', fontSize=size, leading=size*1.55, wordWrap='CJK')
    p = Paragraph(text.replace('\n', '<br/>'), st)
    _, h = p.wrap(width - 28, 1000)
    height = h + 24
    c.setFillColor(colors.HexColor(TINTS[kind]))
    c.roundRect(38, y-height, width, height, 8, fill=1, stroke=0)
    c.setFillColor({'done': TEAL, 'plan': AMBER, 'issue': RED, 'existing': MUTED}[kind])
    c.roundRect(38, y-height, 4, height, 2, fill=1, stroke=0)
    p.drawOn(c, 52, y-height+12)
    return y-height-14


def table(c, rows, y, widths, fontsize=9.3):
    cells=[]
    for i, row in enumerate(rows):
        st=ParagraphStyle('cell', fontName='CJKB' if i==0 else 'CJK', fontSize=fontsize,
                          leading=fontsize*1.45, wordWrap='CJK',
                          textColor=colors.white if i==0 else INK)
        cells.append([Paragraph(str(t).replace('\n','<br/>'), st) for t in row])
    t=Table(cells, colWidths=widths, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),NAVY),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,LIGHT]),
        ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),
        ('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),
        ('BOTTOMPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,0),.5,LINE),
        ('LINEBELOW',(0,1),(-1,-1),.3,LINE),
    ]))
    _, height=t.wrap(sum(widths),1000)
    if y-height<40: raise ValueError(f'Table overflow: {height}, top={y}')
    t.drawOn(c,38,y-height)
    return y-height-13


def bullet(c, text, y, width=519):
    c.setFillColor(TEAL)
    c.circle(42, y-6, 2, fill=1, stroke=0)
    return para(c,text,53,y,width-15,10.5,gap=9)


def report():
    path=ROOT/'Channel-Assistant-Status-2026-10-28.pdf'
    c=canvas.Canvas(str(path),pagesize=A4)
    c.setTitle('Channel 官网智能客服开发现状与下一步 - 2026-10-28')
    c.setAuthor('Channel 项目调查')
    y=page(c,'官网智能客服：现在能做什么','给项目负责人的核对报告 | 代码核对、线上烟测、UI 覆盖和落地顺序',1,7)
    y=box(c,'当前仍是 Phase 1 的受限知识问答，尚未升级为会搜产品、比较和准备询盘的完整客服。\n本轮两个基础公司 / OEM 问题均未得到答案，先后进入不可用状态；应先恢复可用性与明确反馈。',y,kind='issue',size=11.4)
    y=section(c,'四个直接结论',y)
    for text in [
        '“答不了也要回应”应由产品和系统保证。缺知识、超时和故障需要不同反馈，不能让买家面对空白等待。',
        '多步工具调用、产品卡片、比较、询盘预填已经有 Phase 2 设计；主要能力尚未实现和合并。PR #59 仍为 OPEN。',
        '基础聊天面板、引用、Stop 和故障表单入口已有代码；完整的等待、恢复、历史、产品与操作状态 UI 还没做好。',
        '公开网页检索可以作为受控工具考虑。模型负责判断何时需要查，系统负责限制来源、资料和动作权限。',
    ]: y=bullet(c,text,y)
    y=section(c,'当前能力快照',y)
    y=table(c,[
        ['能力','当前结论'],
        ['公司 / OEM 知识问答','代码和历史部署已有；本轮基础问答失败，不能称当前可用性已验收。'],
        ['实时产品检索 / 模糊选品','官网助手尚未接入；不能把网站有商品等同于助手能查目录。'],
        ['循环调用工具 / 自定义动作','已规划受限工具循环；当前运行默认工具次数为 0。'],
        ['公开网页搜索 / 浏览','未接入。在线模型与知识库调用不等于公开网页检索。'],
        ['正式询盘后的 Sales 自动化','另一个工作流，近期完成权限与持久任务查询；未上线，尚未接完来源签发与生成发送。'],
    ],y,[138,381])
    para(c,'本轮是调查和材料交付，没有修改产品代码、合并他人分支或开启线上功能。',38,y,519,9.4,color=MUTED)
    c.showPage()

    y=page(c,'线上实测：等待和失败都不够清楚','实测日期 2026-10-28，以下是实际页面，不是产品原型',2,7)
    y=para(c,'在 apex 和 www 两个入口各问一个基础问题。www 提交约 51 秒后复查，仍只有问题气泡，输入框禁用，没有明确进度。后续复查已进入不可用状态。本轮 2 个烟测不能当作模型准确率统计。',38,y,519)
    tops=y-8
    captions=[('live-ready-panel.jpg','初始状态','刷新重开后只显示欢迎语，上一轮可见消息没有恢复。'),('www-waiting-panel.jpg','等待状态','Do you offer OEM services?\n17:20:38 JST 提交；17:21:29 复查仍无回答。'),('live-unavailable-panel.jpg','故障状态','最终只给“服务不可用”和原询盘入口；输入区被替换。')]
    widths=158
    for i,(file,title,caption) in enumerate(captions):
        x=38+i*180
        reader=ImageReader(str(ROOT/'screenshots'/file)); iw,ih=reader.getSize()
        dh=widths*ih/iw
        c.drawImage(reader,x,tops-dh,width=widths,height=dh,mask='auto')
        q=para(c,title,x,tops-dh-8,widths,11,bold=True,gap=4)
        para(c,caption,x,q,widths,8.7,leading=12.8)
    y=tops-350
    y=section(c,'接口与证据',y)
    y=table(c,[
        ['核对项','本次观察'],
        ['实际前端资源','AssistantWidget.PvdNAv7f.js，仍含旧版通用不可用提示。'],
        ['服务进程健康','实际 bundle 中的 BFF 地址 /api/ai/healthz 返回 200。'],
        ['服务就绪','同一 BFF 的 /api/ai/readyz 在约 10.9 秒探测内未返回。'],
    ],y,[138,381])
    para(c,'结论限于这次观察：服务进程活着不代表能正常回答。没有进入私网排查，不能据此断言数据库、网络或模型哪一层是最终根因；也没有成功的知识库外问题实测可作为拒答验收。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'UI 状态：有基础面板，完整体验未完工','“源码存在”“本次实测”“PR 待合并”“仅规划”分别标明',3,7)
    y=table(c,[
        ['状态 / 屏幕','当前状态','判断'],
        ['欢迎、输入、打开关闭','源码已有，线上可见','基础面板成立。'],
        ['提交中 / 排队中','反馈不足，已复现','busy 会禁用输入，但提交阶段没有清楚的进度和应用层截止。'],
        ['正在查来源 / 生成中','旧版仅有省略号；PR 有改进','PR #59 增加 Checking approved sources，尚未合并；也不能单独解决提交阶段等待。'],
        ['正常回答、引用链接','源码已有','本轮没有成功答案，不写成线上成功验收。'],
        ['缺知识 / 无依据','通用失败处理','knowledge_empty 等错误会把 UI 设为 unavailable；缺少友好澄清和继续问的路径。'],
        ['服务失败','源码已有，线上复现','显示项目表单链接；没有形成清楚的重试和保留问题体验。'],
        ['Stop / 取消','源码已有，范围有限','只有进入 streaming 后出现；提交网络阶段没有同等的取消能力。'],
        ['刷新 / 跨页面恢复历史','未完成','页面重开消息数组为空，key 存在不等于历史已画出来。'],
        ['产品卡片 / 对比表','Phase 2 规划','Stage C6，没有在官网完成。'],
        ['“这个产品”页面上下文','Phase 2 规划','A5 / C7，不能只改提示词代替页面和产品身份接线。'],
        ['询盘预填 / 客户确认','Phase 2 规划','Stage D；原表单可复用，但聊天尚未联动。'],
        ['真人排队 / 接管 / 退回 AI','后续设计','没有现成的完整访客与运营界面。'],
        ['网页检索 / 工具执行状态','未接入','需同时有工具后端、结构化事件与 UI。'],
    ],y,[110,135,274],fontsize=8.8)
    para(c,'现有 AssistantWidget 单测主要检查自动滚动等源码结构，不足以证明全套聊天状态和客户旅程都已验收。',38,y,519,9.4,color=MUTED)
    c.showPage()

    y=page(c,'“更聪明、能做事”的设计到哪了','Phase 2 目标明确；当前 PR 主要是修上下文、回答归属和等待展示',4,7)
    y=box(c,'受限工具循环已经在 PLAN / ADR-003 里：模型提出查询，服务器执行固定工具，把结果交回模型，最多 4 次调用；再验证事实和渲染 UI。官网当前没有这条执行链。',y,kind='plan')
    y=table(c,[
        ['动作','现有可复用能力','助手接线状态'],
        ['搜索与推荐产品','匿名公开产品 API、已有目录','Phase 2 B / C 待实现。'],
        ['读取详情、比较方案','产品批准详情和现有产品页','详情工具、卡片、比较块待实现。'],
        ['继续追问缺少的需求','模型理解＋会话上下文','要修上下文，再加受控的需求事实和澄清行为。'],
        ['准备询盘 / 报价申请','现有 OEM / 单品询盘表单','只预填需求，买家确认提交；聊天联动待实现。'],
        ['发送邮件 / 承诺价格','后续 Sales 与审批发送模块','不属于当前官网助手权限，不能从聊天直接越过。'],
    ],y,[112,172,235])
    y=section(c,'两处会直接影响体感的旧实现',y)
    y=bullet(c,'worker 先把整段回答留在服务器，直到最终引用检查通过才发布，所以并不是即时逐字输出。Stage X 才计划“先检索来源、再真正流式生成”。',y)
    y=bullet(c,'当前主干上下文查询仍取最早 30 条，再组装模型上下文；长对话可能丢掉最新问题。PR #59 已包含相关修复，但仍未合并。该项是源码发现，不是本轮长对话复现。',y)
    y=section(c,'自定义动作的实际含义',y)
    para(c,'现有规划允许扩展一组由服务器登记、限制参数和权限的工具，尚不是一个已交付的“后台任意配置动作”平台。先做搜产品、看详情、比较和预填这类低风险动作；正式提交、发送和商业承诺仍走明确确认。',38,y,519)
    c.showPage()

    y=page(c,'联网可以做，但要分清事实归属','建议方案，尚未作为已实现功能或已批准技术变更',5,7)
    y=para(c,'模型可以判断当前问题需不需要外部信息。系统应决定能访问哪些工具和来源，不能把外部网页里的指令变成执行权限。官网后端目前已经通过网络调用模型和知识库；缺少的是公开网页检索 / 浏览工具。',38,y,519)
    y=table(c,[
        ['信息类型','建议来源与规则'],
        ['本公司产品、MOQ、参考价、认证','以本网站批准产品数据和公司知识为准；提交或审核前实时复核，保留实际依据。'],
        ['行业常识、公开趋势、术语','可通过受控只读网页检索补充，标为外部参考，给出来源与时间，不把它说成公司的承诺。'],
        ['问候、澄清、说明能力边界','可以自然回应或用可靠模板，不应因为没有一条商业来源就变成“机器人不可用”。'],
    ],y,[172,347])
    y=section(c,'落地时应保留的系统规则',y)
    for text in [
        '工具地址、凭据和客户身份由服务器固定；模型只提供受限的查询参数，不直接拿 DB、邮箱或任意 URL 抓取权限。',
        '对外查询不携带买家的邮箱、联系方式或整段私有对话；外部内容作为资料，不能覆盖系统授权规则。',
        '网页结果与公司事实分开显示；无可靠来源就说明无法确认，再给澄清、产品页或联系销售的下一步。',
        '设置调用次数、时长和成本上限；工具失败有可理解的反馈，不能回退为无约束瞎答。',
    ]:y=bullet(c,text,y)
    y=box(c,'建议先解决服务可用、等待和恢复，再接实时产品工具。外部网页检索可以作为后续独立能力，不需要为此推翻整个客服或取消现有安全门禁。',y,kind='done')
    para(c,'依据：Anthropic 的工具与工作流模式支持按任务组合检索和工具；OWASP 指出外部内容可能携带间接提示注入，应由程序限制权限并验证结果。参考链接见最后一页。',38,y,519,9.1,color=MUTED)
    c.showPage()

    y=page(c,'官网助手与 Hermes Sales 怎么衔接','两条职责连续协作，不能把后台授权进度当成前端智能升级',6,7)
    y=table(c,[
        ['部分','负责什么','当前进度'],
        ['官网智能客服','接待、澄清、公开产品查询、准备询盘','Phase 1 有限问答；Phase 2 工具和 UI 未落地。'],
        ['Channel 正式询盘','保存 OEM / 单品 / 客服确认提交的业务事实','已有表单和记录；统一可靠交接、完成核验及授权签发待补。'],
        ['Hermes Sales 运行与控制','任务接收、客户边界、当前任务读取许可','SG2.4 已完成数据库控制查询及本地 / CI 验证；未上线。'],
        ['Sales 内容与 Resend','研究需求、草稿、附件、联系人 / 邮件工具','自动准备、草稿和受控发送完整闭环仍未接完。'],
        ['人：企微 / 网页审批','改稿、批准、暂停、接管','目标入口已讨论；具体身份、控制和发送 UI 属后续模块。'],
    ],y,[108,192,219])
    y=section(c,'仍然保留的业务顺序',y)
    for text in [
        '普通咨询先回答和澄清。型号没定但有采购意图也可引导，不能只以“选定一个产品”为线索门槛。',
        '买家明确确认提交必要信息后才成为正式询盘。三个官网入口统一交接，不要求销售再下“开始处理”的指令。',
        '服务器自动核验来源和签发 task/run 授权；Sales 再读取资料、生成邮件和附件，通知人审核。',
        '官网询盘和主动陌生获客分开。Resend 承载询盘邮件 / 维护，Apollo 对应主动开发；共用底座不代表混用报价或模板。',
        '批准绑定任务、收件人及内容附件版本；改稿、来信、暂停会使旧批准失效。最终发送能力还要独立实现和验收。',
    ]:y=bullet(c,text,y)
    para(c,'注意：Phase 2 的旧 Stage E 曾建议 IMAP / SMTP 邮件方案；后续讨论已转为复用 Resend 与 Hermes Sales。不能把旧邮件方案和新方案并行各做一套。',38,y,519,9.5,color=MUTED)
    c.showPage()

    y=page(c,'建议下一轮先验收什么','工程建议，未在本轮改代码或执行上线',7,7)
    y=table(c,[
        ['顺序','先交付的结果','验收要点'],
        ['P0 可用性与反馈','定位 BFF / DB / worker / KB 当前故障；提交即有状态，截止、取消、重试和降级清楚','每个问题都有回答、澄清、拒答或可重试故障之一；无静默卡住，保留问题。'],
        ['P1 已有修复和会话','复核 PR #59 并补足缺口，不盲目整体合并；修近期上下文、回答归属、历史恢复','短问、长对话、刷新、关闭重开、错误后继续问都能走通。'],
        ['P2 产品与工具','复用公开产品 API / 批准详情，接有限循环、卡片、比较和询盘预填','模糊采购→澄清→找产品→比较→客户确认提交，数字不由模型编。'],
        ['P3 外部检索与后台闭环','受控网页工具；独立推进 Channel 来源签发和 Hermes Sales / Resend 审核发送','外部资料清楚标注；跨客户、暂停、旧批准和重复发送测试通过后再启用。'],
    ],y,[86,214,219],fontsize=9.2)
    y=section(c,'本次核对依据',y)
    refs=[
        ('主干代码 b3d63ac1','https://github.com/vibelingan/channel/tree/b3d63ac14f0bd1fac700e9b7c403e61076cf1ba4'),
        ('Phase 2 PR #59（OPEN，a7e16aa2）','https://github.com/vibelingan/channel/pull/59'),
        ('Phase 2 PLAN / SPEC / TECH-REVIEW / ADR-003','https://github.com/vibelingan/channel/blob/a7e16aa2c89792cbb3fe49f9330848aea0b05405/docs/ai-assistant-phase2/PLAN.md'),
        ('Hermes SG2.4 对应代码 CI','https://github.com/vibelingan/hermesinfra/actions/runs/40643073628'),
        ('Anthropic：Building effective agents','https://www.anthropic.com/research/building-effective-agents'),
        ('OWASP：Prompt Injection','https://genai.owasp.org/llmrisk/llm01-prompt-injection/'),
    ]
    for label,url in refs:y=para(c,f'<link href="{url}" color="#087f75">{escape(label)}</link>',38,y,519,9.5,gap=6)
    y=para(c,'同时读取：主干 AssistantWidget、BFF、worker、上下文查询、grounding policy；Phase 2 交付与客户答复；当前 Sales 计划与 SG2.4 记录。实际页面与静态资源检查、健康探测记录随材料保存。',38,y-4,519,9.3,color=MUTED)
    para(c,'证据边界：未读取生产私网日志、知识库最新文档清单或客户账号配置。主干 SHA 不等同于线上后端发布 SHA。旧文档的“5 份资料 / 128 件产品”等数字只是历史快照，本报告不把它们当作今天的盘点。',38,y,519,9.3,color=MUTED)
    c.save()
    return path


def node(c,x,y,w,h,title,body,status,kind='plan'):
    c.setFillColor(colors.HexColor(TINTS[kind]));c.setStrokeColor(LINE)
    c.roundRect(x,y,w,h,9,fill=1,stroke=1)
    top=para(c,title,x+12,y+h-13,w-24,11.2,bold=True,color=NAVY,gap=6)
    bottom=para(c,body,x+12,top,w-24,9.3,leading=14,gap=0)
    if bottom<y+25:raise ValueError('Node overflow '+title)
    c.setFont('CJK',8);c.setFillColor({'plan':AMBER,'done':TEAL,'issue':RED,'existing':MUTED}[kind])
    c.drawString(x+12,y+11,status)


def arrow(c,points,color=TEAL,dashed=False):
    c.setStrokeColor(color);c.setFillColor(color);c.setLineWidth(1.45)
    c.setDash(4,3) if dashed else c.setDash()
    p=c.beginPath();p.moveTo(*points[0])
    for pt in points[1:]:p.lineTo(*pt)
    c.drawPath(p)
    a,b=points[-2],points[-1];ang=atan2(b[1]-a[1],b[0]-a[0]);s=7
    p=c.beginPath();p.moveTo(*b)
    p.lineTo(b[0]-s*cos(ang-.42),b[1]-s*sin(ang-.42))
    p.lineTo(b[0]-s*cos(ang+.42),b[1]-s*sin(ang+.42));p.close()
    c.drawPath(p,fill=1,stroke=0);c.setDash()


def note(c,text,y=85):
    c.setFillColor(LIGHT);c.roundRect(38,y-37,766,42,6,fill=1,stroke=0)
    para(c,text,49,y-4,744,9.1,leading=13,gap=0)


def flows():
    path=ROOT/'Channel-Agent-Flows-2026-10-28.pdf'
    c=canvas.Canvas(str(path),pagesize=landscape(A4))
    c.setTitle('Channel 官网助手与销售 Agent 流程图 - 2026-10-28')
    c.setAuthor('Channel 项目调查')
    page(c,'01  今天的官网问答链路','现有代码与历史部署结构；本轮基础问题失败，不表示该链路当前可用性已验收',1,6,True)
    xs=[38,235,432,629];w=175;h=115;ty=350;by=155
    top=[('访客聊天面板','输入问题、提交对话。\n提交阶段缺明确等待与截止。','已有界面；发现等待问题','issue'),('公开 BFF','建立会话、保存消息、提供事件流。','live=200；ready 探测超时','issue'),('PostgreSQL / 队列','保存会话和待处理任务；worker 领取。','已有基础；根因尚未定位','existing'),('AI worker','组装上下文，调用知识引擎。\n当前没有业务工具循环。','默认工具调用上限 0','existing')]
    for x,d in zip(xs,top):node(c,x,ty,w,h,*d)
    bottom=[('页面收到结果','答案与引用，或不可用提示和原表单链接。','本轮观察为不可用','issue'),('最终校验后发布','整段答案先保留，检查批准来源与商业事实后才发布。','不是真正即时逐字输出','existing'),('在线知识库 / 模型','检索批准知识并生成；不是公开网页搜索。','当前知识范围以实际库为准','existing')]
    for x,d in zip(xs[1:],bottom):node(c,x,by,w,h,*d)
    for i in range(3):arrow(c,[(xs[i]+w,ty+h/2),(xs[i+1],ty+h/2)])
    arrow(c,[(xs[3]+w/2,ty),(xs[3]+w/2,by+h)])
    for a,b in [(3,2),(2,1)]:arrow(c,[(xs[a],by+h/2),(xs[b]+w,by+h/2)])
    note(c,'本轮没有定位到生产故障的最终根因。用户看到的“没反应”需要先修服务可用性、提交反馈、有限等待和错误恢复。')
    c.showPage()

    page(c,'02  目标官网助手：可以多步查资料和准备动作','Phase 2 设计；公开网页检索为本报告建议的可选扩展，均不能写成已上线',2,6,True)
    xs=[38,301,564];w=240;h=125;ty=345;by=145
    data=[('客户需求与澄清','“给 500 位客户选礼品，型号未定。”\n先问缺项，也可自然说明能力。','目标：连续对话','plan'),('有界模型工具循环','模型选择查询 → 服务器执行 → 看结果再查。\n次数、时长和成本受限。','Phase 2 C1 / C2 待实现','plan'),('固定、可审计工具','公开产品搜索与批准详情；公司知识。\n外部网页检索另行受控接入。','不给模型任意 DB / URL 权限','plan'),('买家确认后提交','打开原询盘 / 报价表单，需求预填。\n买家补联系信息并确认。','Phase 2 D；不自动提交','plan'),('可交互回答','产品卡片、比较、解释依据和缺项。\n刷新 / 页面切换保持上下文。','Phase 2 UI 与历史待完成','plan'),('事实校验与当前资料','ID、产品、数字和引用由系统核对。\n显示 / 提交前实时复核关键数据。','模型不能编价格与承诺','plan')]
    for i,d in enumerate(data):node(c,xs[i%3],ty if i<3 else by,w,h,*d)
    arrow(c,[(278,407),(301,407)]);arrow(c,[(541,407),(564,407)])
    arrow(c,[(680,345),(680,270)])
    arrow(c,[(564,207),(541,207)]);arrow(c,[(301,207),(278,207)])
    arrow(c,[(564,430),(552,430),(552,465),(420,465),(420,470)],dashed=True)
    note(c,'优先复用已有产品 API、产品页、询盘列表和表单。搜索索引可用于找候选，当前批准资料才是展示、询盘及后续审核的事实依据。')
    c.showPage()

    page(c,'03  正式询盘进入 Sales：自动准备，人审后发送','既定目标流程；绿色是已完成各自代码验证，整条业务链仍未接通上线',3,6,True)
    xs=[38,235,432,629];w=175;h=125;ty=345;by=145
    top=[('三个官网入口','首页 OEM、单品表单、智能客服确认提交。','客服提交联动尚待实现','plan'),('Channel 正式记录','保存成功作为业务事实；\n不要求销售另下启动指令。','原表单已有；统一交接待补','existing'),('自动来源核验 / 签发','核验最终成功和真实归属；\n登记 handoff、发短期读取授权。','下一步；当前任务默认等待','plan'),('Hermes 任务与门禁','持久任务、当前执行和版本；\nChannel 查询当前是否可读。','SG2.4 代码与 CI 已通过','done')]
    for x,d in zip(xs,top):node(c,x,ty,w,h,*d)
    bottom=[('受控发送 / 结果','通过统一 Resend 路径发出；\n失败和未知结果先对账。','发送网关与线上验收待做','plan'),('人审核与接管','企微 / 网页看完整版本。\n可修改、批准、暂停或接管。','客户操作入口待实现','plan'),('Resend 草稿与预览','正文、HTML、附件和收件人\n形成可审核版本。','复用邮件能力；适配待接','plan'),('Sales 准备内容','读获准询盘与当前产品；\n写跟进邮件和附件，列缺项。','实际模型 / 工具循环待接','plan')]
    for x,d in zip(xs,bottom):node(c,x,by,w,h,*d)
    for i in range(3):arrow(c,[(xs[i]+w,ty+h/2),(xs[i+1],ty+h/2)])
    arrow(c,[(xs[3]+w/2,ty),(xs[3]+w/2,by+h)])
    for i in range(3,0,-1):arrow(c,[(xs[i],by+h/2),(xs[i-1]+w,by+h/2)])
    note(c,'确认信采用预批准模板，只走一条发送路径。实质跟进邮件要人批准；批准绑定任务、收件人、正文和附件版本，改稿等变更使旧批准失效。')
    c.showPage()

    page(c,'04  三条业务线独立，共用平台底座','业务设计快照；不因联系人统一到 Resend，就把所有人放进官网报价或营销流程',4,6,True)
    node(c,38,300,240,178,'主动获客 / Apollo','按受众与活动批准开发陌生客户。\n收到回复先停发，再分类：有意向交接、拒绝抑制、自动休假暂停。','SG6 待实施','plan')
    node(c,301,300,240,178,'官网询盘跟进','买家主动咨询并确认提交。\nChannel 保留业务事实，Sales 准备产品相关跟进邮件，Resend 承载往来。','官网不自动进冷开发序列','plan')
    node(c,564,300,240,178,'客户维护 / 多渠道','国际站、环球资源、展会等联系人。\n保留来源和业务，按资格分组；入库不等于获得持续营销许可。','SG7 待实施','plan')
    for x in [158,421,684]:arrow(c,[(x,300),(x,265)])
    c.setStrokeColor(TEAL);c.line(60,265,782,265)
    labels=[('定海 / 任务调度','任务身份、可靠接收、状态。'),('内容 / Sales 准备','事实查询、需求研究、草稿。'),('发布助手 / 邮件工具','连接 Resend / Apollo 等工具。'),('企微 / 人的入口','指令、通知、查看、审批和接管。')]
    for i,(title,body) in enumerate(labels):
        x=38+i*197;arrow(c,[(x+87,265),(x+87,235)])
        node(c,x,125,175,110,title,body,'现有能力复用；Sales 接线待补','existing')
    note(c,'共用调度、身份、工具、内容能力与人的入口；各业务线分别配置触发、受众、模板、报价和发送规则。不同客户仍要独立授权与运行边界。')
    c.showPage()

    page(c,'05  权限、暂停与审批：系统负责最终门禁','当前读取协议只管读取，不能拿读取许可当作发邮件批准',5,6,True)
    node(c,38,348,240,125,'Channel 自己检查','连接 / 安装 / 任务 lease；\n真实询盘、附件归属和允许资料；\n当前授权是否过期或撤销。','SG1.3 已实现，未上线','done')
    node(c,301,348,240,125,'Hermes 当前任务查询','读客户专属任务库；\n核对当前执行、版本、来源核验、\n暂停 / 接管与调度终态。','SG2.4 已实现，未上线','done')
    node(c,564,348,240,125,'资料返回前再检查','许可绑定整次请求，最长 10 秒；\n同 ID 换参数拒绝，状态失效拒绝。\n已返回的数据不能撤回。','正向许可不跨请求缓存','done')
    arrow(c,[(278,410),(301,410)]);arrow(c,[(541,410),(564,410)])
    node(c,38,145,240,145,'人发出暂停 / 接管','未来企微或网页认证操作者。\n先持久改状态并增加任务权限版本；\n恢复要建立明确的新执行 / 授权。','操作入口与认证尚未交付','plan')
    node(c,301,145,240,145,'邮件最终批准','绑定任务、发件人、全部收件人、\n正文与附件版本。新来信 / 改稿 /\n暂停后，旧批准不能继续发送。','SG5 审核与发送模块待实现','plan')
    node(c,564,145,240,145,'不可逆发送要对账','暂停先完成：拒绝发送。\n若已交邮件服务或结果未知：\n标记在途 / 待对账，不能盲重发。','不能承诺撤回已发邮件','plan')
    arrow(c,[(158,290),(158,318),(420,318),(420,348)],dashed=True)
    arrow(c,[(278,217),(301,217)]);arrow(c,[(541,217),(564,217)])
    note(c,'人能控制 Agent 的目标不变。本轮只验证数据库状态改变后的读取拒绝；没有交付企微暂停按钮，也没有开启邮件发送或其他 Agent 的新权限。')
    c.showPage()

    page(c,'06  分模块进度：代码验收不等于上线','计划共 26 个单元，9 个完成各自已约定范围（含源码核对），17 个仍待实施；live 全部关闭',6,6,True)
    blocks=[
        ('SG0 共同规则','0.1 / 0.2 / 0.3：合同、客户连接、任务读取协议。','已完成各自代码验证','done'),
        ('SG1 Channel','1.0 / 1.1 / 1.3 已核对或实现；1.2 自动来源、交接与签发待补。','部分完成；未接完整入口','done'),
        ('SG2 Hermes','2.1 / 2.2 / 2.4 已完成各自范围；任务私有上下文 / 成果 / 实际循环待接。','部分完成；不是线上全隔离','done'),
        ('SG3 Sales 准备','岗位规则、评估、产品研究、正文和附件成果。','待实施','plan'),
        ('SG4 Resend','草稿、收件回调、联系人和确认信唯一发送。','待实施','plan'),
        ('SG5 人与发送','操作者控制、预览审批、版本绑定与受控发送。','待实施','plan'),
        ('SG6 Apollo','客户授权、活动、回复分类与 Resend 交接。','调研 / 设计已有，代码待做','plan'),
        ('SG7 其他来源 / 维护','多渠道联系人与独立维护活动。','待实施','plan'),
        ('SG8 审计 / 上线','审计回执、告警、真实环境演练和退出恢复。','待实施','plan'),
    ]
    for i,d in enumerate(blocks):node(c,38+(i%3)*263,355-(i//3)*124,240,109,*d)
    note(c,'前端智能客服的 Phase 2 是另一条尚未落地的能力线。优先先修官网可用与反馈，再接产品工具；正式询盘后的 Sales 来源签发和生成审批也需继续补齐。',y=72)
    c.save()
    return path


if __name__=='__main__':
    for output in [report(), flows()]:print(output.name,output.stat().st_size)
