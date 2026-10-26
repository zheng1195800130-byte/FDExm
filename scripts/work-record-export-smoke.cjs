'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{_electron}=require('playwright'),Zip=require('adm-zip'),{XMLParser}=require('fast-xml-parser');
const {Store}=require('../src/core/store.cjs');
const ROOT=path.resolve(__dirname,'..');
async function run(){
  const root=fs.mkdtempSync(path.join(ROOT,'test-output','record-export-')),data=path.join(root,'data'),sourceDir=path.join(root,'source'),devDir=path.join(root,'dev');fs.mkdirSync(sourceDir);fs.mkdirSync(devDir);
  const store=new Store(data);let p=store.createProject({name:'工作记录导出样例',sourceDir,devDir});
  for(const day of ['21','22','23']){p=store.upsertRecord(p.id,{date:'2026-10-'+day,title:day+' 日记录',cause:'原因 <核对> & 业务事实',action:'处理第一行\n处理第二行',result:'已自测，待客户测试',status:'待验证'});}
  const old=p.dailyHistory['2026-10-21'][0].id,item=p.records.find(r=>r.date==='2026-10-21');p=store.upsertRecord(p.id,{...item,title:'21 日最新记录'});
  const env={...process.env,FDE_TEST:'1',FDE_DATA_DIR:data,CODEX_HOME:path.join(root,'codex')};delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:process.env.FDE_SMOKE_EXECUTABLE||require('electron'),args:process.env.FDE_SMOKE_EXECUTABLE?[]:[process.env.FDE_SMOKE_APP_ROOT||ROOT],env,timeout:40000});const errors=[],checks=[];
  const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
  const until=async(fn,label)=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error(label);};
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(data,'store.json'))).digest('hex');
  try{
    await until(()=>app.windows().some(w=>w.url().endsWith('/index.html')),'工作台未打开');const page=app.windows().find(w=>w.url().endsWith('/index.html'));page.on('pageerror',e=>errors.push(e.message));
    await page.locator('[data-route="records"]').click();await page.waitForSelector('#record-end-date');
    await page.locator('#record-date').fill('2026-10-21');await until(async()=>(await page.locator('.record-card').count())===3,'范围结果未包含三天');check(true,'日期范围包含起止两天');
    const output=path.join(root,'范围工作记录.xlsx');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
    const before=hash();await page.locator('#export-records').click();await until(()=>fs.existsSync(output),'导出文件未生成');
    const zip=new Zip(output),xml=zip.readAsText('xl/worksheets/sheet1.xml'),sheet=new XMLParser({ignoreAttributes:false,parseTagValue:false}).parse(xml).worksheet;
    const cellText=c=>c.is.t['#text']??c.is.t;
    check(xml.includes('21 日最新记录')&&xml.includes('22 日记录')&&xml.includes('23 日记录'),'导出当前范围最新内容');check(JSON.stringify(sheet.sheetData.row[0].c.map(cellText))===JSON.stringify(['工作日期','标题','原因','结果','处理']),'导出列顺序正确');check(JSON.stringify(sheet.sheetData.row.slice(1).map(row=>cellText(row.c[0])))===JSON.stringify(['2026-10-23','2026-10-22','2026-10-21']),'跨日导出每行保留对应工作日期');check(hash()===before,'导出未修改原记录及历史版本');
    await page.locator('#record-history').selectOption('2026-10-21');await until(async()=>await page.locator('.record-card').count()===1,'历史日期未恢复单日');check(await page.locator('#record-end-date').inputValue()==='2026-10-21','历史日期同步起止日期');
    await page.locator('#daily-version').selectOption(old);await until(async()=>(await page.locator('.record-card').innerText()).includes('21 日记录'),'历史版本未切换');
    const historic=path.join(root,'历史工作记录.xlsx');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},historic);await page.locator('#export-records').click();await until(()=>fs.existsSync(historic),'历史版本导出失败');const oldXml=new Zip(historic).readAsText('xl/worksheets/sheet1.xml');check(oldXml.includes('21 日记录')&&!oldXml.includes('21 日最新记录'),'历史版本展示和导出一致');check(await page.locator('[data-action="edit-record"]').isDisabled(),'历史版本仍不可编辑');
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});await page.locator('#export-records').click();await until(async()=>!(await page.locator('#export-records').isDisabled()),'取消后按钮未恢复');check(true,'取消导出可继续操作');
    await page.locator('#record-date').fill('2026-10-24');await page.waitForSelector('#record-range-error');check(await page.locator('#export-records').isDisabled(),'倒置日期范围提示错误并停止导出');
    await page.locator('#record-end-date').fill('2026-10-25');await until(async()=>await page.locator('.record-card').count()===0,'空范围仍显示旧记录');check(await page.locator('#export-records').isDisabled(),'空结果不可导出');
    await page.locator('[data-action="clear-record-date"]').click();await until(async()=>await page.locator('.record-card').count()===3,'全部日期未恢复');check(!(await page.locator('#daily-version').count()),'全部日期不混用单日旧版本');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).showInactive());
    await page.screenshot({path:path.join(root,'records-desktop.png'),fullPage:true});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).setContentSize(760,900));check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'窄窗口无横向溢出');
    check(errors.length===0,'页面无运行错误');
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({checks,errors}));console.log(JSON.stringify({checks:checks.length,errors:errors.length,root,boundary:'独立样例档案、实际桌面页面和导出逻辑；文件选择框由测试控制'}));
  }finally{await app.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
