'use strict';

// Source startup fallback and single-instance locking are tested in a copied
// application with fake release/data directories. The placeholder EXE is never
// executed. No real data path, API credential or customer session is loaded.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {Store}=require('../src/core/store.cjs');
const ROOT=path.resolve(__dirname,'..');
const ELECTRON=require('electron');
const PORTABLE=process.env.FDE_STARTUP_PORTABLE_EXE?path.resolve(process.env.FDE_STARTUP_PORTABLE_EXE):'';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

async function run(){
  const out=path.join(ROOT,'test-output');await fs.mkdir(out,{recursive:true});
  const fixture=await fs.mkdtemp(path.join(out,'启动路径 单实例 ')),appDir=path.join(fixture,'隔离源码 中文 空格');
  await fs.mkdir(appDir);
  await Promise.all(['desktop','src','assets','package.json'].map(name=>fs.cp(path.join(ROOT,name),path.join(appDir,name),{recursive:true})));
  // Node dependencies resolve up to the original project; renderer ESM paths
  // explicitly require these two folders in the copied application.
  await fs.mkdir(path.join(appDir,'node_modules'));
  await Promise.all(['marked','dompurify'].map(name=>fs.cp(path.join(ROOT,'node_modules',name),path.join(appDir,'node_modules',name),{recursive:true})));
  const formalDir=path.join(appDir,'release','FDE Desk-win32-x64'),formalData=path.join(formalDir,'data'),devData=path.join(appDir,'data'),explicitData=path.join(fixture,'显式指定 数据'),home=path.join(fixture,'独立 Codex');
  const sourceDir=path.join(fixture,'测试原始资料'),devDir=path.join(fixture,'测试开发目录');
  await Promise.all([formalDir,home,sourceDir,devDir].map(directory=>fs.mkdir(directory,{recursive:true})));
  await fs.writeFile(path.join(formalDir,'FDE Desk.exe'),'ISOLATED STARTUP PLACEHOLDER - DO NOT EXECUTE');
  await fs.writeFile(path.join(sourceDir,'只读测试说明.md'),'本文件只用于隔离启动验收，不含客户资料。');
  const formalStore=new Store(formalData),formalProject=formalStore.createProject({name:'正式目录中的历史项目',sourceDir,devDir});
  formalStore.upsertRecord(formalProject.id,{date:'2026-10-09',issueKey:'startup-manual',title:'保留人工历史记录',action:'核对已有项目',result:'尚待客户反馈',confirmed:true});
  formalStore.setSettings({activeProjectId:formalProject.id});
  const explicitStore=new Store(explicitData),explicitProject=explicitStore.createProject({name:'显式目录中的独立项目',sourceDir,devDir});
  explicitStore.setSettings({activeProjectId:explicitProject.id});
  const unified=path.join(fixture,'用户数据','FDE Desk','data');
  const env={...process.env,LOCALAPPDATA:path.join(fixture,'用户数据'),FDE_TEST:'1',CODEX_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.FDE_DATA_DIR;
  const checks=[],errors=[],apps=new Set();let secondChild;
  const check=(condition,message)=>{assert.ok(condition,message);checks.push(message);};
  async function eventually(predicate,message,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await pause(60);}throw new Error(message);}
  async function launch(customEnv=env){
    const application=await electron.launch({executablePath:ELECTRON,args:[appDir],env:customEnv,timeout:40000});apps.add(application);
    await application.firstWindow();let page;
    await eventually(async()=>{page=application.windows().find(window=>window.url().endsWith('/index.html'));return!!page;},'隔离源码工作台未载入');
    page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
    await page.waitForFunction(()=>!!window.fde);
    const state=await page.evaluate(()=>window.fde.request('state'));
    return{application,page,state};
  }
  async function close(application){await application.close();apps.delete(application);}
  async function spawnSecond(executable,args,childEnv,message){
    return new Promise((resolve,reject)=>{
      secondChild=spawn(executable,args,{env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
      secondChild.stdout.resume();secondChild.stderr.resume();
      const timer=setTimeout(()=>{secondChild.kill();reject(new Error(message));},10000);
      secondChild.once('error',error=>{clearTimeout(timer);reject(error);});
      secondChild.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
  }
  try{
    const primary=await launch();
    const runtime=await primary.application.evaluate(({app})=>({userData:app.getPath('userData'),appPath:app.getAppPath(),version:app.getVersion()}));
    check(samePath(primary.state.dataDir,unified),'首次启动将旧数据迁入统一用户数据目录');
    check(primary.state.projects.length===1&&primary.state.projects[0].id===formalProject.id&&primary.state.projects[0].records[0].title==='保留人工历史记录','通过实际renderer IPC读取到原正式项目与人工历史记录');
    check(samePath(runtime.userData,path.join(unified,'runtime')),'统一数据目录的 runtime 用于缓存与单实例锁');
    check(samePath(runtime.appPath,appDir),'当前运行的是隔离源码应用，占位正式EXE没有执行');
    await primary.application.evaluate(({app,BrowserWindow})=>{globalThis.__fdeStartupSecondInstances=0;app.on('second-instance',()=>{globalThis.__fdeStartupSecondInstances++;});const main=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().endsWith('/index.html'));main.show();main.focus();});
    const childExit=await spawnSecond(ELECTRON,[appDir],env,'使用相同数据目录的第二实例没有及时退出');
    check(childExit.code===0,'相同数据目录的第二个Electron进程正常退出，防止双实例写入');
    await eventually(async()=>(await primary.application.evaluate(()=>globalThis.__fdeStartupSecondInstances))===1,'主实例未收到第二实例激活事件');
    check((await primary.page.evaluate(()=>window.fde.request('state'))).projects[0].id===formalProject.id,'第二实例激活已有窗口，主实例项目保持不变');
    let expectedSecondInstances=1,crossExecutableLock={tested:false,reason:'未设置FDE_STARTUP_PORTABLE_EXE，仅实测源码Electron单实例锁'};
    if(PORTABLE){
      assert.ok((await fs.stat(PORTABLE)).isFile(),'可选便携EXE必须为实际文件');
      const portableExit=await spawnSecond(PORTABLE,[],{...env,FDE_DATA_DIR:unified},'便携EXE与源码主实例使用同一数据目录时没有及时退出');
      check(portableExit.code===0,'真实便携EXE与源码Electron共用同一DATA时，便携第二实例正常退出');
      expectedSecondInstances++;
      await eventually(async()=>(await primary.application.evaluate(()=>globalThis.__fdeStartupSecondInstances))===expectedSecondInstances,'源码主实例未收到便携EXE的第二实例激活事件');
      check((await primary.page.evaluate(()=>window.fde.request('state'))).projects[0].id===formalProject.id,'真实跨源码与便携EXE激活已有窗口，原项目保持不变');
      crossExecutableLock={tested:true,executable:PORTABLE,exit:portableExit,sharedDataDir:unified};
    }

    const isolated=await launch({...env,FDE_DATA_DIR:explicitData});
    check(samePath(isolated.state.dataDir,explicitData)&&isolated.state.projects.length===1&&isolated.state.projects[0].id===explicitProject.id,'显式FDE_DATA_DIR优先于正式目录兜底');
    check(samePath(await isolated.application.evaluate(({app})=>app.getPath('userData')),path.join(explicitData,'runtime')),'显式隔离目录同时控制userData与锁文件目录');
    check((await primary.application.evaluate(()=>globalThis.__fdeStartupSecondInstances))===expectedSecondInstances&&(await primary.page.evaluate(()=>window.fde.request('state'))).projects[0].id===formalProject.id,'不同显式数据目录可以独立启动，不激活或污染原数据实例');
    await isolated.page.evaluate(({id})=>window.fde.request('record:save',{id,input:{date:'2026-10-09',title:'隔离实例自己的记录',result:'仅写入显式目录',confirmed:true}}),{id:explicitProject.id});
    check((await primary.page.evaluate(()=>window.fde.request('state'))).projects[0].records.length===1,'隔离实例实际写入记录不会跨库写入正式目录');
    await close(isolated.application);
    const screenshot=path.join(out,'20-启动入口历史项目-隔离验收.png');await primary.page.screenshot({path:screenshot});
    await close(primary.application);

    const populatedDev=new Store(devData),devProject=populatedDev.createProject({name:'已有独立开发项目',sourceDir,devDir});populatedDev.setSettings({activeProjectId:devProject.id});
    const development=await launch();
    check(samePath(development.state.dataDir,unified)&&development.state.projects[0].id===formalProject.id,'统一目录存在后，不被后来出现的旧源码数据覆盖');
    const formalAfter=new Store(formalData).getState();
    check(formalAfter.projects.length===1&&formalAfter.projects[0].id===formalProject.id&&formalAfter.projects[0].records[0].title==='保留人工历史记录','源码启动与多实例验证结束后原正式项目和人工记录仍保留');
    check(errors.length===0,'隔离启动与数据切换没有未处理渲染异常');
    await close(development.application);
    const reportPath=path.join(out,'启动路径与单实例验收.json');
    await fs.writeFile(reportPath,JSON.stringify({status:'passed',checks,fixture,appDir,formalData,explicitData,devData,version:runtime.version,secondInstanceExit:childExit,crossExecutableLock,screenshot,boundary:`所有实例都使用隔离Store与Codex目录；伪正式EXE只作目录占位。${PORTABLE?'真实指定便携EXE仅以FDE_DATA_DIR指向隔离formalData运行，验证跨EXE锁。':'未执行实际便携EXE，仅验证源码Electron锁。'}不调用真实模型，不读取或写入真实正式data；未直接执行VBS入口。`},null,2));
    console.log(JSON.stringify({status:'passed',checkCount:checks.length,version:runtime.version,secondInstanceExit:childExit,crossExecutableLock,report:reportPath,screenshot}));
  }finally{
    if(secondChild&&secondChild.exitCode===null)secondChild.kill();
    for(const application of apps){try{await application.close();}catch{}}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
