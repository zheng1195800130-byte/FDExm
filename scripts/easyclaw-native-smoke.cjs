'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{_electron}=require('playwright');
const {Store}=require('../src/core/store.cjs'),{identityHash}=require('../desktop/easyclaw-access.cjs');
const ROOT=path.resolve(__dirname,'..');
async function run(){
 const root=fs.mkdtempSync(path.join(ROOT,'test-output','easyclaw-native-')),data=path.join(root,'data'),sourceDir=path.join(root,'source'),devDir=path.join(root,'dev');fs.mkdirSync(sourceDir);fs.mkdirSync(devDir);
 const store=new Store(data),project=store.createProject({name:'隔离悬浮验收项目',sourceDir,devDir});store.upsertRecord(project.id,{date:'2026-10-14',title:'PRIVATE_FIXTURE_WORK',confirmed:true});store.saveReport(project.id,'2026-10-14','PRIVATE_FIXTURE_REPORT');
 fs.writeFileSync(path.join(data,'easyclaw-owner.json'),JSON.stringify({version:1,accountHash:identityHash('mock-owner')}));
 const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:data,FDE_EASYCLAW_PORT:'0',CODEX_HOME:path.join(root,'codex')};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({executablePath:process.env.FDE_SMOKE_EXECUTABLE||require('electron'),args:[...(process.env.FDE_SMOKE_EXECUTABLE?[]:[ROOT]),...(process.env.FDE_SMOKE_NO_HOST_FLAG==='1'?[]:['--easyclaw-host'])],env,timeout:40000});let checks=0;
 const check=(ok,label)=>{assert.ok(ok,label);checks++;};
 const until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,70));}throw new Error(label);};
 try{
  await until(()=>app.evaluate(()=>!!globalThis.__fdeEasyClawTest),'桥未启动');
  const port=await app.evaluate(()=>__fdeEasyClawTest.port),url='http://127.0.0.1:'+port+'/api';
  const request=async(action,auth='mock-owner',payload={})=>{const response=await fetch(url,{method:'POST',headers:auth?{Authorization:'Bearer '+auth}:{},body:JSON.stringify({action,payload})});return {status:response.status,value:await response.json()};};
  check((await request('state','')).status===401,'未登录拒绝读取');
  await app.evaluate(()=>{globalThis.fetch=async()=>({ok:true,json:async()=>({uid:'mock-owner'})});});
  let result=await request('state');check(result.status===200&&result.value.value.projects[0].records[0].title==='PRIVATE_FIXTURE_WORK','授权账号读取原档案');
  const pane=app.windows().find(w=>w.url().endsWith('/float.html'));await request('window:compact');
  await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/float.html')).isVisible()),'悬浮框未展开');
  const size=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/float.html')).getContentSize());check(size[0]>=430&&size[1]>=620,'悬浮框窗口尺寸正确');
  await until(async()=>(await pane.locator('body').innerText()).includes('隔离悬浮验收项目'),'悬浮框未加载同一档案');check(true,'悬浮框与工作台共享同一项目');
  await request('memo:save','mock-owner',{id:project.id,text:'PRIVATE_FIXTURE_MEMO'});result=await request('memo:get','mock-owner',{id:project.id});check(result.value.value.text==='PRIVATE_FIXTURE_MEMO','悬浮备忘录保存到独立数据目录');
  await app.evaluate(()=>{globalThis.fetch=async()=>({ok:true,json:async()=>({uid:'mock-other'})});});
  result=await request('state','mock-other',{uid:'mock-owner'});check(result.status===403&&!JSON.stringify(result).includes('PRIVATE_FIXTURE'),'错账号和伪造 uid 无法读取');
  await until(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())),'失效后窗口未隐藏');check(true,'账号变更立即隐藏原生窗口');
  await until(async()=>!(await pane.locator('body').innerText()).includes('PRIVATE_FIXTURE'),'失效后私人内容未清理');check(true,'账号变更清理窗口内旧内容');
  const ipc=await pane.evaluate(()=>window.fde.request('state').then(()=>true,()=>false));check(!ipc,'悬浮框原生 IPC 同样拒绝未授权访问');
  await app.evaluate(()=>{globalThis.fetch=async()=>({ok:true,json:async()=>({uid:'mock-owner'})});});
  result=await request('state','mock-owner-new');check(result.status===200,'授权账号重新验证后恢复');
  console.log(JSON.stringify({checks,boundary:'独立数据、模拟认证服务与账号；未使用真实凭据或客户资料'}));
  fs.writeFileSync(path.join(ROOT,'test-output','easyclaw-native-'+(process.env.FDE_SMOKE_EXECUTABLE?'portable':'source')+'.json'),JSON.stringify({checks,errors:[]}));
 }finally{await app.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1});
