'use strict';

// Real isolated filesystem/indexing and renderer clicks. Only scan delay/failure
// boundaries and the loopback model are mocked; no real customer data or key.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {Store}=require('../src/core/store.cjs');
const ROOT=path.resolve(__dirname,'..');
const EXECUTABLE=process.env.FDE_SMOKE_EXECUTABLE||require('electron');
const DATE='2026-10-09';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(value).digest('hex');
async function hashFile(file){try{return hash(await fs.readFile(file));}catch(error){if(error.code==='ENOENT')return null;throw error;}}

async function run(){
  const out=path.join(ROOT,'test-output');await fs.mkdir(out,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(out,'手动刷新资料 '));
  const dataDir=path.join(fixture,'data'),home=path.join(fixture,'独立 Codex'),sessions=path.join(home,'sessions','2026','10','09');
  await fs.mkdir(sessions,{recursive:true});
  const checks=[],errors=[];let modelRequests=0,requirementRequests=0,app,page,panel;
  const check=(condition,message)=>{assert.ok(condition,message);checks.push(message);};
  async function eventually(predicate,message,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(60);}throw new Error(message);}
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      assert.equal(req.url,'/v1/chat/completions');
      const input=JSON.parse(JSON.parse(raw).messages.at(-1).content);
      const requirements=Array.isArray(input.sources);
      if(requirements)requirementRequests++;else modelRequests++;
      const content=JSON.stringify({items:requirements?[]:[{issueKey:'material_work',title:'已有有效工作',cause:'样例需要调整',action:'完成样例处理',result:'自测通过，等待客户测试',status:'待验证',turnIds:input.allowedTurnIds}]});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
    }catch(error){errors.push(`mock: ${error.message}`);res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":{"message":"MOCK_ASSERTION_FAILED"}}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const seed=new Store(dataDir),projects=[];
  for(const label of ['A','B']){
    const sourceDir=path.join(fixture,`${label} 原始资料`),devDir=path.join(fixture,`${label} 开发项目`);
    await Promise.all([sourceDir,devDir].map(dir=>fs.mkdir(dir,{recursive:true})));
    await fs.writeFile(path.join(sourceDir,'客户业务.md'),`${label}原始旧词，原始业务资料。`);
    await fs.writeFile(path.join(devDir,'开发说明.md'),`${label}开发旧词，当前开发成果。`);
    projects.push(seed.createProject({name:`刷新验收 ${label}`,sourceDir,devDir}));
  }
  const [a,b]=projects,original=path.join(a.sourceDir,'客户业务.md'),artifact=path.join(a.devDir,'开发说明.md'),deleted=path.join(a.sourceDir,'将删除资料.md'),sameFile=path.join(a.sourceDir,'同长度样例.txt');
  await fs.writeFile(deleted,'待删除的旧资料。');await fs.writeFile(sameFile,'AAAA旧词');
  await seed.scanProject(a.id);await seed.scanProject(b.id);
  const supplementSource=path.join(fixture,'客户补充.md');await fs.writeFile(supplementSource,'补充旧词，客户补充业务。');
  const withSupplement=await seed.addFiles(a.id,[supplementSource]),supplement=withSupplement.files.find(file=>file.kind==='补充资料');
  const sourceFile=withSupplement.files.find(file=>file.path===original);
  seed.updateFile(a.id,sourceFile.id,{description:'人工用途：客户业务流程，需长期保留'});
  seed.updateFile(a.id,supplement.id,{description:'人工用途：客户后续补充'});
  seed.updateProject(a.id,{codex:{threadId:'material-refresh-isolated'}});
  seed.saveSummarizerSettings({enabled:true,provider:'compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'mock-material-refresh'});
  seed.setSettings({activeProjectId:a.id});
  const timestamp=`${DATE}T01:00:00Z`;
  await fs.writeFile(path.join(sessions,'rollout-material-refresh.jsonl'),[
    {type:'session_meta',timestamp,payload:{id:'material-refresh-isolated',cwd:a.devDir}},
    {type:'event_msg',timestamp,payload:{type:'task_started',turn_id:'material-initial'}},
    {type:'response_item',timestamp,payload:{type:'message',role:'user',content:[{type:'input_text',text:'请处理业务样例。'}]}},
    {type:'response_item',timestamp,payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'已完成样例处理，自测通过，等待客户测试。'}]}},
    {type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:'material-initial'}},
  ].map(JSON.stringify).join('\n')+'\n');
  const realStore=path.join(ROOT,'release','FDE Desk-win32-x64','data','store.json'),realBefore=await hashFile(realStore);
  const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:dataDir,CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
  const request=(action,payload={})=>page.evaluate(({action,payload})=>window.fde.request(action,payload),{action,payload});
  const projectState=async id=>(await request('state')).projects.find(project=>project.id===id);
  const signature=project=>hash(JSON.stringify({files:project.files,records:project.records,reports:project.reports}));
  const scanCalls=()=>app.evaluate(()=>globalThis.__fdeMaterialRefresh.calls);
  async function waitForText(id,filePath,text){await eventually(async()=>(await projectState(id)).files.find(file=>file.path===filePath)?.textPreview.includes(text),`索引未更新 ${path.basename(filePath)}`);}
  async function finishScan(surface){const button=surface==='float'?panel.locator('#float-refresh'):page.locator('[data-action="scan"]').first();await eventually(async()=>!(await button.isDisabled()),'刷新按钮没有结束loading');}
  async function selectProject(id){await panel.locator('#float-project').selectOption(id);await eventually(async()=>await page.locator('#project-select').inputValue()===id,'项目选择未同步到工作台');}
  try{
    app=await electron.launch({executablePath:EXECUTABLE,args:process.env.FDE_SMOKE_EXECUTABLE?[]:[ROOT],env,timeout:40000});await app.firstWindow();
    await eventually(async()=>{page=app.windows().find(window=>window.url().endsWith('/index.html'));panel=app.windows().find(window=>window.url().endsWith('/float.html'));return!!page&&!!panel;},'双窗口未载入');
    page.setDefaultTimeout(12000);panel.setDefaultTimeout(12000);
    for(const surface of [page,panel])surface.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){const url=window.webContents.getURL();if(url.endsWith('/index.html')||url.endsWith('/float.html')){window.setAlwaysOnTop(false);window.show();}}});
    await eventually(async()=>(await projectState(a.id)).codex.dailySummaries.length===1&&modelRequests===1,'隔离已有工作摘要未初始化');
    const initialRequests=modelRequests,initialWork=hash(JSON.stringify((await projectState(a.id)).codex.dailySummaries)),bBefore=signature(await projectState(b.id));
    check((await request('state')).dataDir===dataDir,'桌面软件使用独立管理数据目录与本地模拟模型');
    // Instrument the actual Store method. Shared main-process coalescing remains real.
    await app.evaluate(({app,BrowserWindow})=>{
      const load=process.mainModule.require.bind(process.mainModule),{Store}=load(load('node:path').join(app.getAppPath(),'src/core/store.cjs')),originalScan=Store.prototype.scanProject;
      const control=globalThis.__fdeMaterialRefresh={calls:[],hold:false,fail:false,releases:[]};
      Store.prototype.scanProject=async function(id,options){
        control.calls.push({id,options});
        if(control.hold)await new Promise(resolve=>control.releases.push(resolve));
        if(control.fail){control.fail=false;throw new Error('模拟刷新失败：当前目录暂时不可读取。');}
        return originalScan.call(this,id,options);
      };
      control.broadcast=()=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('fde:changed',{});};
    });
    await page.locator('[data-route="files"]').first().click();
    check((await panel.locator('#float-refresh').innerText()).includes('刷新资料')&&(await page.locator('[data-action="scan"]').first().innerText()).includes('刷新资料'),'悬浮窗与工作台都有明确的刷新资料按钮');
    await page.locator('#file-search').fill('原始旧词');await panel.locator('#float-search').fill('原始旧词');
    check(await page.locator('[data-action="preview-file"]').count()===1&&await panel.locator('.float-file').count()===1,'初始资料正文可在两个窗口检索');
    const sameStat=await fs.stat(sameFile);
    await Promise.all([
      fs.writeFile(original,'A原始新词，客户已修改原始业务资料。'),
      fs.writeFile(artifact,'A开发新词，开发成果已更新。'),
      fs.writeFile(supplement.path,'补充新词，客户补充资料已更新。'),
      fs.writeFile(path.join(a.sourceDir,'新增业务.md'),'新增客户业务资料。'),
      fs.writeFile(sameFile,'BBBB新词'),
      fs.unlink(deleted),
    ]);
    await fs.utimes(sameFile,sameStat.atime,sameStat.mtime);
    const sourceAfterUserEdit=await hashFile(original);
    await panel.locator('#float-refresh').click();
    await waitForText(a.id,original,'原始新词');await finishScan('float');
    const refreshed=await projectState(a.id);
    check(refreshed.files.find(file=>file.path===artifact).textPreview.includes('开发新词')&&refreshed.files.find(file=>file.path===supplement.path).textPreview.includes('补充新词'),'悬浮刷新同时重提取原始、开发成果和已收录补充资料正文');
    check(refreshed.files.some(file=>file.name==='新增业务.md')&&refreshed.files.find(file=>file.path===deleted)?.missing,'新增资料进入索引，已删资料仅保留内部历史身份');
    const sameAfter=await fs.stat(sameFile);
    check(refreshed.files.find(file=>file.path===sameFile).textPreview==='BBBB新词'&&sameAfter.size===sameStat.size&&sameAfter.mtime.toISOString()===sameStat.mtime.toISOString(),'手动刷新强制重提取同长度、同mtime的已修改资料');
    check(refreshed.files.find(file=>file.path===original).description==='人工用途：客户业务流程，需长期保留'&&refreshed.files.find(file=>file.path===supplement.path).description==='人工用途：客户后续补充','刷新保留人工用途介绍');
    check(await page.locator('#file-search').inputValue()==='原始旧词'&&await panel.locator('#float-search').inputValue()==='原始旧词','刷新保留两个窗口现有检索条件');
    await page.locator('#file-search').fill('原始新词');await panel.locator('#float-search').fill('原始新词');
    await eventually(async()=>await page.locator('[data-action="preview-file"]').count()===1&&await panel.locator('.float-file').count()===1,'悬浮刷新后的正文没有同步到两个窗口检索');
    await page.locator('[data-action="edit-file"]').first().click();await page.locator('#field-description').fill('尚未保存的用途介绍');
    await panel.locator('#float-refresh').click();await finishScan('float');await pause(250);
    check(await page.locator('#form-dialog').getAttribute('open')!==null&&await page.locator('#field-description').inputValue()==='尚未保存的用途介绍','悬浮刷新不会关闭工作台正在编辑的弹窗或覆盖未保存内容');
    await page.locator('#modal-form [data-action="close-dialog"]').last().click();
    check(await hashFile(original)===sourceAfterUserEdit,'资料刷新只读取用户原件，不修改其文件内容');
    await page.locator('#file-search').fill('将删除资料');await panel.locator('#float-search').fill('将删除资料');
    check(await panel.locator('.float-file').count()===0&&await page.locator('[data-action="preview-file"]').count()===0,'已删资料不出现在工作台、悬浮窗或关键词检索中');
    check(Number(await page.locator('[data-route="files"] .nav-count').innerText())===refreshed.files.filter(file=>!file.hidden&&!file.missing).length,'资料库数量只统计仍可用的资料');
    check((await panel.locator('#float-files').innerText()).includes('没有匹配资料')&&(await page.locator('#file-results').innerText()).includes('没有匹配的资料'),'删除后检索为空仍提供清楚的空状态');
    await fs.writeFile(deleted,'恢复的业务资料。');await panel.locator('#float-refresh').click();await waitForText(a.id,deleted,'恢复的业务资料');await finishScan('float');
    await eventually(async()=>await panel.locator('.float-file').count()===1&&await page.locator('[data-action="preview-file"]').count()===1,'同路径恢复后没有重新显示');
    const restored=(await projectState(a.id)).files.find(file=>file.path===deleted);
    check(!restored.missing&&restored.id===refreshed.files.find(file=>file.path===deleted).id,'文件同路径恢复后双窗重新显示并沿用原身份');
    check(signature(await projectState(b.id))===bBefore,'刷新当前项目不会改动另一个项目索引或工作记录');
    await fs.writeFile(artifact,'A开发第二新词，工作台刷新同步验证。');
    await page.locator('#file-search').fill('开发第二新词');await panel.locator('#float-search').fill('开发第二新词');
    await page.locator('[data-action="scan"]').first().click();await waitForText(a.id,artifact,'开发第二新词');await finishScan('workbench');
    await eventually(async()=>await panel.locator('.float-file').count()===1&&await page.locator('[data-action="preview-file"]').count()===1,'工作台刷新没有同步悬浮检索');
    check((await page.locator('#material-scan-status').innerText()).length>0&&!(await panel.locator('#float-scan-status').isVisible())&&(await panel.locator('#float-refresh').getAttribute('title')).includes('已更新'),'工作台显示刷新状态，悬浮框成功信息只保留在按钮提示中');

    const beforeDelay=(await scanCalls()).length;
    await app.evaluate(()=>{globalThis.__fdeMaterialRefresh.hold=true;});
    await panel.locator('#float-refresh').click();
    await eventually(async()=>(await scanCalls()).length===beforeDelay+1,'延迟扫描没有启动');
    check(await panel.locator('#float-refresh').isDisabled()&&await panel.locator('#float-refresh').getAttribute('aria-busy')==='true'&&(await panel.locator('#float-refresh').innerText()).includes('刷新中'),'刷新中明确显示loading并禁用重复操作');
    await panel.locator('#float-refresh').evaluate(button=>{for(let index=0;index<4;index++)button.click();});
    await app.evaluate(()=>globalThis.__fdeMaterialRefresh.broadcast());await pause(250);
    check(await panel.locator('#float-refresh').isDisabled(),'广播更新期间刷新按钮仍保持锁定');
    await page.locator('[data-action="scan"]').first().click();await pause(150);
    check((await scanCalls()).length===beforeDelay+1,'同窗重复点击及两窗口并发刷新合并为一次目录扫描');
    await app.evaluate(()=>{const control=globalThis.__fdeMaterialRefresh;control.hold=false;for(const release of control.releases.splice(0))release();});
    await finishScan('float');await finishScan('workbench');
    check((await scanCalls()).every(call=>call.options?.force===true),'每次手动刷新都向索引器传递force强制重提取');

    await app.evaluate(()=>{globalThis.__fdeMaterialRefresh.fail=true;});await panel.locator('#float-refresh').click();await finishScan('float');
    await eventually(async()=>(await panel.locator('#float-scan-status').innerText()).includes('模拟刷新失败'),'悬浮窗没有展示刷新错误');
    check((await panel.locator('#toast').getAttribute('class')).includes('error')&&!(await panel.locator('#float-scan-status').innerText()).includes('已刷新成功'),'悬浮刷新失败保留错误提示，不报假成功');
    await app.evaluate(()=>{globalThis.__fdeMaterialRefresh.fail=true;});await page.locator('[data-action="scan"]').first().click();await finishScan('workbench');
    await eventually(async()=>(await page.locator('#material-scan-status').innerText()).includes('模拟刷新失败'),'工作台没有展示刷新错误');
    check((await page.locator('#toast').getAttribute('class')).includes('error'),'工作台刷新失败同样给出明确错误');

    await fs.writeFile(path.join(b.sourceDir,'客户业务.md'),'B原始新词，另一个项目的新资料。');
    await panel.locator('#float-refresh').click();await finishScan('float');
    check(!(await projectState(b.id)).files.find(file=>file.name==='客户业务.md').textPreview.includes('原始新词'),'A项目刷新不会顺带扫描B项目新文件内容');
    await selectProject(b.id);await page.locator('#file-search').fill('B原始新词');await panel.locator('#float-search').fill('B原始新词');
    const aBeforeB=signature(await projectState(a.id));
    await panel.locator('#float-refresh').click();await waitForText(b.id,path.join(b.sourceDir,'客户业务.md'),'B原始新词');await finishScan('float');
    check(signature(await projectState(a.id))===aBeforeB,'切换到B后只刷新B，不串写A项目');
    await selectProject(a.id);
    await page.locator('[data-route="reports"]').first().click();await page.locator('#report-date').fill(DATE);await page.locator('[data-action="edit-report"]').click();
    const draft='# 尚未保存的日报\n\n- 客户业务资料已更新，保留这份人工编辑。';
    await page.locator('#report-text').fill(draft);await panel.locator('#float-refresh').click();await finishScan('float');await pause(250);
    check(await page.locator('#report-text').inputValue()===draft&&await page.locator('#report-text').isVisible(),'悬浮刷新广播不会覆盖或关闭工作台未保存的日报编辑草稿');
    check((await projectState(a.id)).reports.length===0,'资料刷新不会擅自保存日报草稿');
    check(modelRequests===initialRequests&&hash(JSON.stringify((await projectState(a.id)).codex.dailySummaries))===initialWork,'资料刷新不重算已有工作摘要；新增业务正文的需求请求独立记录');
    await page.locator('[data-route="overview"]').first().click();
    check(await page.locator('[data-action="scan"]').count()>0,'项目概览的关联目录区域也提供手动刷新入口');
    await page.locator('[data-action="scan"]').first().click();await finishScan('workbench');
    check((await page.locator('#material-scan-status').innerText()).length>0,'概览刷新入口真实可用并显示结果');
    check(modelRequests===initialRequests,'概览刷新同样不重算工作摘要');
    await page.locator('[data-route="files"]').first().click();await page.locator('#file-search').fill('开发第二新词');await panel.locator('#float-search').fill('开发第二新词');
    const screenshot=path.join(out,process.env.FDE_SMOKE_EXECUTABLE?'18-手动刷新资料工作台-便携版.png':'18-手动刷新资料工作台-源码.png'),floatScreenshot=path.join(out,process.env.FDE_SMOKE_EXECUTABLE?'19-手动刷新资料悬浮窗-便携版.png':'19-手动刷新资料悬浮窗-源码.png');
    await page.screenshot({path:screenshot});await panel.screenshot({path:floatScreenshot});
    check(errors.length===0,'资料刷新两窗口没有未处理渲染异常');
    check(realBefore===await hashFile(realStore),'验收没有修改真实便携版管理数据');
    const reportPath=path.join(out,process.env.FDE_SMOKE_EXECUTABLE?'手动刷新资料验收-便携版.json':'手动刷新资料验收-源码.json');
    const report={status:'passed',mode:process.env.FDE_SMOKE_EXECUTABLE?'portable':'source',checks,fixture,screenshot,floatScreenshot,modelRequests,refreshModelRequests:modelRequests-initialRequests,requirementRequests,scanCalls:await scanCalls(),realStoreUnchanged:true,boundary:'文件索引与双窗点击为真实流程；仅扫描延迟/失败边界及本地模型响应使用mock，不访问真实模型或密钥；工作摘要与资料业务需求请求分别计数'};
    await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,mode:report.mode,checkCount:checks.length,modelRequests,refreshModelRequests:report.refreshModelRequests,realStoreUnchanged:true,report:reportPath,screenshot,floatScreenshot}));
  }finally{
    if(app){try{await app.evaluate(()=>{const control=globalThis.__fdeMaterialRefresh;if(control){control.hold=false;for(const release of control.releases.splice(0))release();}});}catch{}await app.close();}
    server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
