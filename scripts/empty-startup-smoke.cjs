'use strict';
const { _electron:electron }=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
(async()=>{
 const base=path.join(ROOT,'test-output');await fs.mkdir(base,{recursive:true});
 const fixture=await fs.mkdtemp(path.join(base,'empty-startup-'));
 const executablePath=process.env.FDE_EMPTY_PORTABLE_EXE||require('electron');
 const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:path.join(fixture,'data'),CODEX_HOME:path.join(fixture,'codex')};delete env.ELECTRON_RUN_AS_NODE;
 const errors=[],checks=[];let app;
 try{
  for(let attempt=0;attempt<2;attempt++){
   app=await electron.launch({executablePath,args:process.env.FDE_EMPTY_PORTABLE_EXE?[]:[ROOT],env,timeout:40000});
   await app.firstWindow();
   const deadline=Date.now()+15000;let page;
   while(!page&&Date.now()<deadline){page=app.windows().find(window=>window.url().endsWith('/index.html'));if(!page)await new Promise(resolve=>setTimeout(resolve,50));}
   assert.ok(page,'主工作台应载入');page.on('pageerror',e=>errors.push(e.message));
   await page.getByRole('button',{name:'关联第一个项目',exact:true}).waitFor();
   assert.equal((await page.evaluate(()=>window.fde.request('state'))).projects.length,0);checks.push('空档案启动显示欢迎页');
   await page.getByRole('button',{name:'工作记录',exact:true}).click();
   await page.getByRole('button',{name:'关联第一个项目',exact:true}).waitFor();checks.push('无项目切页正常');
   await page.reload();await page.getByRole('button',{name:'关联第一个项目',exact:true}).waitFor();checks.push('空档案重新加载正常');
   assert.equal(await page.getByText('工作台暂时无法打开',{exact:true}).count(),0);
   await app.close();app=null;
  }
  assert.deepEqual(errors,[]);checks.push('两次退出重开无页面异常');
  console.log(JSON.stringify({passed:true,checks:checks.length,isolatedData:true,mode:process.env.FDE_EMPTY_PORTABLE_EXE?'packaged':'source'}));
 }finally{if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
