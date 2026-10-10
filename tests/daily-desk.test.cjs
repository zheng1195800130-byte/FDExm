'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/core/store.cjs');
const {DailyDesk,localDate,carryover,validate}=require('../src/core/daily-desk.cjs');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fde-daily-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(path.join(dir,'data'));const projects=[];
 for(const name of ['甲项目','乙项目']){const sourceDir=path.join(dir,name,'原始'),devDir=path.join(dir,name,'开发');fs.mkdirSync(sourceDir,{recursive:true});fs.mkdirSync(devDir,{recursive:true});projects.push(store.createProject({name,sourceDir,devDir}));store.bindCodexThread(projects.at(-1).id,{threadId:name});}
 let time=new Date('2026-10-10T10:00:00Z'),calls=[],prompts=[],turns=new Map(),fail=false,bad=false;
 const reader={readThread:async ({threadId,date})=>({turns:(turns.get(threadId)||[]).filter(t=>t.date===date)})};
 const service=new DailyDesk({store,reader,now:()=>time,getModel:()=>({config:{enabled:true,provider:'compatible',baseUrl:'http://127.0.0.1:1234/v1',model:'test'},apiKey:'not-real'}),request:async (_c,_k,m)=>{
  const input=JSON.parse(m[1].content);calls.push(input);prompts.push(m[0].content);if(fail)throw new Error('模拟连接失败');
  const sourceIds=[bad?'unknown':input.sources[0].id];
  return {overview:{scene:'按订单配载',requirements:'规则可修改',progress:'完成提单表格导入',nextAction:'确认 ERP 提单来源',blocker:'ERP 字段未确定'},items:[{issueKey:'bill',title:'完善提单导入',cause:'ERP 字段未知',action:'采用表格导入',result:'导入完成，ERP 待补充',status:'进行中',sourceIds}],requirements:[{requirementKey:'bill-import',title:'提单数据导入',description:'保留展示编辑',status:'已明确',sourceIds}],confirmations:[{confirmationKey:'erp-bill',scenario:'ERP 提单字段不全',question:'完整字段从哪里获取？',workaround:'先用表格导入',status:'待确认',resolution:'',sourceIds}],reportText:`# ${input.project}\n\n已完成提单表格导入，ERP 数据来源待确认。`};
 }});
 const add=(name,id,date='2026-10-10',text='ERP 提单字段不全，先表格导入')=>{const array=turns.get(name)||[];array.push({id,date,timestamp:`${date}T03:12:00Z`,completed:true,userText:text,assistantText:'已完成表格导入，ERP 提单来源后续确认',sourceRef:`codex:${name}#turn=${id}`,attachments:[]});turns.set(name,array);};
 return {store,service,projects,calls,prompts,add,setTime:value=>time=new Date(value),setFail:value=>fail=value,setBad:value=>bad=value,reader,dir};
}
test('整理预设仅在人工整理的增量请求使用，保存或改风格不重算历史',async t=>{
 const f=await fixture(t),id=f.projects[0].id;
 f.store.setSettings({summaryPreset:{instructions:'简短自然语言，合并相关修改',reportExample:'风格示例项目：完成海运交付。'}});
 f.add('甲项目','one');await f.service.allCapture();assert.equal(f.calls.length,0);
 await f.service.run(id);assert.equal(f.calls.length,1);assert.match(f.prompts[0],/简短自然语言/);assert.match(f.prompts[0],/风格示例项目/);
 assert.ok(!JSON.stringify(f.calls[0]).includes('风格示例项目'),'日报样例不混入项目资料与来源');
 f.store.setSettings({summaryPreset:{instructions:'只写业务结果',reportExample:''}});
 assert.equal((await f.service.run(id)).skipped,true);assert.equal(f.calls.length,1);
 f.add('甲项目','two');await f.service.run(id);assert.equal(f.calls.length,2);assert.match(f.prompts[1],/只写业务结果/);assert.ok(!f.prompts[1].includes('风格示例项目'));
 assert.deepEqual(f.calls[1].sources.map(s=>s.id),['turn:two']);
});
test('上海日期按零点切换',()=>{assert.equal(localDate('2026-10-10T15:59:59Z'),'2026-10-10');assert.equal(localDate('2026-10-10T16:00:00Z'),'2026-10-11');});
test('后台仅今日昨日收录，无 AI；完整原文与图片路径留本地',async t=>{const f=await fixture(t);f.add('甲项目','old','2026-10-08');f.add('甲项目','y','2026-10-09');f.add('甲项目','t');await f.service.allCapture();assert.equal(f.calls.length,0);assert.deepEqual(f.service.raw(f.projects[0].id,'2026-10-10').turns.map(t=>t.id),['t']);assert.equal(f.service.raw(f.projects[0].id,'2026-10-08').turns.length,0);assert.equal(f.store.getState().projects[0].dailyDesk.days['2026-10-09'].count,1);});
test('单击一次四类产出，重复整理零请求，后续只发送增量',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','one');await f.service.run(id);assert.equal(f.calls.length,1);const p=f.store.getState().projects[0];assert.equal(p.records.length,1);assert.equal(p.requirements.length,1);assert.equal(p.requirementConfirmations.length,1);assert.match(f.store.generateReport(id,'2026-10-10').text,/已完成提单/);assert.equal((await f.service.run(id)).skipped,true);assert.equal(f.calls.length,1);f.add('甲项目','two');await f.service.run(id);assert.deepEqual(f.calls[1].sources.map(s=>s.id),['turn:two']);assert.equal(f.store.getState().projects[0].records.length,1);});
test('全部项目一次操作独立整理，无变化项目不发请求',async t=>{const f=await fixture(t);f.add('甲项目','a');f.add('乙项目','b');const result=await f.service.runAll();assert.equal(result.results.length,2);assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(i=>i.project),['甲项目','乙项目']);await f.service.runAll();assert.equal(f.calls.length,2);});
test('并发重复整理共享单个请求',async t=>{const f=await fixture(t);f.add('甲项目','a');await Promise.all([f.service.run(f.projects[0].id),f.service.run(f.projects[0].id)]);assert.equal(f.calls.length,1);});
test('零点本地归档昨日，不调用模型，不覆盖手写日报，新日空白',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);f.store.saveReport(id,'2026-10-10','# 我手写的日报');f.setTime('2026-10-10T16:00:01Z');await f.service.allCapture();assert.equal(f.calls.length,1);const p=f.store.getState().projects[0];assert.match(p.reports.find(r=>r.date==='2026-10-10').text,/我手写/);assert.ok(p.dailyDesk.days['2026-10-10'].closedAt);assert.equal(p.dailyDesk.days['2026-10-11'].count,0);assert.ok(fs.existsSync(path.join(f.store.projectFolder(id),'每日归档','2026-10-10.json')));assert.ok(carryover(p,'2026-10-11').some(i=>i.type==='昨日工作'));});
test('关机跨日启动补归档，昨日正文保留并可单独整理',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','y','2026-10-09');await f.service.capture(id);assert.equal(f.calls.length,0);await f.service.run(id,'2026-10-09');assert.equal(f.calls[0].date,'2026-10-09');assert.equal(f.store.getState().projects[0].records[0].date,'2026-10-09');});
test('失败不消耗检查点、无自动重试，手动可恢复',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');f.setFail(true);await assert.rejects(f.service.run(id),/连接失败/);await f.service.capture(id);assert.equal(f.calls.length,1);assert.equal(f.store.getState().projects[0].dailyDesk.days['2026-10-10'].processed,undefined);f.setFail(false);await f.service.run(id);assert.equal(f.calls.length,2);});
test('无效来源整批拒绝，旧工作需求和日报均保留',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);const before=f.store.getState().projects[0];f.add('甲项目','b');f.setBad(true);await assert.rejects(f.service.run(id),/来源无效/);const after=f.store.getState().projects[0];for(const key of ['records','requirements','requirementConfirmations','reports'])assert.deepEqual(after[key],before[key]);});

test('增量协议只输出变化，未涉及旧工作在本地保留且不多发请求',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);const before=f.store.getState().projects[0].records[0];
 f.service.request=async(_c,_k,m)=>{const input=JSON.parse(m[1].content);f.calls.push(input);assert.deepEqual(input.sources.map(s=>s.id),['turn:b']);assert.deepEqual(input.previousItems[0].sourceIds,['turn:a']);assert.match(m[0].content,/未涉及的旧事项由程序原样保留/);return {overview:input.previousOverview,items:[],requirements:[],confirmations:[],reportText:'已完成提单表格导入，ERP 来源待确认。'};};
 f.add('甲项目','b');await f.service.run(id);const after=f.store.getState().projects[0].records[0];assert.equal(after.result,before.result);assert.deepEqual(after.turnIds,before.turnIds);assert.equal(f.calls.length,2);assert.equal((await f.service.run(id)).skipped,true);
});

test('模型原样返回精简旧摘要时保留完整旧记录，不要求伪造新来源',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);const original=f.store.getState().projects[0].codex.dailySummaries[0].items[0];
 f.service.request=async(_c,_k,m)=>{const input=JSON.parse(m[1].content);f.calls.push(input);return {overview:input.previousOverview,items:input.previousItems,requirements:[],confirmations:[],reportText:'提单表格导入完成，ERP 待补充。'};};
 f.add('甲项目','b');await f.service.run(id);assert.deepEqual(f.store.getState().projects[0].codex.dailySummaries[0].items, [original]);assert.equal(f.calls.length,2);
});

const incrementalOutput=items=>({overview:{},items,requirements:[],confirmations:[],reportText:'当天工作'});
const oldWork={issueKey:'bill',title:'提单导入',cause:'字段不全',action:'表格导入',result:'等待 ERP',status:'进行中',turnIds:['old'],sourceRef:'codex:project#turn=old',attachments:[{path:'D:\\资料\\旧图.png'}]};
const newSource={id:'turn:new',timestamp:'2026-10-10T06:00:00Z',sourceRef:'codex:project#turn=new',attachments:[{path:'D:\\资料\\新图.png'}]};
test('同项更新可合并本次和已核实旧来源，旧附件不丢失',()=>{
 const result=validate(incrementalOutput([{...oldWork,result:'ERP 已接通',status:'已完成',sourceIds:['turn:old','turn:new']}]),[newSource],[oldWork]);
 assert.equal(result.items.length,1);assert.deepEqual(result.items[0].turnIds,['old','new']);assert.deepEqual(result.items[0].attachments,[...oldWork.attachments,...newSource.attachments]);assert.match(result.items[0].sourceRef,/#turn=old\ncodex:project#turn=new/);
});
test('只有旧证据的修改、挪用其他事项证据或虚构来源仍拒绝',()=>{
 for(const [issueKey,sourceIds]of [['bill',['turn:old']],['unrelated',['turn:old','turn:new']],['bill',['turn:new','invented']]])assert.throws(()=>validate(incrementalOutput([{...oldWork,issueKey,result:'未经证实的新结论',sourceIds}]),[newSource],[oldWork]),/来源无效/);
});
test('相关新工作仅引用本次证据也自动保留已关联旧来源',()=>{
 const result=validate(incrementalOutput([{...oldWork,issueKey:'bill-complete',relatedIssueKeys:['bill'],result:'接通 ERP',sourceIds:['turn:new']}]),[newSource],[oldWork]);assert.equal(result.items.length,1);assert.deepEqual(result.items[0].turnIds,['new','old']);assert.deepEqual(result.items[0].attachments,[...oldWork.attachments,...newSource.attachments]);
});
test('长日只单个有界请求，剩余内容留待下一批，不把历史混入',async t=>{const f=await fixture(t);for(let i=0;i<20;i++)f.add('甲项目',`t${i}`,'2026-10-10','客户需求'.repeat(1000));const result=await f.service.run(f.projects[0].id);assert.equal(f.calls.length,1);assert.ok(result.pending>0);assert.ok(result.partial);assert.ok(f.calls[0].sources.reduce((n,s)=>n+s.text.length,0)<=18000);});
test('来源资料仅提交新增简短摘录，重复操作不重发',async t=>{const f=await fixture(t),p=f.projects[0];fs.writeFileSync(path.join(p.sourceDir,'要求.md'),'业务要求'.repeat(2000));await f.store.scanProject(p.id);await f.service.run(p.id);assert.ok(f.calls[0].sources[0].text.length<=1800);assert.ok(!f.calls[0].sources.some(s=>s.sourceRef.startsWith(p.devDir)));await f.service.run(p.id);assert.equal(f.calls.length,1);});
test('手改工作记录与需求仍受已有保护合并契约保护',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);let p=f.store.getState().projects[0];f.store.upsertRecord(id,{...p.records[0],result:'人工改过的结果',confirmed:true});f.add('甲项目','b');await f.service.run(id);p=f.store.getState().projects[0];assert.equal(p.records[0].result,'人工改过的结果');});
