'use strict';
// Real desktop and rollout files, isolated data and localhost model only.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {Store}=require('../src/core/store.cjs');
const {localDate}=require('../src/core/daily-desk.cjs');
const ROOT=path.resolve(__dirname,'..'),DATE=localDate(new Date()),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
  const out=path.join(ROOT,'test-output'),root=await fs.mkdtemp(path.join(out,'project-day-ui-')),data=path.join(root,'data'),home=path.join(root,'codex'),inputs=[],errors=[],checks=[];
  let app,page;
  const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
  const server=http.createServer(async(req,res)=>{
    try{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(JSON.parse(body).messages.at(-1).content);inputs.push(input);
      const result={overview:{scene:'核对账单',requirements:'接续当天工作',progress:'完成后续修复',nextAction:'等待客户测试',blocker:''},items:[{issueKey:'same-business',title:'账单核对',action:'接续上午处理与下午修复',result:'完成后续修复，待客户测试',status:'待验证',sourceIds:input.sources.map(s=>s.id)}],requirements:[],confirmations:[],reportText:'接续完成账单核对修复，待客户测试。',reportIssueKeys:['same-business']};
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
    }catch(e){errors.push(e.message);res.writeHead(500);res.end('{}');}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const store=new Store(data),source=path.join(root,'source'),cwd=path.join(root,'development');await fs.mkdir(source);await fs.mkdir(cwd);
  const p=store.createProject({name:'多会话接续验收',sourceDir:source,devDir:cwd});store.bindCodexThread(p.id,{threadId:'old-chat'});
  store.saveSummarizerSettings({enabled:true,provider:'compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'local-fixture'});
  const rows=(id,cwd,turnId,hour)=>{const timestamp=`${DATE}T${hour}:00:00Z`;return [{type:'session_meta',payload:{id,cwd}},{type:'event_msg',timestamp,payload:{type:'task_started',turn_id:turnId}},{type:'event_msg',timestamp,payload:{type:'user_message',message:turnId+'：接续核对账单'}},{type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:turnId,last_agent_message:turnId+'：已处理，待客户测试'}}].map(JSON.stringify).join('\n')+'\n';};
  const old=path.join(home,'archived_sessions','rollout-old-chat.jsonl'),fresh=path.join(home,'sessions','rollout-new-chat.jsonl');await fs.mkdir(path.dirname(old),{recursive:true});await fs.mkdir(path.dirname(fresh),{recursive:true});
  await fs.writeFile(old,rows('old-chat',cwd,'morning','01'));await fs.writeFile(fresh,rows('new-chat',cwd,'afternoon','07'));await fs.writeFile(path.join(home,'sessions','rollout-sibling.jsonl'),rows('sibling',cwd+'-other','unrelated','08'));
  const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:data,CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  const request=(action,payload={})=>page.evaluate(({action,payload})=>window.fde.request(action,payload),{action,payload});
  const current=async()=> (await request('state')).projects.find(v=>v.id===p.id);
  async function until(fn,label){for(let i=0;i<180;i++){if(await fn())return;await pause(70);}throw new Error(label);}
  async function organize(){await page.locator('[data-route="overview"]').first().click();await page.locator('[data-action="daily-current"]').click();await until(async()=>!(await page.locator('[data-action="daily-current"]').isDisabled()),'整理未结束');}
  try{
    app=await electron.launch({executablePath:process.env.FDE_SMOKE_EXECUTABLE||require('electron'),args:process.env.FDE_SMOKE_EXECUTABLE?[]:[ROOT],env,timeout:40000});await app.firstWindow();
    await until(()=>{page=app.windows().find(w=>w.url().endsWith('/index.html'));return !!page;},'工作台未打开');page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
    await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.setAlwaysOnTop(false);if(w.webContents.getURL().endsWith('/index.html'))w.show();}});
    await page.locator('[data-action="daily-current"]').waitFor();check((await request('daily:raw',{id:p.id,date:DATE})).turns.length===0&&inputs.length===0,'启动不抓取对话或请求模型');
    await organize();check(inputs.length===1&&inputs[0].sources.length===2,'一次点击接续归档旧会话与当天新会话');check(inputs[0].sources.map(s=>s.threadId).join(',')==='old-chat,new-chat','输入按时间连续且其他项目不混入');
    check((await page.locator('.daily-inline-status').innerText()).includes('2 个会话'),'项目概览显示当日会话数');
    await page.locator('[data-route="codex"]').click();await page.locator('#codex-original summary').click();await until(async()=>await page.locator('#codex-turns .turn-card').count()===2,'本地对话未展示');check(true,'展开缓存可追溯旧、新两段对话');
    await page.locator('[data-action="bind-codex"]').click();check((await page.locator('#modal-form').innerText()).includes('已归档'),'会话选择器标记已归档会话');await page.locator('input[name="threadId"][value="new-chat"]').check();await page.locator('#modal-form [type="submit"]').click();await until(async()=>!(await page.locator('#form-dialog').evaluate(d=>d.open)),'重新绑定未保存');
    check((await current()).records.length===1&&(await current()).dailyDesk.days[DATE].threadCount===2,'同目录更换入口不清空当天成果与收录');await organize();check(inputs.length===1,'更换入口或重复整理不重复请求模型');
    await fs.appendFile(fresh,rows('new-chat',cwd,'evening','09'));await organize();check(inputs.length===2&&inputs[1].sources.length===1&&inputs[1].sources[0].text.includes('evening'),'后续整理只提交新增对话');check((await current()).records.length===1,'同一业务连续修改合为一项');
    await page.screenshot({path:path.join(out,`project-day-success-${process.env.FDE_SMOKE_EXECUTABLE?'portable':'source'}.png`)});
    await fs.unlink(old);await organize();check(inputs.length===2&&(await request('daily:raw',{id:p.id,date:DATE})).turns.length===3,'旧会话实体消失后仍保留已收录内容');
    await fs.unlink(fresh);await organize();check((await current()).dailyDesk.days[DATE].status==='error'&&inputs.length===2,'所有项目会话不可读取时明确失败且不请求模型');check((await current()).records.length===1,'读取失败保留工作成果');
    await page.screenshot({path:path.join(out,`project-day-${process.env.FDE_SMOKE_EXECUTABLE?'portable':'source'}.png`)});
    check(errors.length===0,'无页面或模拟模型异常');const result={checks:checks.length,modelRequests:inputs.length,errors,boundary:'隔离数据、模拟会话与本机模型；未读取真实业务或使用真实密钥'};await fs.writeFile(path.join(out,`project-day-${process.env.FDE_SMOKE_EXECUTABLE?'portable':'source'}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{if(app)await app.close();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
