'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{_electron}=require('playwright'),Zip=require('adm-zip'),{Store}=require('../src/core/store.cjs'),{manifest}=require('../desktop/data-migration.cjs');
const ROOT=path.resolve(__dirname,'..'),DATE='2026-10-23';
async function run(){
 const root=fs.mkdtempSync(path.join(ROOT,'test-output','business-focus-')),data=path.join(root,'data'),sourceDir=path.join(root,'source'),devDir=path.join(root,'dev');for(const p of [sourceDir,devDir])fs.mkdirSync(p);
 const seed=new Store(data),p=seed.createProject({name:'业务聚焦样例',sourceDir,devDir});seed.bindCodexThread(p.id,{threadId:'fixture'});
 const provenance={sourceIds:['turn:fixture'],turnIds:['fixture'],sourceRef:'codex:fixture#turn=fixture'};
 seed.applyDailyDesk(p.id,{date:DATE,threadId:'fixture',fingerprint:'fixture-business-focus',items:[{...provenance,issueKey:'fee',title:'修复金额核对',cause:'空金额造成分摊异常',action:'修复空值并同步两个EasyClaw项目',result:'自测通过，真实账单未重跑，未推送GitLab',status:'待验证'},{...provenance,issueKey:'sync',title:'同步EasyClaw',action:'同步失败',result:'未推送GitLab',status:'未解决'}],requirements:[{...provenance,requirementKey:'fee',title:'核对金额',description:'按实际标准核对',status:'待确认',questions:['收费标准如何确认？','是否同步EasyClaw？']},{...provenance,requirementKey:'sync',title:'同步EasyClaw',description:'更新本地应用',status:'待确认',questions:[]}],confirmations:[{...provenance,confirmationKey:'price',scenario:'客户报价口径不一致',question:'采用哪个收费标准？',status:'待确认',workaround:'暂按现行标准',resolution:''},{...provenance,confirmationKey:'sync',scenario:'本地应用发布',question:'是否同步EasyClaw？',status:'待确认',workaround:'',resolution:''}],digest:{workEvidenceVersion:2,overview:{scene:'核对业务账单',requirements:'按业务规则计算',progress:'金额已修复，未推送GitLab',nextAction:'同步EasyClaw',blocker:'GitLab未同步'},reportText:'修复金额核对，真实账单未重跑，未推送GitLab。'}});
 seed.setRequirementFilter(p.id,'','all');
 const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:data,CODEX_HOME:path.join(root,'codex')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:process.env.FDE_SMOKE_EXECUTABLE||require('electron'),args:process.env.FDE_SMOKE_EXECUTABLE?[]:[process.env.FDE_SMOKE_APP_ROOT||ROOT],env,timeout:40000}),checks=[],errors=[];
 const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};const until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw Error(label);};
 const archiveManifest=()=>Object.fromEntries(Object.entries(manifest(data)).filter(([name])=>!name.startsWith('runtime')));
 try{
  await until(()=>app.windows().some(w=>w.url().endsWith('/index.html')),'工作台未打开');const page=app.windows().find(w=>w.url().endsWith('/index.html'));page.on('pageerror',e=>errors.push(e.message));await page.waitForSelector('[data-route="records"]');
  const before=archiveManifest();check(JSON.stringify(seed.getState().projects[0].records).includes('EasyClaw'),'样例保留带工具状态的原始历史内容');
  await page.locator('button[data-route="overview"]').click();const overview=await page.locator('.daily-organizer').innerText();check(!/GitLab|EasyClaw/.test(overview)&&overview.includes('金额已修复'),'概览只显示业务进展');
  await page.locator('[data-route="requirements"]').click();const requirements=await page.locator('#workspace').innerText();check(!/GitLab|EasyClaw/.test(requirements)&&requirements.includes('收费标准如何确认')&&requirements.includes('采用哪个收费标准'),'需求保留真实客户确认，去掉工具问题');
  await page.locator('[data-route="records"]').click();await page.locator('#record-history').selectOption(DATE);await until(async()=>await page.locator('.record-card').count()===1,'纯工具工作未过滤');const work=await page.locator('.record-card').innerText();check(!/GitLab|EasyClaw/.test(work)&&work.includes('真实账单未重跑')&&work.includes('待验证'),'工作记录保留业务验证限制');
  const output=path.join(root,'业务工作.xlsx');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);await page.locator('#export-records').click();await until(()=>fs.existsSync(output),'导出失败');const xml=new Zip(output).readAsText('xl/worksheets/sheet1.xml');check(!/GitLab|EasyClaw/.test(xml)&&xml.includes('真实账单未重跑')&&xml.includes(DATE),'导出与业务视图一致且保留工作日期');
  await page.locator('[data-route="reports"]').click();await page.locator('#report-history').selectOption(DATE);await until(async()=>(await page.locator('#report-preview').innerText()).includes('真实账单未重跑'),'日报未展示');check(!/GitLab|EasyClaw/.test(await page.locator('#report-preview').innerText()),'日报去掉工具状态');
  assert.deepEqual(archiveManifest(),before);check(true,'页面与导出不修改原记录和历史版本');check(errors.length===0,'页面无运行错误');
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({checks,errors}));console.log(JSON.stringify({checks:checks.length,errors:errors.length,root,boundary:'独立样例档案、真实桌面页面及导出，不调用真实模型'}));
 }finally{await app.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
