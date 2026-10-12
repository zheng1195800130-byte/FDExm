'use strict';
const {_electron:electron}=require('playwright'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {Store}=require('../src/core/store.cjs');
const ROOT=path.resolve(__dirname,'..'),portable=!!process.env.FDE_SMOKE_EXECUTABLE;
async function run(){
 const output=path.join(ROOT,'test-output'),dir=await fs.mkdtemp(path.join(output,'archive-smoke-')),data=path.join(dir,'data'),home=path.join(dir,'codex');await fs.mkdir(home);
 const store=new Store(data),projects=[];for(const name of ['验收项目甲','验收项目乙']){const sourceDir=path.join(dir,name,'资料'),devDir=path.join(dir,name,'开发');await fs.mkdir(sourceDir,{recursive:true});await fs.mkdir(devDir,{recursive:true});await fs.writeFile(path.join(sourceDir,'说明.md'),'隔离资料');const p=store.createProject({name,sourceDir,devDir});await store.scanProject(p.id);store.saveReport(p.id,'2026-10-12',`${name} 完成隔离验收`);projects.push(p);}
 const [a,b]=projects;store.setSettings({activeProjectId:a.id});store.saveSummarizerSettings({enabled:false,provider:'compatible',baseUrl:'http://127.0.0.1:1/v1',model:'disabled'});
 const original=store.getState().projects.map(p=>({id:p.id,reports:p.reports,files:p.files.map(f=>f.id)})),checks=[],errors=[],network=[];let app,page,panel;
 const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
 const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:data,CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){app=await electron.launch({executablePath:process.env.FDE_SMOKE_EXECUTABLE||require('electron'),args:portable?[]:[ROOT],env,timeout:40000});await app.firstWindow();for(let i=0;i<100;i++){page=app.windows().find(p=>p.url().endsWith('/index.html'));panel=app.windows().find(p=>p.url().endsWith('/float.html'));if(page&&panel)break;await new Promise(r=>setTimeout(r,60));}assert.ok(page&&panel);for(const p of [page,panel]){p.setDefaultTimeout(12000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});}await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.setAlwaysOnTop(false);w.show();}});await page.waitForFunction(()=>document.querySelector('#project-select').options.length>0);}
 const request=(action,payload={})=>page.evaluate(({action,payload})=>window.fde.request(action,payload),{action,payload});
 async function selection(ids){for(const [surface,selector]of [[page,'#project-select'],[panel,'#float-project']]){await surface.waitForFunction(({selector,ids})=>JSON.stringify([...document.querySelector(selector).options].map(o=>o.value).filter(Boolean))===JSON.stringify(ids),{selector,ids});check(true,`${selector} 项目列表 ${ids.length} 项`);}}
 async function manager(){await page.locator('[data-action="manage-projects"]').first().click();await page.locator('#project-manager-content').waitFor();}
 async function action(kind,id){await page.locator(`#project-manager-content [data-action="${kind}-project"][data-project-id="${id}"]`).click();await page.locator(`#project-manager-content [data-action="${kind==='archive'?'restore':'archive'}-project"][data-project-id="${id}"]`).waitFor();}
 try{
  await launch();await selection([a.id,b.id]);await manager();await action('archive',a.id);await selection([b.id]);check((await request('state')).settings.activeProjectId===b.id,'归档当前项目自动切换');
  const state=await request('state');check(state.archivedProjects.length===1&&state.archivedProjects[0].id===a.id,'管理项目提供归档列表');check(!JSON.stringify(state.archivedProjects).includes('完成隔离验收'),'归档列表仅返回必要元数据');
  const report=await request('daily:report-all',{date:'2026-10-12',drafts:[]});check(!report.text.includes(a.name)&&report.text.includes(b.name),'全部日报排除归档项目');
  await action('archive',b.id);await selection([]);check(await page.locator('[data-action="daily-all"]').isDisabled(),'全部归档后整理按钮不可用');check(await panel.locator('#float-refresh').isDisabled(),'无关注项目悬浮刷新禁用');
  await page.screenshot({path:path.join(output,'project-archive-manager.png')});await app.close();app=null;
  await launch();await selection([]);check((await request('state')).archivedProjects.length===2,'重启保留归档状态');await manager();await action('restore',a.id);await selection([a.id]);check((await request('state')).settings.activeProjectId===a.id,'恢复后自动选择项目');
  await page.locator('[data-action="close-dialog"]').first().click();const restored=(await request('state')).projects[0];check(JSON.stringify(restored.reports)===JSON.stringify(original[0].reports),'恢复保留原日报');check(JSON.stringify(restored.files.map(f=>f.id))===JSON.stringify(original[0].files),'恢复保留文件身份');
  await manager();await action('restore',b.id);await selection([a.id,b.id]);check((await request('state')).archivedProjects.length===0,'全部恢复后归档列表为空');
  check(errors.length===0,'无渲染异常');check(network.length===0,'无网络或模型请求');
  const result={passed:checks.length,checks,errors,networkRequests:network.length};await fs.writeFile(path.join(output,`project-archive-${portable?'portable':'source'}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{if(app)await app.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
