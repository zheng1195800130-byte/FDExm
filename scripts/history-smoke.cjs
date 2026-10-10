'use strict';

// Historical UI coverage uses an isolated data directory and mock IPC responses.
// Core history parsing/model backfill is covered by separate tests.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const EXECUTABLE=process.env.FDE_SMOKE_EXECUTABLE||require('electron');
const dates=['2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26'];

async function hashFile(file){try{return createHash('sha256').update(await fs.readFile(file)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function run(){
  const out=path.join(ROOT,'test-output');await fs.mkdir(out,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(out,'历史日期 UI '));
  const dataDir=path.join(fixture,'data'),home=path.join(fixture,'Codex');await Promise.all([dataDir,home].map(dir=>fs.mkdir(dir,{recursive:true})));
  const realStore=path.join(ROOT,'release','FDE Desk-win32-x64','data','store.json'),realBefore=await hashFile(realStore);
  const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:dataDir,CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  const checks=[],errors=[];let app,page;
  const check=(condition,message)=>{assert.ok(condition,message);checks.push(message);};
  async function eventually(predicate,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(message);}
  try{
    app=await electron.launch({executablePath:EXECUTABLE,args:process.env.FDE_SMOKE_EXECUTABLE?[]:[ROOT],env,timeout:30000});
    await app.firstWindow();
    await eventually(async()=>{page=app.windows().find(window=>window.url().endsWith('/index.html'));return!!page;},'工作台窗口未载入');
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html'));window.show();window.focus();});
    page.setDefaultTimeout(12000);await page.waitForSelector('#workspace');page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({ipcMain,BrowserWindow},workDates)=>{
      const makeProject=(id,name,threadId)=>({id,name,sourceDir:'D:\\isolated\\source',devDir:'D:\\isolated\\dev',stage:'维护中',activeCycleId:`${id}-cycle`,cycles:[{id:`${id}-cycle`,name:'首次交付'}],files:[],requirements:[],records:[],reports:[],deliveries:[],codex:{threadId,dailySummaries:[],summaryDismissals:[],summaryStatus:{state:'ready',message:'已按日整理'}}});
      const a=makeProject('history-a','历史报关项目','history-thread-a'),b=makeProject('history-b','另一个历史项目','history-thread-b');
      a.codex.history={threadId:a.codex.threadId,dates:workDates,completedDates:[workDates.at(-1)],failedDates:[{date:workDates[2],message:'模型服务暂时不可用，可稍后重试。'}],truncated:false,updatedAt:new Date().toISOString()};
      a.codex.dailySummaries=[{date:workDates.at(-1),method:'model',updatedAt:new Date().toISOString(),items:[{issueKey:'history-task',title:'历史账单整理',cause:'旧账单结构需要归一',action:'完成当日账单处理',result:'自测完成，等待客户测试',status:'待验证',turnIds:['history-turn-26']}]}];
      b.codex.history={threadId:b.codex.threadId,dates:['2026-09-12'],completedDates:[],failedDates:[],truncated:true};
      const mock=globalThis.__fdeHistoryUi={state:{projects:[a,b],settings:{activeProjectId:a.id},modelSettings:{enabled:true,keyConfigured:true}},reads:[],pending:[],releases:0};
      mock.notify=()=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('fde:changed',{});};
      mock.turns=(payload)=>({thread:{id:mock.state.projects.find(project=>project.id===payload.id).codex.threadId},turns:[{id:`turn-${payload.date}`,date:payload.date,timestamp:`${payload.date}T01:00:00Z`,userText:`${payload.date} 的工作问题`,assistantText:`## ${payload.date} 的处理结果\n\n- 已完成有效处理`,attachments:[]}],truncated:payload.date===workDates[3],warning:'本日原对话较大，仅载入部分内容。'});
      ipcMain.removeHandler('fde:request');
      ipcMain.handle('fde:request',async(_event,{action,payload={}})=>{
        try{
          let value;
          if(action==='state')value=mock.state;
          else if(action==='project:select'){mock.state.settings.activeProjectId=payload.id;value=true;}
          else if(action==='codex:read'){
            mock.reads.push(payload);
            if(payload.date===workDates[0])value=await new Promise(resolve=>mock.pending.push(()=>{mock.releases++;resolve(mock.turns(payload));}));
            else if(payload.date===workDates[2])throw new Error('这天的原对话暂时读取失败，请稍后重试。');
            else value=mock.turns(payload);
          }else if(action==='report:generate')value={text:'',needsReview:false};
          else if(action==='summary:run')value=true;
          else throw new Error(`测试未提供此接口：${action}`);
          return{ok:true,value};
        }catch(error){return{ok:false,error:error.message};}
      });
    },dates);
    await page.reload();await page.waitForSelector('#project-select');
    await page.locator('[data-route="codex"]').first().click();
    await eventually(async()=>await page.locator('#codex-date').inputValue()===dates.at(-1),'历史项目未默认进入最近工作日');
    check(await page.locator('.summary-card h3').innerText()==='历史账单整理','没有今日工作时默认显示最近历史工作日');
    const options=await page.locator('#codex-history option').evaluateAll(nodes=>nodes.map(node=>node.value));
    check(dates.every(date=>options.includes(date)),'尚未成功整理的历史日期同样进入历史日期列表');
    const progress=await page.locator('.history-progress').innerText();
    check(progress.includes('共 6 天')&&progress.includes('已整理 1 天')&&progress.includes('待补齐 4 天')&&progress.includes('1 天暂未完成'),'历史补齐进度同时显示已完成、待补齐及失败日期数');
    check(await page.locator('#codex-original').getAttribute('open')===null&&(await app.evaluate(()=>globalThis.__fdeHistoryUi.reads.length))===0,'进入历史项目不会自动读取或展开全部原对话');
    await page.locator('.history-failures > summary').click();
    check((await page.locator('.history-failures').innerText()).includes('模型服务暂时不可用'),'失败原因可展开查看，其他日期成果仍能读取');
    await app.evaluate(()=>{const mock=globalThis.__fdeHistoryUi;mock.state.projects[0].codex.history.failedDates.push({date:'2026-09-26',message:'重新整理暂时失败，保留之前的有效成果。'});mock.notify();});
    await eventually(async()=>(await page.locator('.history-progress').innerText()).includes('2 天暂未完成'),'已有成功摘要日期的新失败未显示');
    await page.locator('.history-failures > summary').click();
    const retryProgress=await page.locator('.history-progress').innerText();
    check(retryProgress.includes('已整理 0 天')&&retryProgress.includes('2 天暂未完成')&&retryProgress.includes('重新整理暂时失败')&&(await page.locator('.summary-card h3').innerText())==='历史账单整理','已有摘要的日期重试失败仍明确显示，已整理计数排除失败日且旧成果保留');
    await app.evaluate(()=>{const mock=globalThis.__fdeHistoryUi;mock.state.projects[0].codex.history.failedDates=mock.state.projects[0].codex.history.failedDates.filter(entry=>entry.date!=='2026-09-26');mock.notify();});
    await eventually(async()=>(await page.locator('.history-progress').innerText()).includes('已整理 1 天'),'恢复成功日期后的进度未更新');
    await page.locator('.history-failures > summary').click();
    await page.screenshot({path:path.join(out,process.env.FDE_SMOKE_EXECUTABLE?'17-历史项目补齐-便携版.png':'17-历史项目补齐-源码.png')});
    await page.locator('#codex-history').selectOption(dates[0]);
    check((await page.locator('#daily-summaries').innerText()).includes('这天的历史工作正在补齐'),'未整理日期展示补齐提示而非误报没有历史工作');
    await page.locator('#codex-original > summary').click();
    await eventually(async()=>(await app.evaluate(()=>globalThis.__fdeHistoryUi.reads.length))===1,'未发起指定日期原文读取');
    await page.locator('#codex-history').selectOption(dates[1]);
    check(await page.locator('#codex-original').getAttribute('open')===null,'切换日期关闭并清空上一日原文');
    await page.locator('#codex-original > summary').click();await page.waitForSelector('.turn-card');
    check((await page.locator('#codex-turns').innerText()).includes(`${dates[1]} 的工作问题`),'原对话请求带所选日期并只呈现该日内容');
    await app.evaluate(()=>{for(const release of globalThis.__fdeHistoryUi.pending.splice(0))release();});
    await eventually(async()=>(await app.evaluate(()=>globalThis.__fdeHistoryUi.releases))===1,'旧日期延迟响应未完成');
    await new Promise(resolve=>setTimeout(resolve,300));
    check((await page.locator('#codex-turns').innerText()).includes(`${dates[1]} 的工作问题`)&&!(await page.locator('#codex-turns').innerText()).includes(`${dates[0]} 的工作问题`),'旧日期的迟到响应不会覆盖当前日期原文');
    await app.evaluate(()=>{const mock=globalThis.__fdeHistoryUi,project=mock.state.projects[0];project.codex.history.completedDates.push('2026-09-25');project.codex.dailySummaries.push({date:'2026-09-25',items:[]});mock.notify();});
    await eventually(async()=>(await page.locator('.history-progress').innerText()).includes('已整理 2 天'),'后台进度未更新');
    check(await page.locator('#codex-date').inputValue()===dates[1]&&(await page.locator('#codex-turns').innerText()).includes(`${dates[1]} 的工作问题`),'后台补齐更新保留手选日期和对应原文');
    await page.locator('#project-select').selectOption('history-b');
    await eventually(async()=>await page.locator('#codex-date').inputValue()==='2026-09-12','切换项目未使用自己的历史工作日');
    check((await page.locator('.history-range-warning').innerText()).includes('部分内容尚未载入'),'历史扫描不完整时保留明确范围提示');
    await page.locator('#project-select').selectOption('history-a');
    await eventually(async()=>await page.locator('#codex-date').inputValue()===dates[1],'切回项目未保留已手选日期');
    check(await page.locator('#codex-original').getAttribute('open')===null,'跨项目切换不会复用其他项目的原文');
    await page.locator('#codex-history').selectOption(dates[2]);
    check((await page.locator('#daily-summaries').innerText()).includes('这天的整理暂未完成'),'失败日期与待补齐日期分别说明');
    await page.locator('#codex-original > summary').click();await page.waitForSelector('#codex-turns .notice.warning');
    check((await page.locator('#codex-turns').innerText()).includes('这天的原对话暂时读取失败'),'原文读取失败在当前日期明确提示');
    await page.locator('#codex-history').selectOption(dates[3]);await page.locator('#codex-original > summary').click();await page.waitForSelector('.turn-card');
    check((await page.locator('#codex-turns .notice.warning').innerText()).includes('仅载入部分内容'),'单日原文截断时保留范围提示且不阻止展示已有内容');
    await page.locator('.turn-detail > summary').click();
    check(await page.locator('.turn-assistant .markdown-body h2').innerText()===`${dates[3]} 的处理结果`,'历史原对话继续支持 Markdown 阅读');
    const reads=await app.evaluate(()=>globalThis.__fdeHistoryUi.reads);
    check(reads.every(read=>read.id==='history-a'&&dates.includes(read.date)),'每次读取均带项目与所选日期，不请求整个历史会话原文');
    check(errors.length===0,'历史页面没有渲染器未处理异常');
    check(realBefore===await hashFile(realStore),'验收没有修改真实便携版数据');
    const reportPath=path.join(out,process.env.FDE_SMOKE_EXECUTABLE?'历史项目UI验收-便携版.json':'历史项目UI验收-源码.json');
    await fs.writeFile(reportPath,JSON.stringify({status:'passed',mode:process.env.FDE_SMOKE_EXECUTABLE?'portable':'source',checks,readRequests:reads,fixture,boundary:'隔离 IPC 假数据，仅验证页面与异步隔离；不调用真实模型，不替代核心历史扫描测试',realStoreUnchanged:true},null,2));
    console.log(JSON.stringify({status:'passed',checkCount:checks.length,report:reportPath,realStoreUnchanged:true}));
  }finally{if(app)await app.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
