const {chromium}=require(require('path').join(process.env.CODEX_NODE_PACKAGES || require('path').join(require('os').homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'),'playwright'));
const fs=require('fs');
const path=require('path');
const root=__dirname;
(async()=>{
 const model=JSON.parse(fs.readFileSync(path.join(root,'screens.json'),'utf8'));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext();const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const results=[];
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:950});
  for(const screen of model.screens){
   await page.goto(`http://127.0.0.1:62040/assistant-ui.html?screen=${screen.id}`,{waitUntil:'load'});
   const geometry=await page.evaluate(()=>{const a=document.querySelector('.assistant')?.getBoundingClientRect();return {innerWidth,scrollWidth:document.documentElement.scrollWidth,assistantWidth:a?.width||0,assistantLeft:a?.left||0,assistantRight:a?.right||0,title:document.getElementById('screen-title').textContent}});
   results.push({screen:screen.id,width,...geometry,pass:geometry.scrollWidth<=width&&geometry.assistantRight<=width+1&&geometry.assistantLeft>=-1});
  }
 }
 const journeys=[];const test=async(name,fn)=>{try{await fn();journeys.push({name,pass:true})}catch(e){journeys.push({name,pass:false,error:e.message})}};
 await page.setViewportSize({width:390,height:900});
 await test('stop_confirm_retry',async()=>{
  await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=streaming');
  await page.getByRole('button',{name:'Stop generation for this answer'}).click();
  if(!page.url().includes('screen=stop_requested'))throw Error('Stop not acknowledged');
  await page.locator('.state-btn[data-go="stopped"]').click();
  await page.locator('.assistant button[data-go="retry_after_stop"]').click();
  await page.locator('.assistant button[data-go="queued"]').click();
  if(!page.url().includes('screen=queued'))throw Error('Retry not queued');
 });
 await test('consent_is_explicit_and_invalid_fields_preserved',async()=>{
  await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=inquiry_review');
  if(await page.locator('#contact-consent').isChecked())throw Error('Consent prechecked');
  await page.locator('#need').fill('Preserve this requirement');
  await page.locator('#contact-name').fill('Sample Person');
  await page.locator('#contact-email').fill('broken@');
  await page.locator('.assistant button[data-go="inquiry_submitting"]').click();
  if(!page.url().includes('screen=inquiry_validation'))throw Error('Validation absent');
  if(await page.locator('#need').inputValue()!=='Preserve this requirement')throw Error('Requirement lost');
  if(await page.locator('#contact-name').inputValue()!=='Sample Person')throw Error('Name lost');
  if(await page.locator('#contact-email').inputValue()!=='broken@')throw Error('Email lost');
  if(await page.locator('#contact-email').evaluate(e=>document.activeElement!==e))throw Error('Invalid field not focused');
 });
 await test('inquiry_review_submission_and_saved_separate',async()=>{
  await page.locator('#contact-email').fill('sample@example.test');
  await page.locator('#contact-consent').check();
  await page.locator('.assistant button[data-go="inquiry_submitting"]').click();
  if(!page.url().includes('screen=inquiry_submitting'))throw Error('Submission not shown');
  await page.locator('.state-btn[data-go="inquiry_saved"]').click();
  if(!(await page.locator('.assistant').innerText()).includes('does not mean a quotation has been approved or an email has been sent'))throw Error('Saved scope missing');
 });
 await test('keyboard_escape_returns_focus_to_launcher',async()=>{
  await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=composing');
  await page.locator('#question').focus();await page.keyboard.press('Escape');
  if(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label'))!=='Open product assistant')throw Error('Focus not returned');
  await page.keyboard.press('Enter');if(!page.url().includes('screen=welcome'))throw Error('Keyboard reopen failed');
 });
 await test('shift_enter_does_not_submit',async()=>{
  await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=composing');await page.locator('#question').focus();
  await page.keyboard.press('Shift+Enter');if(!page.url().includes('screen=composing'))throw Error('Shift Enter submitted');
  await page.keyboard.press('Enter');if(!page.url().includes('screen=queued'))throw Error('Enter did not submit');
 });
 await test('ordinary_question_has_no_inquiry_request',async()=>{
  let remoteRequests=[];const observe=req=>{if(!req.url().startsWith('http://127.0.0.1:62040/'))remoteRequests.push(req.url())};page.on('request',observe);
  await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=clarification');
  await page.locator('#question').fill('Do you offer OEM?');await page.locator('.assistant .send').click();
  page.off('request',observe);if(remoteRequests.length)throw Error('External request '+remoteRequests.join(','));if(!page.url().includes('screen=queued'))throw Error('Question did not stay chat');
 });
 await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=inquiry_review&clean=1&viewport=mobile');
 await page.screenshot({path:path.join(root,'assistant-ui-final-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});await page.goto('http://127.0.0.1:62040/assistant-ui.html?screen=stop_requested');
 await page.screenshot({path:path.join(root,'assistant-ui-final-stop.png'),fullPage:true});
 const evidence={date:new Date().toISOString(),scope:'local static prototype only; no product backend, model or WeCom validation',screen_count:model.screens.length,layout_checks:results.length,layout_pass:results.filter(x=>x.pass).length,layout_fail:results.filter(x=>!x.pass),journeys,page_errors:errors,checks:results,changes:['Touch controls raised to 44px minimum in prototype','Inquiry validation preserves typed fields','Contact consent is not preselected','Invalid consent and email show focused explicit errors'],pdf:'pending'};
 fs.writeFileSync(path.join(root,'ui-validation.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({layout_checks:results.length,layout_pass:evidence.layout_pass,layout_fail:evidence.layout_fail,journeys,page_errors:errors},null,2));await browser.close();
})();
