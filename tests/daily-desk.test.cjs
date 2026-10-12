'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/core/store.cjs');
const {DailyDesk,localDate,carryover,validate}=require('../src/core/daily-desk.cjs');
const {conversationText,fileEvidence}=require('../src/core/daily-evidence.cjs');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fde-daily-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(path.join(dir,'data'));const projects=[];
 for(const name of ['甲项目','乙项目']){const sourceDir=path.join(dir,name,'原始'),devDir=path.join(dir,name,'开发');fs.mkdirSync(sourceDir,{recursive:true});fs.mkdirSync(devDir,{recursive:true});projects.push(store.createProject({name,sourceDir,devDir}));store.bindCodexThread(projects.at(-1).id,{threadId:name});}
 let time=new Date('2026-10-10T10:00:00Z'),calls=[],prompts=[],turns=new Map(),fail=false,bad=false;
 const reader={readThread:async ({threadId,date})=>({turns:(turns.get(threadId)||[]).filter(t=>t.date===date)})};
 const service=new DailyDesk({store,reader,now:()=>time,getModel:()=>({config:{enabled:true,provider:'compatible',baseUrl:'http://127.0.0.1:1234/v1',model:'test'},apiKey:'not-real'}),request:async (_c,_k,m)=>{
  const input=JSON.parse(m[1].content);calls.push(input);prompts.push(m[0].content);if(fail)throw new Error('模拟连接失败');
  const sourceIds=[bad?'unknown':input.sources[0].id];
  return {overview:{scene:'按订单配载',requirements:'规则可修改',progress:'完成提单表格导入',nextAction:'确认 ERP 提单来源',blocker:'ERP 字段未确定'},items:[{issueKey:'bill',title:'完善提单导入',cause:'ERP 字段未知',action:'采用表格导入',result:'导入完成，ERP 待补充',status:'进行中',sourceIds}],requirements:[{requirementKey:'bill-import',title:'提单数据导入',description:'保留展示编辑',status:'已明确',sourceIds}],confirmations:[{confirmationKey:'erp-bill',scenario:'ERP 提单字段不全',question:'完整字段从哪里获取？',workaround:'先用表格导入',status:'待确认',resolution:'',sourceIds}],reportIssueKeys:['bill'],reportText:`# ${input.project}\n\n已完成提单表格导入，ERP 数据来源待确认。`};
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

test('手动整理只读取指定当日对话，不补读昨日或无日期历史',async t=>{
 const f=await fixture(t),id=f.projects[0].id,reads=[],read=f.reader.readThread;
 f.reader.readThread=async input=>{reads.push(input);return read(input);};f.add('甲项目','yesterday','2026-10-09');f.add('甲项目','today');
 await f.service.run(id,'2026-10-10');assert.deepEqual(reads.map(input=>input.date),['2026-10-10']);assert.deepEqual(f.calls[0].sources.filter(s=>s.id.startsWith('turn:')).map(s=>s.id),['turn:today']);assert.equal(f.service.raw(id,'2026-10-09').turns.length,0);
 await f.service.run(id,'2026-10-10');assert.equal(f.calls.length,1);assert.deepEqual(reads.map(input=>input.date),['2026-10-10','2026-10-10']);
});

test('点击后先刷新资料再读取对话，连续点击共用一次整理',async t=>{
 const f=await fixture(t),id=f.projects[0].id,events=[];f.add('甲项目','one');let release;
 f.service.prepare=async projectId=>{events.push('prepare:'+projectId);await new Promise(resolve=>release=resolve);};const read=f.reader.readThread;f.reader.readThread=async input=>{events.push('read');return read(input);};
 const first=f.service.run(id,'2026-10-10'),second=f.service.run(id,'2026-10-10');assert.equal(first,second);assert.deepEqual(events,['prepare:'+id]);release();await first;assert.deepEqual(events,['prepare:'+id,'read']);assert.equal(f.calls.length,1);
});

test('跨日归档只使用本地结果，不读取会话、不触发模型',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','one');await f.service.run(id,'2026-10-10');f.reader.readThread=()=>{throw new Error('禁止后台读会话');};f.setTime('2026-10-11T01:00:00Z');f.service.rollover(id,'2026-10-11');
 const p=f.store.getState().projects[0];assert.ok(p.reports.some(r=>r.date==='2026-10-10'));assert.ok(p.dailyDesk.days['2026-10-10'].closedAt);assert.equal(f.calls.length,1);
});

test('归档项目停止本地收录及全部项目整理，恢复后继续收录',async t=>{
 const f=await fixture(t),id=f.projects[0].id;
 f.add('甲项目','a');f.add('乙项目','b');f.store.setProjectArchived(id,true);
 await f.service.allCapture();assert.equal(f.service.raw(id,'2026-10-10').turns.length,0);
 const result=await f.service.runAll('2026-10-10');assert.deepEqual(result.results.map(p=>p.id),[f.projects[1].id]);assert.equal(f.calls.length,1);
 await assert.rejects(f.service.run(id,'2026-10-10'),/归档/);
 f.store.setProjectArchived(id,false);await f.service.capture(id);assert.equal(f.service.raw(id,'2026-10-10').turns.length,1);
});

test('归档后又恢复也不接纳此前尚未返回的收录内容',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','late');
 let release,started;const ready=new Promise(resolve=>started=resolve),reader=f.reader.readThread;
 f.reader.readThread=async input=>{started();await new Promise(resolve=>release=resolve);return reader(input);};
 const pending=f.service.capture(id);await ready;f.store.setProjectArchived(id,true);f.store.setProjectArchived(id,false);release();await pending;
 assert.equal(f.service.raw(id,'2026-10-10').turns.length,0);
 f.reader.readThread=reader;await f.service.capture(id);assert.equal(f.service.raw(id,'2026-10-10').turns.length,1);
});

test('归档与恢复之间在途的模型结果不写入恢复后的项目',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','late-model');
 let release,started;const ready=new Promise(resolve=>started=resolve),request=f.service.request;
 f.service.request=async(...args)=>{started();await new Promise(resolve=>release=resolve);return request(...args);};
 const pending=f.service.run(id,'2026-10-10');await ready;f.store.setProjectArchived(id,true);f.store.setProjectArchived(id,false);release();
 await assert.rejects(pending,/归档状态已改变/);const p=f.store.getState().projects[0];assert.equal(p.records.length,0);assert.equal(p.requirements.length,0);assert.notEqual(p.dailyDesk.days['2026-10-10'].status,'error');
 f.service.request=request;await f.service.run(id,'2026-10-10');assert.equal(f.store.getState().projects[0].records.length,1);
});
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

test('同一需求重复编号、自身关联和重复来源在本地归并，一次请求可完整提交',async t=>{
 const f=await fixture(t),id=f.projects[0].id,request=f.service.request;
 f.service.request=async(...args)=>{const output=await request(...args),first=output.requirements[0];output.requirements=[{...first,relatedRequirementKeys:[first.requirementKey,first.requirementKey]},{...first,description:'补充支持客户模板'}];output.items.push({...output.items[0],relatedIssueKeys:['bill'],action:'补充字段校验'});output.confirmations.push({...output.confirmations[0]});return output;};
 f.add('甲项目','a');await f.service.run(id);const p=f.store.getState().projects[0];assert.equal(p.requirements.length,1);assert.match(p.requirements[0].description,/保留展示编辑；补充支持客户模板/);assert.equal(p.records.length,1);assert.match(p.records[0].action,/补充字段校验/);assert.equal(p.requirementConfirmations.length,1);assert.equal(p.dailyDesk.days['2026-10-10'].status,'ready');assert.equal(f.calls.length,1);assert.equal((await f.service.run(id)).skipped,true);
});
test('明确关联与已有别名按稳定编号归并，保留不同证据和日期',()=>{
 const requirement=(key,source,extra={})=>({requirementKey:key,title:'规则管理',description:key,status:'已明确',sourceIds:[source],...extra});
 const output={...incrementalOutput([]),requirements:[requirement('old-alias','turn:one'),requirement('updated','turn:two',{relatedRequirementKeys:['stable']})]};
 const sources=[{id:'turn:one',timestamp:'2026-10-10T01:00:00Z',sourceRef:'first'},{id:'turn:two',timestamp:'2026-10-10T02:00:00Z',sourceRef:'second'}];
 const result=validate(output,sources,[],{requirements:[{requirementKey:'stable',relatedRequirementKeys:['old-alias']}]});assert.equal(result.requirements.length,1);assert.equal(result.requirements[0].requirementKey,'stable');assert.deepEqual(result.requirements[0].sourceIds,['turn:one','turn:two']);assert.deepEqual(result.requirements[0].relatedRequirementKeys.sort(),['old-alias','updated']);assert.equal(result.requirements[0].sourceFirstAt,sources[0].timestamp);assert.equal(result.requirements[0].sourceLastAt,sources[1].timestamp);
});
test('同标题和同来源不足以归并独立需求，未知来源不能被重复项掩盖',()=>{
 const first={requirementKey:'air',title:'账单导出',description:'空运',sourceIds:['turn:new'],status:'已明确'},second={...first,requirementKey:'sea',description:'海运'};
 const output={...incrementalOutput([]),requirements:[first,second]};assert.equal(validate(output,[newSource]).requirements.length,2);
 output.requirements.push({...first,sourceIds:['invented']});assert.throws(()=>validate(output,[newSource]),/来源无效/);
});
test('重复确认事项无后续证据却有冲突结论时保持待确认',()=>{
 const first={confirmationKey:'bill',scenario:'提单来源',question:'哪里获取',workaround:'表格导入',status:'待确认',sourceIds:['turn:new']};
 const output={...incrementalOutput([]),confirmations:[first,{...first,status:'已解决',resolution:'ERP 获取'}]};const result=validate(output,[newSource]);assert.equal(result.confirmations.length,1);assert.equal(result.confirmations[0].status,'待确认');assert.equal(result.confirmations[0].resolution,'');
});
test('长日只单个有界请求，剩余内容留待下一批，不把历史混入',async t=>{const f=await fixture(t);for(let i=0;i<20;i++)f.add('甲项目',`t${i}`,'2026-10-10','客户需求'.repeat(1000));const result=await f.service.run(f.projects[0].id);assert.equal(f.calls.length,1);assert.ok(result.pending>0);assert.ok(result.partial);assert.ok(f.calls[0].sources.reduce((n,s)=>n+s.text.length,0)<=18000);});
test('来源资料分段完整提交，重复操作不重发',async t=>{const f=await fixture(t),p=f.projects[0];fs.writeFileSync(path.join(p.sourceDir,'要求.md'),'业务要求'.repeat(2000));await f.store.scanProject(p.id);await f.service.run(p.id);assert.ok(f.calls[0].sources[0].text.length<=3600);assert.equal(f.calls[0].sources.map(s=>s.text).join(''),'业务要求'.repeat(2000));assert.ok(!f.calls[0].sources.some(s=>s.sourceRef.startsWith(p.devDir)));await f.service.run(p.id);assert.equal(f.calls.length,1);});

test('超长证据续读尾部，预算不足不提前完成检查点，刷新保留待整理数',async t=>{
 const f=await fixture(t),p=f.projects[0],text='业务要求'.repeat(6000)+'最后问题必须保留';fs.writeFileSync(path.join(p.sourceDir,'长资料.md'),text);await f.store.scanProject(p.id);
 const first=await f.service.run(p.id);assert.ok(first.pending>0);assert.equal(f.calls.length,1);const after=f.store.getState().projects[0];assert.equal(Object.keys(after.dailyDesk.fileCheckpoints).length,0);
 await f.service.capture(p.id);assert.ok(f.store.getState().projects[0].dailyDesk.days['2026-10-10'].unprocessedCount>0);
 await f.service.run(p.id);assert.equal(f.calls.length,2);assert.equal(f.calls.flatMap(call=>call.sources).map(s=>s.text).join(''),text);assert.equal((await f.service.run(p.id)).skipped,true);
});

test('客户确认单按编号保留全部问题，日期只取真实对话引用，漏项拒绝完成',()=>{
 const file={id:'doc',name:'客户确认单.docx',path:'D:/资料/客户确认单.docx',mtime:'2026-10-10',textPreview:'标题\n01  字段来源\n需确认：备注取哪里？\n客户确认：_____\n02  容量口径\n需确认：50还是100？\n客户确认：_____'};
 const sources=fileEvidence(file,[{timestamp:'2026-10-10T08:10:00Z',assistantText:'已输出客户确认单.docx'}]);assert.equal(sources.length,2);assert.equal(sources[0].timestamp,'2026-10-10T08:10:00Z');assert.equal(fileEvidence(file)[0].timestamp,undefined);
 assert.throws(()=>validate(incrementalOutput([]),sources),/未提炼/);
 const output={...incrementalOutput([]),confirmations:sources.map((s,i)=>({confirmationKey:`question-${i}`,scenario:'业务场景',question:s.text,workaround:'暂沿用现行处理',status:'待确认',sourceIds:[s.id]}))};assert.equal(validate(output,sources).confirmations.length,2);
 assert.throws(()=>validate({...output,confirmations:[{...output.confirmations[0],sourceIds:sources.map(s=>s.id)}]},sources),/过度合并/);
});

test('去掉浏览器环境说明，保留其后的真实请求与业务内容',()=>{assert.equal(conversationText('<in-app-browser-context source="ambient-ui-state">说明</in-app-browser-context>\n## My request:\n按模板重排，已完成待测试'),'## My request:\n按模板重排，已完成待测试');});

test('本地核对的日报不伪装成模型新结果，汇总继续使用同一正文',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);const day=f.store.getState().projects[0].dailyDesk.days['2026-10-10'];f.store.saveDailyDesk(id,'2026-10-10',{digest:{...day.digest,method:'local',reportText:'甲项目——按用户提供的日报核对，完成待测试。'}});
 const report=f.store.generateReport(id,'2026-10-10');assert.equal(report.method,'local');assert.ok(f.store.combinedReport('2026-10-10').text.includes(report.text));assert.equal(f.calls.length,1);
});
test('手改工作记录与需求仍受已有保护合并契约保护',async t=>{const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','a');await f.service.run(id);let p=f.store.getState().projects[0];f.store.upsertRecord(id,{...p.records[0],result:'人工改过的结果',confirmed:true});f.add('甲项目','b');await f.service.run(id);p=f.store.getState().projects[0];assert.equal(p.records[0].result,'人工改过的结果');});

test('资料更新只整理需求，不冒充当天工作、不覆盖已完成成果',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','done');await f.service.run(id);const first=f.store.generateReport(id,'2026-10-10').text;
 fs.writeFileSync(path.join(f.projects[0].sourceDir,'历史账单.md'),'2025年各月收费标准');await f.store.scanProject(id);await f.service.run(id);
 const p=f.store.getState().projects[0];assert.ok(f.calls[1].sources.every(s=>s.contextOnly));assert.equal(p.records.length,1);assert.equal(f.store.generateReport(id,'2026-10-10').text,first);assert.equal((await f.service.run(id)).skipped,true);assert.equal(f.calls.length,2);
});
test('文件首次导入可产出需求，但无当日对话不生成工作或日报',async t=>{
 const f=await fixture(t),p=f.projects[0];fs.writeFileSync(path.join(p.sourceDir,'收费标准.md'),'历史空运标准');await f.store.scanProject(p.id);await f.service.run(p.id);
 const next=f.store.getState().projects[0];assert.equal(next.records.length,0);assert.equal(next.requirements.length,1);assert.equal(next.dailyDesk.days['2026-10-10'].digest.reportText,'');assert.ok(!f.store.combinedReport('2026-10-10').text.includes(p.name));
});
test('旧日报按当日工作本地恢复，汇总使用同一正文与手动草稿，跨日不串',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','done');await f.service.run(id);
 const p=f.store.state.projects[0],summary=p.codex.dailySummaries[0];summary.items.push({issueKey:'false-history',title:'历史账单分析',action:'分析去年账单',result:'历史规则',turnIds:[],sourceRef:'D:\\资料\\历史账单.xlsx'});p.records.push({...summary.items.at(-1),id:'false-record',date:'2026-10-10',managedBy:'codex-auto',cycleId:p.activeCycleId,updatedAt:new Date().toISOString()});
 p.dailyDesk.days['2026-10-10'].digest={reportText:'错误的历史账单日报'};
 const text=f.store.generateReport(id,'2026-10-10').text;assert.match(text,/完善提单导入/);assert.doesNotMatch(text,/历史账单|去年/);assert.ok(f.store.combinedReport('2026-10-10').text.includes(text));
 assert.ok(f.store.combinedReport('2026-10-10',[{id,text:'手工草稿：今天已同步交付'}]).text.includes('手工草稿：今天已同步交付'));f.store.saveReport(id,'2026-10-10','正式人工日报');assert.ok(f.store.combinedReport('2026-10-10').text.includes('正式人工日报'));assert.ok(!f.store.combinedReport('2026-10-11').text.includes('甲项目'));assert.throws(()=>f.store.combinedReport('2026-10-10',[{id,text:5}]),/草稿无效/);assert.equal(f.calls.length,1);
});
test('模型日报遗漏当日已有事项时不采用，按工作证据本地补齐，无第二次请求',async t=>{
 const f=await fixture(t),id=f.projects[0].id;f.add('甲项目','done');await f.service.run(id);
 f.service.request=async()=>({overview:{},requirements:[],confirmations:[],items:[{issueKey:'delivery',title:'同步交付',action:'同步到宿主和GitLab',result:'交付完成',sourceIds:['turn:deliver']}],reportIssueKeys:['delivery'],reportText:'只写同步交付，漏掉之前导入'});f.add('甲项目','deliver');await f.service.run(id);
 const text=f.store.generateReport(id,'2026-10-10').text;assert.match(text,/完善提单导入/);assert.match(text,/同步交付/);assert.doesNotMatch(text,/漏掉之前/);
});

test('本地日报补全按关联事项归并，保留人工确认而不附测试次数',()=>{const {workReport}=require('../src/core/daily-report.cjs');const text=workReport('账单',[{title:'转换并同步交付',action:'导入汇总表生成应付流水',result:'40项测试通过，已同步宿主；尚未客户验收',turnIds:['today']},{title:'人工核对资料',action:'核对客户收费口径',confirmed:true,sourceRef:'D:\\资料\\标准.xlsx'}]);assert.match(text,/已同步宿主/);assert.match(text,/尚未客户验收/);assert.match(text,/人工核对资料/);assert.doesNotMatch(text,/40项测试/);});

test('旧文件误记仅从工作展示过滤，原记录不删，人工核对仍可见',()=>{const {workProject}=require('../src/core/daily-report.cjs');const item={issueKey:'file-only',turnIds:[],sourceRef:'D:\\资料\\历史账单.xlsx'},record={...item,date:'2026-10-10',managedBy:'codex-auto'},p={records:[record],codex:{dailySummaries:[{date:'2026-10-10',items:[item]}]}};const view=workProject(p);assert.equal(view.records.length,0);assert.equal(view.codex.dailySummaries[0].items.length,0);assert.equal(p.records.length,1);assert.equal(p.codex.dailySummaries[0].items.length,1);record.confirmed=true;assert.equal(workProject(p).records.length,1);assert.equal(workProject(p).codex.dailySummaries[0].items.length,1);});
