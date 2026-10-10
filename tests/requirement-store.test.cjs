'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store.cjs');
function fixture(t) {
  const base = path.resolve(__dirname,'../.test-tmp'); fs.mkdirSync(base,{recursive:true});
  const root = fs.mkdtempSync(path.join(base,'requirements-store-'));
  const sourceDir=path.join(root,'source'),devDir=path.join(root,'app');
  fs.mkdirSync(sourceDir);fs.mkdirSync(devDir);
  const store=new Store(path.join(root,'data')),p=store.createProject({name:'自动业务需求',sourceDir,devDir});
  t.after(()=>{assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  return {store,p,root,current:()=>store.getState().projects.find(item=>item.id===p.id)};
}
const item=(key,extra={})=>({requirementKey:key,title:`业务 ${key}`,description:'按业务规则核对并导出结果。',questions:[],status:'已明确',sourceIds:['file:one'],sourceRef:'原始需求.md',attachments:[],...extra});
function apply(f,items,extra={}){return f.store.applyRequirementSummary(f.p.id,{items,threadId:'',fingerprint:'content-hash',contextKey:'scope',method:'model',processedSources:{'file:one':'hash'},processedTurns:{},initialTurnIds:[],warnings:[],sourceCount:1,...extra});}
test('自动需求落地且同业务增量保留身份与来源，未涉及的旧需求仍保留',t=>{
  const f=fixture(t);apply(f,[item('import'),item('export')]);
  const first=f.current().requirements.find(i=>i.requirementKey==='import');
  apply(f,[item('import',{description:'补充按客户模板导入。',sourceIds:['turn:two'],sourceRef:'首次业务对话'})]);
  const result=f.current(),updated=result.requirements.find(i=>i.requirementKey==='import');
  assert.equal(updated.id,first.id);assert.equal(result.requirements.length,2);
  assert.deepEqual(updated.sourceIds,['file:one','turn:two']);assert.match(updated.sourceRef,/原始需求.md/);assert.match(updated.sourceRef,/首次业务对话/);
  const reloaded=new Store(f.store.dataDir).getState().projects[0];
  assert.deepEqual(reloaded.requirements,result.requirements);assert.equal(reloaded.requirementAnalysis.fingerprint,'content-hash');
});
test('同一功能以显式关联合并，重复编号或无效条目整体拒绝且不丢旧清单',t=>{
  const f=fixture(t);apply(f,[item('model'),item('picker')]);
  const original=f.current().requirements[0];
  apply(f,[item('model',{title:'模型接入与选择',relatedRequirementKeys:['picker']})]);
  assert.equal(f.current().requirements.length,1);assert.equal(f.current().requirements[0].id,original.id);
  const before=fs.readFileSync(f.store.statePath,'utf8');
  assert.throws(()=>apply(f,[item('model'),item('other',{relatedRequirementKeys:['model']})]),/重复/);
  assert.throws(()=>apply(f,[item('valid'),item('bad',{status:'已完成'})]),/状态/);
  assert.equal(fs.readFileSync(f.store.statePath,'utf8'),before);
});
test('标题相同但无明确关联的自动需求保持独立，部分读取有明确状态',t=>{
  const f=fixture(t);apply(f,[item('air',{title:'费用核对'}),item('sea',{title:'费用核对'})],{warnings:['部分材料未读取']});
  assert.equal(f.current().requirements.length,2);
  assert.match(f.current().requirementAnalysis.status.message,/部分资料尚未读取/);
});
test('人工接管和人工同名需求不被自动覆盖，删除的自动需求及合并别名不复活',t=>{
  const f=fixture(t);apply(f,[item('billing')]);
  const auto=f.current().requirements[0];
  f.store.upsertRequirement(f.p.id,{id:auto.id,description:'人工确认的需求范围',questions:['客户确认哪个模板？']});
  apply(f,[item('billing',{description:'模型另一个解释'})]);
  assert.equal(f.current().requirements[0].description,'人工确认的需求范围');assert.equal(f.current().requirements[0].manual,true);
  assert.deepEqual(f.current().requirements[0].questions,['客户确认哪个模板？']);
  f.store.removeRequirement(f.p.id,auto.id);apply(f,[item('billing')]);assert.equal(f.current().requirements.length,0);
  f.store.upsertRequirement(f.p.id,{title:'人工需求',description:'客户明确要求'});
  apply(f,[item('new-key',{title:'人工需求',description:'模型重复收录'})]);
  assert.equal(f.current().requirements.length,1);assert.equal(f.current().requirements[0].description,'客户明确要求');
});
test('确认问题不会冒充已明确需求，失败仅写状态并保留清单和检查点',t=>{
  const f=fixture(t);apply(f,[item('rules',{questions:['计费口径是否按票？']})]);
  const before=f.current().requirements;
  assert.equal(before[0].status,'待确认');
  f.store.setRequirementAnalysis(f.p.id,{status:{state:'error',message:'连接暂时失败'},blockedFingerprint:'failed-content'});
  assert.deepEqual(f.current().requirements,before);assert.equal(f.current().requirementAnalysis.fingerprint,'content-hash');
  assert.equal(f.current().requirementAnalysis.blockedFingerprint,'failed-content');
  assert.throws(()=>f.store.setRequirementAnalysis(f.p.id,{status:{state:'anything'}}),/状态/);
  assert.deepEqual(f.current().requirements,before);
});
test('目录与会话变化只清理分析检查点，保留业务需求和人工删除标记',t=>{
  const f=fixture(t);apply(f,[item('keep'),item('removed')]);
  f.store.removeRequirement(f.p.id,f.current().requirements.find(i=>i.requirementKey==='removed').id);
  f.store.bindCodexThread(f.p.id,{threadId:'new-conversation'});
  const result=f.current();assert.equal(result.requirements.length,1);assert.equal(result.requirements[0].requirementKey,'keep');
  assert.deepEqual(result.requirementAnalysis.dismissedKeys,['removed']);assert.equal(result.requirementAnalysis.fingerprint,undefined);
  assert.throws(()=>apply(f,[item('wrong')]),/会话已变化/);
  assert.equal(f.current().requirements.length,1);
});
test('删除后更换编号和标题标点不能从同一文件复活，正文改变或分段改变仍受保护并持久化',t=>{
  const f=fixture(t);apply(f,[item('old',{title:'订单统计',sourceIds:['file:document:1'],sourceRef:''})]);
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  assert.equal(f.current().requirementAnalysis.dismissedRequirements.length,1);
  apply(f,[item('new',{title:'订单 统计。',description:'同文件已改写的业务内容',sourceIds:['file:document:3'],sourceRef:''})]);
  assert.equal(f.current().requirements.length,0);
  const store=new Store(f.store.dataDir),reloaded={...f,store};
  apply(reloaded,[item('after_restart',{title:'订单统计',sourceIds:['file:document:2'],sourceRef:''})]);
  assert.equal(store.getState().projects[0].requirements.length,0);
});
test('同名不同来源的独立需求保留，空引用或同一非唯一来源标签不会误杀',t=>{
  const f=fixture(t);apply(f,[item('old',{title:'费用核对',sourceIds:['file:air:1'],sourceRef:''})]);
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  apply(f,[item('sea',{title:'费用核对',sourceIds:['file:sea:1'],sourceRef:''})]);
  assert.equal(f.current().requirements.length,1);assert.equal(f.current().requirements[0].requirementKey,'sea');
  apply(f,[item('tagged',{title:'按月核对',sourceIds:['file:first:1'],sourceRef:'原始需求.md'})]);
  f.store.removeRequirement(f.p.id,f.current().requirements.find(value=>value.requirementKey==='tagged').id);
  apply(f,[item('different_source',{title:'按月核对',sourceIds:['file:second:1'],sourceRef:'原始需求.md'})]);
  assert.equal(f.current().requirements.length,2);
});
test('没有来源编号的人工删除按非空明确引用保护，双空来源不当作相同来源',t=>{
  const f=fixture(t);
  f.store.upsertRequirement(f.p.id,{title:'人工业务范围',description:'只需订单导出',sourceRef:'D:\\业务\\需求.md'});
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  apply(f,[item('auto',{title:'人工业务范围',sourceIds:['file:referenced:1'],sourceRef:'d:/业务/需求.md'})]);
  assert.equal(f.current().requirements.length,0);
  f.store.upsertRequirement(f.p.id,{title:'无来源人工需求',description:'尚未登记来源',sourceRef:''});
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  apply(f,[item('new_valid_source',{title:'无来源人工需求',sourceIds:['file:real:1'],sourceRef:''})]);
  assert.equal(f.current().requirements.length,1);
});
test('结构删除标记仅限原目录和会话上下文，切换后可独立收录，切回仍保护原删除',t=>{
  const f=fixture(t);apply(f,[item('scoped',{title:'合同导出',sourceIds:['file:document:1'],sourceRef:''})]);
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  const originalScope=f.current().requirementAnalysis.dismissedRequirements[0].scope;
  f.store.bindCodexThread(f.p.id,{threadId:'new-thread'});
  apply(f,[item('scoped',{title:'合同导出',sourceIds:['file:document:1'],sourceRef:''})],{threadId:'new-thread'});
  assert.equal(f.current().requirements.length,1,'原scope删除不影响新会话范围');
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  f.store.bindCodexThread(f.p.id,{threadId:''});
  apply(f,[item('renamed',{title:'合同导出',sourceIds:['file:document:2'],sourceRef:''})]);
  assert.equal(f.current().requirements.length,0);
  assert.ok(f.current().requirementAnalysis.dismissedRequirements.some(entry=>entry.scope===originalScope));
  const replacement=path.join(f.root,'new-source');fs.mkdirSync(replacement);
  f.store.updateProject(f.p.id,{sourceDir:replacement});
  apply(f,[item('scoped',{title:'合同导出',sourceIds:['file:document:1'],sourceRef:''})]);
  assert.equal(f.current().requirements.length,1,'原scope删除不影响新资料目录');
});
test('旧档案只有dismissedKeys仍按原逻辑保护，新结构标记不破坏旧版本兼容',t=>{
  const f=fixture(t),state=f.store.getState();
  state.projects[0].requirementAnalysis={dismissedKeys:['legacy']};
  fs.writeFileSync(f.store.statePath,JSON.stringify(state));
  const store=new Store(f.store.dataDir),legacy={...f,store};
  apply(legacy,[item('legacy'),item('allowed')]);
  const project=store.getState().projects[0];
  assert.equal(project.requirements.length,1);assert.equal(project.requirements[0].requirementKey,'allowed');
  assert.deepEqual(project.requirementAnalysis.dismissedKeys,['legacy']);
});
test('同目录同会话的另一个项目不受本项目删除墓碑影响',t=>{
  const f=fixture(t),second=f.store.createProject({name:'独立管理项目',sourceDir:f.p.sourceDir,devDir:f.p.devDir});
  apply(f,[item('shared',{title:'导出业务',sourceIds:['file:same:1'],sourceRef:''})]);
  f.store.removeRequirement(f.p.id,f.current().requirements[0].id);
  f.store.applyRequirementSummary(second.id,{threadId:'',items:[item('shared',{title:'导出业务',sourceIds:['file:same:1'],sourceRef:''})]});
  assert.equal(f.current().requirements.length,0);
  assert.equal(f.store.getState().projects.find(project=>project.id===second.id).requirements.length,1);
});

const confirmation = (key, extra = {}) => ({ confirmationKey: key, scenario: '提单信息暂时无法从 ERP 获取', question: '提单信息最终由哪个渠道提供？', workaround: '当前先用 Excel 表格导入', status: '待确认', resolution: '', sourceIds: ['turn:ten'], sourceRef: 'codex:thread#turn=10', attachments: [], relatedConfirmationKeys: [], requirementKeys: [], sourceFirstAt: '2026-10-09T02:15:00Z', sourceLastAt: '2026-10-09T02:15:00Z', ...extra });

test('确认事项按显式身份归并并保留稳定ID和真实时间，未涉及项和解决历史不删除',t=>{
  const f=fixture(t);apply(f,[],{confirmations:[confirmation('bill_source'),confirmation('field_scope',{scenario:'重量口径待确认',question:'按毛重还是计费重？'})]});
  const first=f.current().requirementConfirmations[0];
  apply(f,[],{confirmations:[confirmation('bill_source_new',{relatedConfirmationKeys:['bill_source'],status:'已解决',resolution:'客户确认 ERP 运输单主表提供提单号。',sourceIds:['turn:later'],sourceFirstAt:'2026-10-09T04:35:00Z',sourceLastAt:'2026-10-09T04:35:00Z'})]});
  const result=f.current(),updated=result.requirementConfirmations.find(i=>i.confirmationKey==='bill_source');
  assert.equal(updated.id,first.id);assert.equal(updated.status,'已解决');assert.equal(result.requirementConfirmations.length,2);
  assert.equal(updated.sourceFirstAt,'2026-10-09T02:15:00.000Z');assert.equal(updated.sourceLastAt,'2026-10-09T04:35:00.000Z');
  assert.deepEqual(updated.sourceIds,['turn:ten','turn:later']);assert.ok(updated.relatedConfirmationKeys.includes('bill_source_new'));
  apply(f,[],{confirmations:[]});assert.deepEqual(f.current().requirementConfirmations,result.requirementConfirmations);
  assert.deepEqual(new Store(f.store.dataDir).getState().projects[0].requirementConfirmations,result.requirementConfirmations);
});

test('确认事项人工接管/删除保护、独立同标题及跨项目隔离',t=>{
  const f=fixture(t);apply(f,[],{confirmations:[confirmation('bill_source'),confirmation('independent',{sourceIds:['file:other:1']})]});
  const auto=f.current().requirementConfirmations[0];
  f.store.upsertRequirementConfirmation(f.p.id,{id:auto.id,workaround:'人工保留的处理方式'});
  apply(f,[],{confirmations:[confirmation('bill_source',{status:'已解决',resolution:'模型猜测的答案'})]});
  assert.equal(f.current().requirementConfirmations.find(i=>i.id===auto.id).workaround,'人工保留的处理方式');
  assert.equal(f.current().requirementConfirmations.find(i=>i.id===auto.id).status,'待确认');
  f.store.removeRequirementConfirmation(f.p.id,auto.id);apply(f,[],{confirmations:[confirmation('bill_source_renamed')]});
  assert.equal(f.current().requirementConfirmations.length,1,'同场景同源换编号不能复活');
  const second=f.store.createProject({name:'另一项目',sourceDir:f.p.sourceDir,devDir:f.p.devDir});
  f.store.applyRequirementSummary(second.id,{items:[],threadId:'',confirmations:[confirmation('bill_source_renamed')]});
  assert.equal(f.store.getState().projects.find(p=>p.id===second.id).requirementConfirmations.length,1);
});

test('确认事项无效响应整体拒绝、未知时间留空且不会用整理时间伪造',t=>{
  const f=fixture(t);apply(f,[item('unknown')],{confirmations:[confirmation('unknown',{sourceFirstAt:'',sourceLastAt:''})]});
  const initial=f.current();assert.equal(initial.requirements[0].sourceFirstAt,'');assert.equal(initial.requirementConfirmations[0].sourceLastAt,'');
  const before=fs.readFileSync(f.store.statePath,'utf8');
  assert.throws(()=>apply(f,[item('new')],{confirmations:[confirmation('bad',{status:'已解决',resolution:''})]}),/结论/);
  assert.throws(()=>apply(f,[],{confirmations:[confirmation('bad',{sourceFirstAt:'2026-10-09'})]}),/ISO/);
  assert.throws(()=>apply(f,[],{confirmations:[confirmation('bad',{sourceFirstAt:'2026-10-10T02:15:00Z'})]}),/起止/);
  assert.throws(()=>apply(f,[],{confirmations:[confirmation('same'),confirmation('same')]}),/重复/);
  assert.equal(fs.readFileSync(f.store.statePath,'utf8'),before);
});

test('需求及确认来源时间累积，Markdown上海日期时分且视图截止筛选不删档案',t=>{
  const f=fixture(t);apply(f,[item('dates',{sourceFirstAt:'2026-10-08T16:25:12Z',sourceLastAt:'2026-10-09T01:45:59Z'})],{confirmations:[confirmation('bill_source')]});
  const base=f.store.projectFolder(f.p.id),before=f.current();
  f.store.setRequirementFilter(f.p.id,'2026-10-09T05:00:00+08:00');
  assert.equal(f.current().requirementsAfter,'2026-10-08T21:00:00.000Z');
  assert.deepEqual(f.current().requirements,before.requirements);assert.deepEqual(f.current().requirementConfirmations,before.requirementConfirmations);
  const markdown=fs.readFileSync(path.join(base,'需求清单.md'),'utf8');
  assert.match(markdown,/2026-10-09 00:25/);assert.match(markdown,/2026-10-09 09:45/);assert.match(markdown,/2026-10-09 10:15/);
  assert.doesNotMatch(markdown,/T02:15:00/);assert.match(markdown,/需求确认（含已解决历史）/);assert.match(markdown,/当前先用 Excel/);
  const standalone=fs.readFileSync(path.join(base,'需求确认.md'),'utf8');assert.match(standalone,/2026-10-09 10:15/);
  assert.throws(()=>f.store.setRequirementFilter(f.p.id,'2026-10-09'),/ISO/);f.store.setRequirementFilter(f.p.id,'');assert.equal(f.current().requirementsAfter,'');
});

test('旧档案缺少确认清单与日期仍可加载，不制造历史时间',t=>{
  const f=fixture(t),state=f.store.getState();delete state.projects[0].requirementConfirmations;delete state.projects[0].requirementsAfter;
  fs.writeFileSync(f.store.statePath,JSON.stringify(state));const reloaded=new Store(f.store.dataDir).getState().projects[0];
  assert.deepEqual(reloaded.requirementConfirmations,[]);assert.equal(reloaded.requirementsAfter,'');
});
