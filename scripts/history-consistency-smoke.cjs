'use strict';
// Isolated desktop regression for local archive freshness. No real projects,
// model keys, Codex sessions or network services are used.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {_electron:electron}=require('playwright');
const {Store}=require('../src/core/store.cjs');
const ROOT=path.resolve(__dirname,'..'),DATE='2026-10-14',OLDER='2026-10-13';
const PORTABLE=process.env.FDE_SMOKE_EXECUTABLE,EXE=PORTABLE||require('electron');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
  const out=path.join(ROOT,'test-output');fs.mkdirSync(out,{recursive:true});
  const root=fs.mkdtempSync(path.join(out,'history-consistency-')),data=path.join(root,'data'),home=path.join(root,'codex');
  const sourceDir=path.join(root,'source'),devDir=path.join(root,'dev');for(const dir of [home,sourceDir,devDir])fs.mkdirSync(dir);
  const initial=new Store(data),p=initial.createProject({name:'历史一致性验收',sourceDir,devDir});
  initial.upsertRecord(p.id,{date:OLDER,title:'前天的历史工作',confirmed:true});
  initial.saveReport(p.id,OLDER,'前天的已保存日报');
  const env={...process.env,FDE_DATA_DIR:data,FDE_TEST:'1',CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  let app,page;const checks=[],errors=[];
  const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
  async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await pause(70);}throw new Error(label);}
  async function launch(){
    app=await electron.launch({executablePath:EXE,args:PORTABLE?[]:[ROOT],env,timeout:40000});await app.firstWindow();
    await until(()=>{page=app.windows().find(w=>w.url().endsWith('/index.html'));return!!page;},'工作台未启动');
    page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    await page.locator('[data-route="records"]').waitFor();
    await app.evaluate(({BrowserWindow,app})=>{
      const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
      const reader=require('./src/core/codex.cjs');globalThis.__historyReads=0;
      for(const name of ['readThread','readProjectDay'])reader[name]=async()=>{globalThis.__historyReads++;throw new Error('查看历史不得读取新对话');};
      for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().endsWith('/index.html')){w.setAlwaysOnTop(false);w.show();}
    });
  }
  async function route(name){await page.locator(`[data-route="${name}"]`).click();await page.locator(name==='records'?'#record-date':name==='reports'?'#report-date':'#requirement-after').waitFor();}
  async function date(id,value){await page.locator('#'+id).fill(value);await page.locator('#'+id).dispatchEvent('change');if(id==='record-date'){await page.locator('#record-end-date').fill(value);await page.locator('#record-end-date').dispatchEvent('change');}}
  function addWork(title){const writer=new Store(data);writer.upsertRecord(p.id,{date:DATE,title,confirmed:true});}
  try{
    await launch();await route('records');await date('record-date',DATE);check(await page.locator('.record-card').count()===0,'初始没有昨天的记录');
    addWork('昨天新增且已落盘的工作');
    let writer=new Store(data);writer.saveReport(p.id,DATE,'昨天完整日报');
    writer.applyRequirementSummary(p.id,{threadId:'',items:[{requirementKey:'history',title:'昨天的业务需求',description:'保留真实历史成果',status:'已明确',sourceIds:['turn:history'],sourceFirstAt:DATE+'T02:00:00Z',sourceLastAt:DATE+'T02:00:00Z'}],confirmations:[{confirmationKey:'history-question',scenario:'昨天的业务场景',question:'客户待确认口径',status:'待确认',sourceIds:['turn:history'],sourceFirstAt:DATE+'T02:00:00Z',sourceLastAt:DATE+'T02:00:00Z'}]});
    await date('record-date',OLDER);await until(async()=>await page.locator('.record-card').count()===1,'前天记录未显示');
    await page.locator('#record-history').selectOption(DATE);await until(async()=>(await page.locator('.record-card').allTextContents()).some(t=>t.includes('昨天新增')),'切换日期未读取新档案');
    check(true,'运行中外部落盘后，日期切换直接读到最新历史工作');
    await route('reports');await page.locator('#report-history').selectOption(DATE);await until(async()=>(await page.locator('#report-preview').innerText()).includes('昨天完整日报'),'昨天日报未刷新');
    check(await page.locator('.saved-report').count()===2,'日报历史列表与正文同时更新');
    await route('requirements');await page.locator('#requirement-history').selectOption(DATE);await until(async()=>await page.locator('.requirement-card').count()===1&&await page.locator('.requirement-confirmation').count()===1,'需求历史未刷新');
    check(true,'需求及待确认问题按昨天日期同步显示');
    await route('reports');await page.locator('[data-action="edit-report"]').click();await page.locator('#report-text').fill('人工未保存草稿');
    addWork('昨天第二项工作');await date('report-date',OLDER);await until(async()=>await page.locator('#report-text').inputValue()==='前天的已保存日报','前天日报未显示');
    await date('report-date',DATE);await until(async()=>await page.locator('#report-text').inputValue()==='人工未保存草稿','刷新丢失人工草稿');
    check((await page.locator('.report-stat').first().innerText()).includes('0'),'人工工作不伪装为自动整理');
    check(await page.locator('#report-text').inputValue()==='人工未保存草稿','日期切换刷新档案仍保留人工草稿');
    await page.evaluate(()=>window.fde.request('window:compact'));addWork('昨天第三项工作');
    const exit=await new Promise((resolve,reject)=>{
      const child=spawn(EXE,PORTABLE?[]:[ROOT],{env,windowsHide:true,stdio:'ignore'}),timer=setTimeout(()=>{child.kill();reject(new Error('第二次启动未退出'));},12000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);resolve(code);});
    });check(exit===0,'再次启动复用原实例');
    await until(async()=>(await page.locator('.report-stat').nth(1).innerText()).includes('3'),'复用旧实例时未刷新');
    check(await page.locator('#report-text').inputValue()==='人工未保存草稿','重新展开更新统计且保留正在编辑的日报');
    await page.locator('[data-action="save-report"]').click();await until(async()=>JSON.parse(fs.readFileSync(path.join(data,'store.json'),'utf8')).projects[0].reports.find(r=>r.date===DATE).text==='人工未保存草稿','人工日报未保存');
    await app.close();app=null;await launch();await route('records');await page.locator('#record-history').selectOption(DATE);await until(async()=>await page.locator('.record-card').count()===3,'重启缺少历史工作');
    await route('reports');await page.locator('#report-history').selectOption(DATE);await until(async()=>(await page.locator('#report-preview').innerText()).includes('人工未保存草稿'),'重启缺少已保存日报');
    check(true,'完整重启仍保留全部历史工作与人工保存日报');
    check(await app.evaluate(()=>globalThis.__historyReads)===0,'查看日期与再次启动不读取新对话或调用模型');
    // Deliberately return a captured old state after a newer refresh completed.
    const snapshot=await page.evaluate(()=>window.fde.request('state'));
    await app.evaluate(({ipcMain},snapshot)=>{
      globalThis.__historyMock={current:snapshot,hold:true,pending:[]};ipcMain.removeHandler('fde:request');
      ipcMain.handle('fde:request',async(_,{action})=>{
        if(action==='state'){
          const value=structuredClone(__historyMock.current);
          if(__historyMock.hold){__historyMock.hold=false;return new Promise(resolve=>__historyMock.pending.push(()=>resolve({ok:true,value})));}
          return {ok:true,value};
        }
        if(action==='report:generate')return {ok:true,value:{text:'',needsReview:false}};
        return {ok:true,value:true};
      });
    },snapshot);
    await page.locator('[data-route="records"]').click();await until(()=>app.evaluate(()=>__historyMock.pending.length===1),'未捕获旧响应');
    await app.evaluate(()=>{const p=__historyMock.current.projects[0],row={...p.records.at(-1),id:'newest-response',title:'更新的响应不得被覆盖',date:'2026-10-14'};p.records.push(row);p.dailyHistory['2026-10-14'].at(-1).records.push(structuredClone(row));});
    await page.locator('[data-route="records"]').click();await until(async()=>await page.locator('.record-card').count()===4,'新响应未展示');
    await app.evaluate(()=>__historyMock.pending.shift()());await pause(350);
    check(await page.locator('.record-card').count()===4&&(await page.locator('#record-date').inputValue())===DATE,'迟到的旧响应不能覆盖新数据或已选历史日期');
    check(errors.length===0,'无页面异常');
    const result={checks:checks.length,errors,boundary:'独立档案、合成历史内容、无真实会话与模型请求'};
    fs.writeFileSync(path.join(out,`history-consistency-${PORTABLE?'portable':'source'}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{if(app)await app.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
