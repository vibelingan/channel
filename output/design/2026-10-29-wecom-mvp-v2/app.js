'use strict';
const initialTasks = () => ({
  A: {key:'A',id:'Q-1042',client:'ACME',need:'500 份耳机礼品',version:3,from:'Sales Team <sales@example.test>',to:'Alex <alex@example.test>',subject:'Your 500-unit corporate gift inquiry',simple:false,attachments:[{id:'spec',name:'Headphone-specification.pdf',size:'248 KB'},{id:'proposal',name:'Gift-project-options.pdf',size:'176 KB'}],status:'ready',control:'active',note:'',reviews:{},history:[],send:null},
  B: {key:'B',id:'Q-1043',client:'NOVA',need:'充电配件，先补目的地',version:1,from:'Sales Team <sales@example.test>',to:'Taylor <taylor@example.test>',subject:'A quick question about your charging-accessory inquiry',simple:true,attachments:[],status:'ready',control:'active',note:'',reviews:{},history:[],send:null}
});
let tasks=initialTasks();let taskKey='A';let mode='mvp';let entry='buttons';let quoteOptions=[];let screen='ready';let composerKind='edit';let currentAttachment=null;let selectedVersion=null;let error='';let lastReceipt='';let pendingConfirmation=null;
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const task=()=>tasks[taskKey];
const version=()=>selectedVersion??task().version;
const review=()=>{const t=task();return t.reviews[t.version]??=( {text:false,html:false,attachments:[]} );};
const body=(t=task(),v=version())=>t.simple?`Hello Taylor,\n\nThank you for your inquiry about charging accessories. Could you share the delivery destination and the approximate quantity? Our team can then prepare suitable options.\n\nBest regards,\nSales Team`:`Hello Alex,\n\nThank you for your inquiry about 500 headphones for your corporate gift project. We can help you explore suitable models and logo options.\n\n${v>=4?'Could you share the delivery destination? We will confirm product details and timing after reviewing your requirements.':'Could you share your preferred delivery destination and any logo requirements?'}\n\nThe attached specification and options document are for your review. Pricing and delivery terms will be confirmed separately.\n\nBest regards,\nSales Team`;
const taskRef=(v=version())=>`${task().id} · ${task().client} · 跟进邮件 v${v}`;
const btn=(text,action,extra='',disabled=false)=>`<button type="button" data-action="${action}" ${extra} ${disabled?'disabled':''}>${esc(text)}</button>`;
const quote=(v=version())=>`<div class="quote">引用：${esc(taskRef(v))}\n任务短引用：S-${taskKey==='A'?'7K2Q':'9J4P'}</div>`;
const notice=(text,kind='')=>`<div class="notice ${kind}">${esc(text)}</div>`;
const bubble=(text,user=false)=>`<div class="${user?'bubble user-message':'bubble'}">${esc(text)}</div>`;
const actions=(items)=>{
  if(entry==='quote'){quoteOptions.push(...items);return '<div class="notice">文字引用模式：引用这条任务通知并 @销售助手提出操作。下方有“模拟手动引用”入口。</div>';}
  return `<div class="card-operation-label">模板卡片操作示意 · 实际样式依客户端</div><div class="message-actions">${items.map(x=>btn(...x)).join('')}</div>`;
};
const nativeCard=(title,text,buttons)=>{
  if(entry==='quote')quoteOptions.push(...buttons);
  return `<div class="native-card"><div class="card-copy"><h3>${esc(title)}</h3>${text}</div>${entry==='quote'?'<div class="notice">请引用此通知并 @销售助手：查看邮件／改稿／确认发送。下方可模拟手动引用。</div>':`<div class="native-buttons ${buttons.length===2?'two':buttons.length===1?'one':''}">${buttons.map(x=>btn(...x)).join('')}</div>`}</div>`;
};
const record=(action,result)=>task().history.push({action,result,version:task().version,at:`09:${String(42+task().history.length).padStart(2,'0')}`});
function next(id){screen=id;error='';if(!['stale','stale-result'].includes(id))selectedVersion=null;render();}
function reviewsComplete(){const t=task(),r=review();return r.text&&(t.simple||(r.html&&t.attachments.every(a=>r.attachments.includes(a.id))));}
function mailSnapshot(){const t=task();return {task:t.id,version:t.version,to:t.to,from:t.from,subject:t.subject,body:body(t,t.version),attachments:t.attachments.map(a=>a.name).join('|')};}
function isCurrent(snapshot){return JSON.stringify(snapshot)===JSON.stringify(mailSnapshot());}
function group(title,contents,composer=''){
  return `<div class="chat-shell"><div class="chat-title"><div>销售待办群<small>同一个群 · 正在处理 ${esc(task().id)}</small></div><span>···</span></div><div class="surface-tag">${mode==='future'?'后续控制设计 · 第一阶段不实现':'本期 MVP 交互样稿'} · 示例数据 · 不连接真实服务</div><div class="messages"><div class="time">今日 · 09:42 · ${esc(title)}</div>${contents}</div>${composer||'<div class="composer"><div class="composer-placeholder">引用具体任务后，@销售助手提出问题或修改意见</div></div>'}</div>`;
}
function futureControls(){
 if(mode!=='future')return '';
 const choices=task().control==='paused'?[['继续准备这条','resume-confirm'],['由我接管','takeover'],['终止本次运行','terminate']]:task().control==='human'?[['查看现有成果','external'],['交回 Agent','handoff-confirm']]:['terminating','terminated'].includes(task().control)?[['查看保留成果','preview'],['查看任务记录','record']]:[['暂停这条任务','pause'],['由我接管','takeover'],['终止本次运行','terminate']];
 return `<section class="future-controls"><h3>后续设计入口（第一期不开发）</h3>${actions(choices)}</section>`;
}
function ready(){
 const t=task();let state=t.send?({submitting:'发送处理中',unknown:'发送结果不明',accepted:'发送服务已受理',delivered:'投递事件：已送达',failed:'提交前失败，可安全重试'}[t.send.status]||t.send.status):'跟进稿已准备，尚未发送';
 const canPrepare=mode!=='future'||t.control==='active';
 const taskButtons=canPrepare?[['查看邮件','preview'],['改稿 / 讨论','edit'],[t.send?'查询发送记录':'审阅并发送',t.send?'record':'review']]:[['查看保留成果','preview'],['查询任务记录','record']];
 return group('任务待办',bubble(`${t.id} 的跟进邮件已准备好。请查看内容，或引用这条任务提出修改。`)+nativeCard(`${t.id} · ${t.client}`,`<div class="card-meta"><span>${esc(t.need)}</span><span>跟进邮件 v${t.version} · 附件 ${t.attachments.length} 个</span><span>${esc(state)}</span><span>${mode==='future'?'任务状态：'+esc({active:'自动准备',pausing:'暂停待确认',paused:'已暂停',human:'人工处理','takeover-check':'接管前核对',terminating:'终止待确认',terminated:'运行已终止'}[t.control]||t.control)+' · ':''}负责人：李销售 · 短引用 S-${t.key==='A'?'7K2Q':'9J4P'}</span></div>`,taskButtons)+futureControls());
}
function preview(){
 const t=task(),v=version();
 const attachmentText=t.attachments.length?`<h3>附件 ${t.attachments.length} 个（群内未展开）</h3><ul class="attachment-list">${t.attachments.map(a=>`<li>${esc(a.name)} · ${esc(a.size)}</li>`).join('')}</ul>`:'<p>附件：无。此样例邮件为纯文字，以下正文已完整展示。</p>';
 return group(`邮件预览 v${v}`,quote(v)+`<div class="bubble"><div class="preview-label">${t.simple?'纯文字邮件完整正文预览':'企微摘要预览 · 原邮件 HTML 与附件未完整展示'}</div><div class="summary-list"><div><strong>发件人</strong><span>${esc(t.from)}</span></div><div><strong>收件人</strong><span>${esc(t.to)}</span></div><div><strong>主题</strong><span>${esc(t.subject)}</span></div></div><div class="email-text">${esc(body())}</div>${attachmentText}${!t.simple?notice('此处省略 HTML 版式、内嵌图片和附件内容。群里看过文字，不等于核对了整封邮件。'):notice('简单纯文字邮件可在这里核对后进入发送确认。','green')}<div class="review-check" id="text-review-state">${review().text?'已核对':'尚未核对'}当前 v${v} 的发件人、收件人、主题与正文</div>${actions([['确认已核对本版正文','mark-text-reviewed'],['查看完整邮件','external'],['引用这条改稿','edit'],['审阅并发送','review'],['返回任务','ready']])}</div>`);
}
function external(){
 const t=task(),r=review();
 const banner=t.simple?'':`<div class="email-banner"><svg role="img" aria-label="邮件内嵌产品示例插图" viewBox="0 0 60 60"><path d="M12 35V27a18 18 0 0 1 36 0v8M12 31h8v19h-6a5 5 0 0 1-5-5V36a5 5 0 0 1 3-5M48 31h-8v19h6a5 5 0 0 0 5-5V36a5 5 0 0 0-3-5" fill="none" stroke="currentColor" stroke-width="4"/></svg><div><strong>Corporate gift options</strong><p>邮件里的内嵌图片示意。不会把这段 HTML 拼入企微消息。</p></div></div>`;
 return `<div class="external-shell"><div class="external-bar"><span>邮件工作台 · 页面示意</span>${btn('返回企微原任务','preview')}</div><div class="surface-tag">模拟外部表面 · 非 Resend 真实截图 · 无实际草稿链接</div><div class="external-body"><h2>完整邮件 v${t.version}</h2><p class="fineprint">实际接入优先打开客户已有 Resend 草稿；需要登录时由原平台鉴权。本页只让你体验这次切换与返回。</p><div class="mail-headers"><span><strong>From</strong> ${esc(t.from)}</span><span><strong>To</strong> ${esc(t.to)}</span><span><strong>Subject</strong> ${esc(t.subject)}</span></div><article class="rendered-email"><div class="email-brand">SAMPLE SALES TEAM</div>${banner}${body().split('\n\n').map(p=>`<p>${esc(p).replaceAll('\n','<br>')}</p>`).join('')}</article><label class="review-check"><input id="html-reviewed" type="checkbox" ${r.html?'checked':''}>我已核对当前 v${t.version} 的完整邮件正文与版式</label><h3>附件 ${t.attachments.length} 个</h3>${t.attachments.length?t.attachments.map(a=>`<div class="attachment-tile"><span>${esc(a.name)}<small>${esc(a.size)} · ${r.attachments.includes(a.id)?'本示例已确认核对':'尚未确认核对'}</small></span>${btn('查看附件','attachment',`data-attachment="${a.id}"`)}</div>`).join(''):'<p>此邮件没有附件。</p>'}<div class="external-actions">${btn('返回企微继续确认','review','class="primary"')}${btn('返回企微提出改稿','edit')}${btn('返回企微预览','preview')}</div></div></div>`;
}
function attachment(){
 const t=task(),a=t.attachments.find(x=>x.id===currentAttachment);
 return `<div class="external-shell"><div class="external-bar"><span>附件预览 · 示例</span>${btn('返回邮件','external')}</div><div class="surface-tag">静态示例，不是真实 PDF 阅读器或已上传文件</div><div class="external-body"><h2>${esc(a.name)}</h2><div class="attachment-document"><h3>${a.id==='spec'?'Headphone specification':'Gift project options'}</h3><p>Sample document for ${esc(t.id)} · v${t.version}</p><ul><li>此处演示实际附件的查看位置。</li><li>产品、参数与商务承诺需引用获准数据。</li><li>实际实现会在鉴权后读取当前版本的固定附件字节。</li></ul><p>本例不包含真实价格或交期，不作为报价。</p></div>${btn('已核对此附件，返回邮件','attachment-reviewed','class="primary"')}${notice('同一附件名称可能属于不同版本。确认只记在本任务的当前版本；改稿后要重新核对。')}</div></div>`;
}
function editStart(){
  if(mode==='future'&&task().control!=='active')return group('当前任务不接受自动改稿',quote()+bubble('这条任务已暂停、冻结、接管或终止。只能查看成果，按后续设计的明确恢复/交回操作后才准备新稿。')+actions([['返回任务','ready'],['查看成果','preview']]));
  return group('助手提示：请引用这条通知',quote()+bubble(`请在本群手动引用 ${task().id} 的任务通知，@销售助手后写出你的修改意见或问题。`)+notice('真实接口不会替你自动填企微输入框、自动引用或创建新群。本样稿下方提供“模拟手动引用”，让你体验下一步。'));
}
function edit(){
 const kind=composerKind==='discuss'?'讨论':'改稿';
 if(task().send&&['accepted','delivered','unknown','submitting'].includes(task().send.status))return group('这封邮件不能直接覆盖',quote()+bubble('当前邮件已提交或结果待核对。不能再改这封草稿并当成同一封重发。请先查询发送记录。')+actions([['查看发送记录','record'],['返回任务','ready']]));
 const composer=`<div class="composer">${quote()}<label for="edit-note">在本群 @销售助手，${kind}这条任务</label><textarea id="edit-note" placeholder="例如：先问目的地，不写交期，保留产品规格附件。">${esc(task().note)}</textarea>${error?`<p class="field-error" role="alert">${esc(error)}</p>`:''}<div class="question-options">${btn('填入改稿示例','sample-edit')}${btn('填入讨论问题','sample-discuss')}</div><div class="composer-controls">${btn('返回预览','preview')}${btn(`发送${kind}意见`,'submit-edit','class="primary"')}</div></div>`;
 return group(`引用任务，留在本群${kind}`,bubble(`你已在企微客户端手动引用通知，仍在“销售待办群”。输入的文字会连同 ${task().id} / v${task().version} 的任务引用一起交给助手；不会自动新建群或跳到私聊。`)+notice('这是一个可编辑的输入框。此输入画面模拟你在企微客户端手动引用后的状态，实际意见由你输入。'),composer);
}
function changeAccepted(){
 const discussing=composerKind==='discuss';
 return group(discussing?'讨论请求已受理':'改稿请求已受理',quote()+bubble(task().note,true)+bubble(`${task().id} 的${discussing?'讨论':'改稿'}请求已记录，仍在当前群处理。任务对象不会切换。`)+nativeCard('操作回执',`<p>目标：${esc(taskRef())}</p><p>本次意见：${esc(task().note)}</p><p>这是本地演示，不调用真实模型。点下面的演示按钮查看下一步。</p>`,[[discussing?'演示助手答复':'演示改稿完成',discussing?'discussion-answer':'redraft-complete'],['继续补充意见',discussing?'discuss':'edit'],['返回任务','ready']]));
}
function discussionAnswer(){
 return group('同群答复，不修改邮件',quote()+bubble('这条询盘还缺交付目的地和更明确的配置要求。建议先确认目的地，再由团队核对产品与商业条款。以上是讨论建议，尚未写入邮件稿，也没有发送。')+notice(`当前邮件仍是 v${task().version}。普通问题不会自动变成改稿或发送指令。`)+actions([['按这个建议提出改稿','edit'],['继续讨论','discuss'],['返回当前邮件','preview']]));
}
function redraft(){return group('新稿已准备',quote()+bubble(`${task().id} 的 v${task().version} 已准备好。已按演示样例增加目的地问题、不写交期；你的原始意见已保留。旧版仍可追溯，所有旧版审阅确认失效。`)+notice('邮件正文使用固定演示模板，不代表模型理解了任意输入。真实内容生成属于待接入能力。')+nativeCard(`跟进稿 v${task().version} · 尚未发送`,`<p>收件人：${esc(task().to)}</p><p>附件：${task().attachments.length} 个 · 需重新审阅当前版本</p>`,[['查看新稿','preview'],['继续改稿','edit'],['审阅并发送','review']]));}
function reviewGate(){
 const t=task(),r=review();
 if(mode==='future'&&t.control!=='active')return group('当前任务不允许发送',quote()+bubble('这条任务已暂停、接管、冻结或终止。不会沿用旧批准发送；请返回任务查看当前状态。')+actions([['返回任务','ready'],['查看保留成果','preview']]));
 if(t.send&&['accepted','delivered','submitting','unknown'].includes(t.send.status))return recordScreen();
 if(!reviewsComplete())return group('发送前还需要核对',quote()+bubble(`${t.id} / v${t.version} 尚未完成必要核对，我还没有发送。`)+`<div class="bubble"><h3>当前审阅状态</h3><div class="record-list"><div>${r.text?'已核对':'未核对'}：企微正文及完整收发件信息</div>${!t.simple?`<div>${r.html?'已核对':'未核对'}：完整 HTML 版式与内嵌内容</div>${t.attachments.map(a=>`<div>${r.attachments.includes(a.id)?'已核对':'未核对'}：${esc(a.name)}</div>`).join('')}`:''}</div>${notice(t.simple?'请回到纯文字预览确认已核对，再进入发送确认。':'附件内容和 HTML 没有完整进入群预览。请到完整邮件查看，确认后会回到当前企微任务；不会直接发送。')}${actions([['返回正文预览','preview'],['打开完整邮件','external'],['先改稿','edit']])}</div>`);
 pendingConfirmation=mailSnapshot();
 return group('确认发送具体版本',quote()+`<div class="bubble"><h3>确认发送 ${esc(t.id)} / v${t.version}</h3><div class="summary-list"><div><strong>发件人</strong><span>${esc(t.from)}</span></div><div><strong>收件人</strong><span>${esc(t.to)}</span></div><div><strong>主题</strong><span>${esc(t.subject)}</span></div><div><strong>附件</strong><span>${t.attachments.map(a=>esc(a.name)).join('<br>')||'无'}</span></div><div><strong>草稿</strong><span>${esc(t.id)}-v${t.version}，已核对当前内容</span></div></div>${notice('本次确认只针对这封邮件。改稿、新来信或版本变化后，旧确认不能继续发送。')}${actions([['确认发送当前版本','send','class="primary"'],['返回检查','preview'],['我想再改一版','edit']])}<p class="fineprint">本按钮只演示下一屏，不会真的发信。</p></div>`);
}
function sending(){return group('正在提交发送',quote(task().send.version)+bubble(`已收到 ${task().id} / v${task().send.version} 的发送确认，正在向邮件服务提交。请不要再发一遍。`)+nativeCard('发送操作正在处理',`<p>操作号：${esc(task().send.id)}</p><p>当前：等待明确结果。</p><p>下方“演示后续结果”可选择要体验的返回情况。</p>`,[['查询发送结果','query-send'],['返回任务','ready']]));}
function unknown(){return group('发送结果尚不明确',quote(task().send.version)+bubble('请求可能已经被邮件服务接受，但响应没有确认。此时不能直接重发。')+notice('先用原操作号核对发送记录；换版本、换幂等键或重新跑任务都可能造成重复邮件。','red')+nativeCard('待核对',`<p>${esc(task().send.id)} · ${esc(task().to)}</p><p>尚不能确认是否提交成功，暂不开放重发。</p>`,[['核对原发送操作','reconcile'],['查看完整邮件','external'],['返回任务','ready']]));}
function reconciling(){return group('正在核对原操作',quote(task().send.version)+bubble(`正在用原操作号 ${task().send.id} 核对邮件服务结果，不创建第二次发送。`)+notice('本原型不访问 provider。下方选择“核对后确认已受理”或“核对后确认未提交”，体验不同结果。')+actions([['再查询一次','reconcile'],['返回任务','ready']]));}
function accepted(){return group('发送服务已受理',quote(task().send.version)+bubble(`${task().id} / v${task().send.version} 已由邮件服务确认受理。`)+nativeCard('提交结果已确认',`<p>收件人：${esc(task().to)}</p><p>操作号：${esc(task().send.id)}</p><p>服务邮件ID：DEMO-${esc(task().id)}</p><p>受理不等于送达，也不等于对方已读。</p>`,[['查看发送记录','record'],['查看邮件','external'],['返回任务','ready']]));}
function delivered(){return group('投递结果已更新',quote(task().send.version)+bubble(`示例投递事件：${task().id} / v${task().send.version} 已送达收件服务器。不能据此判断对方已读。`)+actions([['查看发送记录','record'],['返回任务','ready']]));}
function failed(){return group('明确未提交，可安全重试',quote(task().send.version)+bubble('本例模拟：发送前连接失败，系统确认邮件没有提交给服务。可以重试同一封，不创建第二条业务邮件。')+notice('只有“明确未提交”才提供此重试入口。结果未知时必须先核对。')+nativeCard('失败回执',`<p>同一操作号：${esc(task().send.id)}</p><p>固定版本：v${task().send.version}</p><p>重试继续使用同一业务身份与内容。</p>`,[['重试同一封','retry-send'],['返回检查','preview'],['返回任务','ready']]));}
function recordScreen(){const t=task();return group('任务与发送记录',quote()+`<div class="bubble"><h3>${esc(t.id)} 的记录</h3><div class="record-list">${t.send?`<div>发送状态：${esc({submitting:'提交中',unknown:'结果不明',accepted:'服务已受理，尚无送达证据',delivered:'已收到示例送达事件',failed:'明确未提交'}[t.send.status])}<small>操作号 ${esc(t.send.id)} · v${t.send.version}</small></div>`:'<div>尚未提交任何发送。</div>'}${t.history.map(h=>`<div>${esc(h.result)}<small>${esc(h.at)} · v${h.version} · ${esc(h.action)}</small></div>`).join('')}</div>${actions([['查看当前邮件','preview'],['返回任务','ready']])}</div>`);}
function stale(){const old=Math.max(1,task().version-1);selectedVersion=old;return group('一张旧任务通知',quote(old)+nativeCard(`旧卡片 · v${old}`,`<p>同一任务：${esc(task().id)}</p><p>当前稿件已是 v${task().version}。此卡片只用来演示旧按钮。</p>`,[['按旧版确认发送','stale-send'],['查看当前版本','preview'],['引用同一任务改稿','edit']]));}
function staleResult(){return group('旧批准已失效',quote(selectedVersion)+bubble(`我没有发送。${task().id} 当前是 v${task().version}，旧 v${selectedVersion} 的按钮不能批准新稿。请核对当前版本。`)+actions([['查看当前版本','preview'],['返回任务','ready']]));}
function ambiguous(){return group('未选中具体任务',bubble('@销售助手 发一下这封',true)+bubble('你指的是哪条任务？我还没有发送。请点选或引用对应通知。')+actions([['Q-1042 · ACME','choose-A'],['Q-1043 · NOVA','choose-B'],['取消本次操作','ready']]));}
function futureScreen(){
 const t=task();
 switch(screen){
 case 'pause':return group('后续设计：暂停确认',quote()+bubble('暂停只作用这条任务。已有发送不能撤回；恢复后旧发送批准也不会恢复。')+actions([['请求暂停这条','pause-requested','class="primary"'],['返回任务','ready']])+notice('第一期不开发此控制逻辑。'));
 case 'pause-requested':return group('后续设计：暂停已受理',quote()+bubble('暂停请求已受理。系统先阻止新的外部动作，再等待当前计算到停止点。还不能把此状态叫“完全停止”。')+actions([['演示停止点确认','paused'],['查看任务记录','record']]));
 case 'paused':return group('后续设计：已暂停',quote()+bubble(`${t.id} 已暂停，稿件与附件已保留。其他任务继续。`)+notice('恢复需要重新检查任务状态和来源，不恢复旧批准。')+actions([['继续准备这条','resume-confirm'],['由我接管','takeover'],['返回任务','ready']]));
 case 'resume-confirm':return group('后续设计：继续准备',quote()+bubble('会基于最新需求和已授权资料创建新获准运行，生成新的审核版本。不会直接发邮件。')+actions([['确认继续准备','resumed'],['保持暂停','paused']]));
 case 'resumed':return group('后续设计：恢复准备已受理',quote()+bubble('恢复请求已记录。实际实现还需要新 run 创建、上下文绑定与调度；这里仅演示回执。')+actions([['演示新稿完成','redraft-complete'],['返回任务','ready']]));
 case 'takeover':return group('后续设计：人工接管',quote()+bubble('人工接管将撤销 Agent 的后续改稿和代发权。先核对此前是否有未确定的发送，不能立即打开第二条发送通路。')+actions([['申请接管这条','takeover-check','class="primary"'],['返回任务','ready']]));
 case 'takeover-check':return group('后续设计：核对接管条件',quote()+bubble(t.send&&['unknown','submitting'].includes(t.send.status)?'此前发送结果仍不明确。已冻结后续动作，先核对，暂勿手动重发。':'本例没有结果不明的发送，可完成执行权移交。')+actions(t.send&&['unknown','submitting'].includes(t.send.status)?[['核对原发送','reconcile'],['返回任务','ready']]:[['演示接管完成','human-owned'],['返回任务','ready']]));
 case 'human-owned':return group('后续设计：人工处理',quote()+bubble(`${t.id} 已交给李销售处理。Agent 不再覆盖此稿或代发。`) +actions([['查看现有成果','external'],['交回 Agent','handoff-confirm'],['返回任务','ready']]));
 case 'handoff-confirm':return group('后续设计：交回前确认',quote()+bubble('交回时保留人工修改，重新核对任务和资料，生成新审核版本；不会继承接管前的批准。')+actions([['确认交回准备','resumed'],['继续人工处理','human-owned']]));
 case 'terminate':return group('后续设计：终止当前运行',quote()+bubble('终止当前计算用于停止无效循环或超额消耗。它不撤回已发邮件，也不是让一句“停一下”取消全部任务。')+notice('第一期不做群内终止入口；先由系统时限、工具次数和费用上限约束。')+actions([['确认终止本次运行','terminate-requested','class="danger"'],['返回任务','ready']]));
 case 'terminate-requested':return group('后续设计：终止已受理',quote()+bubble('已记录终止请求并阻止新动作，正在确认当前计算是否退出。')+actions([['演示计算已退出','terminated'],['查看任务记录','record']]));
 case 'terminated':return group('后续设计：本次运行已终止',quote()+bubble('本次计算已退出，已归档成果保留。重新准备需要明确的新运行，不重发此前已提交或结果不明的邮件。')+actions([['查看保留成果','preview'],['返回任务','ready']]));
 }
 return ready();
}
const descriptions={
 ready:['任务通知','普通阶段默认不刷群。卡片把人带到一条确定的任务，而不是要求销售记住 task ID。','本期拟做：任务准备与结果通知。卡片和控制后端尚未接入。'],
 preview:['留在企微，看正文预览','展示收发件人、主题、正文、附件名称与缺失部分。邮件原HTML不等于企微消息HTML；简单纯文字邮件可以在群内核对。','“查看完整邮件”会切到另一个受鉴权的邮件表面，本页用示意画面演示返回。'],
 external:['切到邮件工作台示意','这是Resend或鉴权预览的占位体验，能看完整HTML和附件。不是Resend实机截图，也没有虚构可用草稿直达链接。','返回时仍是同任务、同版本；预览链接不能授予权限。'],
 attachment:['查看当前版本附件','附件按钮打开独立示例文档，核对后再返回当前邮件。原生企微文件消息是否同时发送，留给实际接入验证。','第一期不假装群文字已经覆盖附件内容。'],
 'edit-start':['按钮给出下一步说明','点击改稿按钮后，助手回复请引用这条任务并@它填写意见。企业微信接口不能替用户填输入框或自动引用。','下方“模拟手动引用”属于查看器，用来演示你在真实客户端手动操作后的输入画面。'],
 edit:['在当前群引用改稿／讨论','这里模拟用户已手动引用原通知，并在同一个群里写意见。不会自动换群、开线程或跳到私聊。','客户也可直接引用标准通知并@助手，不一定需要改稿按钮。'],
 'discussion-answer':['同群讨论不会自动改稿','用户的问题先得到建议，邮件版本保持不变；需要采用建议时再明确提出改稿。','讨论与发送分开，不能把一句咨询理解成批准外发。'],
 'change-accepted':['明确受理，过程静默','系统确认目标任务与意见，接下来不逐步骤广播。样稿用“演示改稿完成”让你看到后续界面。','真实模型还没有接入；不是输入任意意见就已完成内容创作。'],
 redraft:['新稿要重新看','新版本替代当前审阅版本，旧成果仍保留。旧收件人、正文或附件的批准不能发新稿。','切到另一条任务不会把当前意见或审阅状态带过去。'],
 review:['发送前核对','只有当前版本所需内容已核对，才进入明确发送确认。带附件的预览必须说明缺失项；没有附件的纯文字可直接核对。','真正放行由后端校验人员权限、任务、版本及发送操作；本页只是样例。'],
 sending:['确认后先等服务结果','只提交同一个固定版本和操作号，不把一声“好的”当成发送完成。下方可以模拟不同返回。','受理、送达和已读分别记录；结果未知时不重发。'],
 unknown:['结果不明，先核对','网络超时可能发生在服务已经接收之后。此时重跑或换键重试都可能双发。','只开放核对原操作，不开放直接重发。'],
 reconciling:['查询同一操作','使用原操作号查询或对账。下方可模拟核对结论，不创建新邮件。','只有明确未提交，才开放同一操作的安全重试。'],
 accepted:['发送服务已受理','邮件服务确认接受请求。此状态不等于成功投递，更不能说明对方已读。','后续投递事件才更新送达；回执来自系统，不由模型自报。'],
 delivered:['送达事件单独显示','该示例表示收件服务器已接受，仍不能当作用户已读。','真正的provider webhook还未接入。'],
 failed:['明确未提交才重试','例子是已证实邮件未提交的失败。重试保留同一邮件操作和固定内容，不再创建一个业务发送。','结果未知不会进入此屏，必须先对账。'],
 record:['查询只返回本任务记录','查询结果与任务、版本、发送操作关联。普通查询不应打断另一条后台业务任务。','本页记录仅存于浏览器内存，刷新或重置会清除。'],
 stale:['旧卡片的按钮','旧版本可以帮助人找同一任务，但不能批准发送新版。','本例显示可操作的拒绝和查看新稿路径。'],
 'stale-result':['拒绝旧版本发送','清楚回复“未发送”，并指向当前稿。不会从“发这版”猜测批准新版本。','实际后端还必须校验完整内容，不只比较画面上的版本号。'],
 ambiguous:['对象不明确，先选择','没有任务引用时只列有权操作的候选，不默认最新任务、不把模型上下文当权限。','点选后进入具体任务预览，不直接发送。']
};
function render(){
 quoteOptions=[];
 $('surface').innerHTML=screen==='ready'?ready():screen==='preview'?preview():screen==='external'?external():screen==='attachment'?attachment():screen==='edit-start'?editStart():screen==='edit'?edit():screen==='change-accepted'?changeAccepted():screen==='discussion-answer'?discussionAnswer():screen==='redraft'?redraft():screen==='review'?reviewGate():screen==='sending'?sending():screen==='unknown'?unknown():screen==='reconciling'?reconciling():screen==='accepted'?accepted():screen==='delivered'?delivered():screen==='failed'?failed():screen==='record'?recordScreen():screen==='stale'?stale():screen==='stale-result'?staleResult():screen==='ambiguous'?ambiguous():futureScreen();
 const info=descriptions[screen]||['后续控制设计','暂停、恢复、人工接管和群内终止保留作未来体验；本期不实现。','此处的“受理”和“完成”依然分开，不承诺能撤回已提交邮件。'];
 $('step-explanation').innerHTML=`<span class="step-tag">${mode==='mvp'?'本期 MVP':'后续设计'} · ${esc(task().id)}</span><h2>${esc(info[0])}</h2><p>${esc(info[1])}</p><p class="notice">${esc(info[2])}</p><ol><li>当前任务：${esc(taskRef())}</li><li>所在位置：${['external','attachment'].includes(screen)?'模拟邮件工作台，需真实平台鉴权':'原销售待办群，没有自动切换私聊'}</li><li>所有按钮仅改变样例画面。</li></ol>`;
 const sim=(screen==='sending')?['accepted','unknown','failed']:(screen==='unknown'||screen==='reconciling')?['accepted','failed']:screen==='accepted'?['delivered']:[];
 $('simulation').innerHTML=sim.length?`<h3>演示后续结果</h3><p class="simulation-label">这是样稿查看器，不是销售人员在企微里的操作按钮。</p>${sim.map(id=>btn({accepted:screen==='sending'?'模拟服务已受理':'核对后确认已受理',unknown:'模拟结果不明',failed:screen==='sending'?'模拟明确未提交':'核对后确认未提交',delivered:'模拟收到送达事件'}[id],'simulate',`data-result="${id}"`)).join('')}`:'';
 for(const key of ['A','B']){$(`task-${key.toLowerCase()}-status`).textContent=`v${tasks[key].version} · ${tasks[key].send?{accepted:'服务已受理',delivered:'已送达',unknown:'结果不明',submitting:'提交中',failed:'明确未提交'}[tasks[key].send.status]:'待审阅'}`;}
 if(screen==='edit-start')$('simulation').innerHTML='<h3>演示客户端手动动作</h3><p class="simulation-label">这不是可由机器人自动完成的动作。</p>'+btn('模拟：我已引用此任务并开始输入','simulate-quote');
 if(entry==='quote'&&quoteOptions.length){const unique=[...new Map(quoteOptions.map(x=>[x[1],x])).values()];$('simulation').innerHTML+='<h3>模拟手动引用并@助手</h3><p class="simulation-label">真实客户端由人引用和发送；此处为样稿快捷演示。</p>'+unique.map(x=>btn('引用后说：'+x[0],x[1],x[2]||'',x[3]||false)).join('');}
 document.querySelectorAll('[data-entry]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.entry===entry)));
 document.querySelectorAll('[data-task]').forEach(b=>b.setAttribute('aria-current',b.dataset.task===taskKey?'true':'false'));
 document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
 $('mode-note').textContent=mode==='mvp'?'本期不提供暂停、恢复、接管和群内终止。':'这些控制只保留设计，本轮不开发；切回MVP会重置样例。';
 $('live-announcement').textContent=`${taskRef()}，${info[0]}`;document.title=`${task().id} · ${info[0]} · 企微交互样稿`;
 document.querySelector('#surface button, #surface textarea')?.setAttribute('data-first-control','true');
}
function execute(action,el){
 const t=task();
 if(action==='edit'||action==='discuss'){composerKind=action==='discuss'?'discuss':'edit';next('edit-start');return;}
 if(action==='simulate-quote'){next('edit');setTimeout(()=>$('edit-note')?.focus(),0);return;}
 if(action==='mark-text-reviewed'){review().text=true;render();return;}
 if(action==='sample-edit'){$('edit-note').value='先问客户目的地，不写交期，保留产品规格附件。';$('edit-note').focus();return;}
 if(action==='sample-discuss'){$('edit-note').value='这条询盘还缺哪些信息？先给我建议，暂不发送。';composerKind='discuss';t.note=$('edit-note').value;render();$('edit-note').focus();return;}
 if(action==='submit-edit'){t.note=$('edit-note').value.trim();if(!t.note){error='请写下具体意见；任务引用已经带好。';render();$('edit-note').focus();return;}record(composerKind==='discuss'?'讨论受理':'改稿受理',`${t.id} 的意见已受理`);next('change-accepted');return;}
 if(action==='redraft-complete'){t.version++;t.reviews[t.version]={text:false,html:false,attachments:[]};t.send=null;pendingConfirmation=null;record('新稿',`新稿 v${t.version} 已准备，旧批准失效`);next('redraft');return;}
 if(action==='attachment'){currentAttachment=el.dataset.attachment;next('attachment');return;}
 if(action==='attachment-reviewed'){if(!review().attachments.includes(currentAttachment))review().attachments.push(currentAttachment);next('external');return;}
 if(action==='send'){if(mode==='future'&&t.control!=='active'){next('review');return;}if(!pendingConfirmation||!isCurrent(pendingConfirmation)||!reviewsComplete()){next('stale-result');return;}if(t.send&&t.send.status!=='failed'){next('record');return;}t.send={id:`MAIL-${t.id}-01`,version:t.version,status:'submitting',snapshot:pendingConfirmation};record('发送提交','已提交同一固定发送操作，等待结果');next('sending');return;}
 if(action==='simulate'){const id=el.dataset.result;t.send.status=id==='unknown'?'unknown':id==='failed'?'failed':id==='delivered'?'delivered':'accepted';record('服务结果',{unknown:'发送结果未知，等待核对',failed:'已确认未提交，可重试同一操作',delivered:'收到示例投递事件：已送达',accepted:'邮件服务已受理，送达待确认'}[id]);next(id);return;}
 if(action==='retry-send'){if(t.send?.status!=='failed'||!isCurrent(t.send.snapshot)){next('record');return;}t.send.status='submitting';record('安全重试','重试同一操作号，不创建第二封');next('sending');return;}
 if(action==='reconcile'){next('reconciling');return;}
 if(action==='query-send'){t.send.status='unknown';next('unknown');return;}
 if(action==='choose-A'||action==='choose-B'){taskKey=action.slice(-1);next('preview');return;}
 if(action==='stale-send'){next('stale-result');return;}
 if(mode==='future'){
  if(action==='pause-requested'){t.control='pausing';pendingConfirmation=null;record('暂停请求','已受理暂停请求，等待停止点');}
  if(action==='paused'){t.control='paused';record('暂停完成','已暂停当前任务，其他任务继续');}
  if(action==='takeover-check'){t.control='takeover-check';pendingConfirmation=null;record('接管请求','冻结后续动作，核对在途结果');}
  if(action==='human-owned'){t.control='human';record('接管完成','人工接管，Agent不再覆盖成果');}
  if(action==='resumed'){t.control='active';pendingConfirmation=null;record('恢复请求','新获准运行等待接入，不恢复旧批准');}
  if(action==='terminate-requested'){t.control='terminating';pendingConfirmation=null;record('终止请求','禁止新动作，计算退出待确认');}
  if(action==='terminated'){t.control='terminated';record('终止完成','本次运行已退出，成果保留');}
 }
 next(action);
}
document.addEventListener('click',e=>{const el=e.target.closest('button');if(!el||el.disabled)return;if(el.dataset.task){taskKey=el.dataset.task;pendingConfirmation=null;next('ready');return;}if(el.dataset.entry){entry=el.dataset.entry;render();return;}if(el.dataset.mode){mode=el.dataset.mode;tasks=initialTasks();taskKey='A';pendingConfirmation=null;next('ready');return;}if(el.dataset.action)execute(el.dataset.action,el);});
document.addEventListener('change',e=>{if(e.target.id==='html-reviewed')review().html=e.target.checked;});
document.addEventListener('input',e=>{if(e.target.id==='edit-note')task().note=e.target.value;});
$('show-stale').onclick=()=>next('stale');$('show-ambiguous').onclick=()=>next('ambiguous');$('reset').onclick=()=>{tasks=initialTasks();taskKey='A';pendingConfirmation=null;next('ready');};
render();
