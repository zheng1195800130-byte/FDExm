'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/core/store.cjs');
const history=require('../src/core/daily-history.cjs');
function fixture(t){const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'daily-history-'));t.after(()=>{if(!root.startsWith(base+path.sep))throw Error('Unexpected test path');fs.rmSync(root,{recursive:true,force:true});});for(const d of ['source','dev'])fs.mkdirSync(path.join(root,d));const store=new Store(path.join(root,'data')),p=store.createProject({name:'每日版本验收',sourceDir:path.join(root,'source'),devDir:path.join(root,'dev')});store.bindCodexThread(p.id,{threadId:'thread-test'});return {root,store,id:p.id};}
function save(f,date,label,mode='append'){
 return f.store.applyDailyDesk(f.id,{date,mode,threadId:'thread-test',items:[{issueKey:'work',title:label,action:label,result:label,turnIds:['turn-'+label]}],requirements:[{requirementKey:'need',title:label,status:'已明确',sourceIds:['source-'+label]}],confirmations:[{confirmationKey:'confirm',scenario:label,question:'是否按新规则处理？',status:'待确认',sourceIds:['source-'+label]}],digest:{overview:{progress:label},reportText:label+'日报',workEvidenceVersion:2},processed:{},fileCheckpoints:{},sourceCheckpoints:{},fingerprint:label,pending:0});
}
test('同日追加和覆盖保存三类完整版本，次日更新不改变昨日需求或正文，退出重开仍可读取',t=>{
 const f=fixture(t);save(f,'2026-10-14','首版');save(f,'2026-10-14','追加版');save(f,'2026-10-14','覆盖版','replace');
 const p=f.store._project(f.id),versions=p.dailyHistory['2026-10-14'];assert.equal(versions.length,3);assert.equal(versions[0].records[0].title,'首版');assert.equal(versions[0].report.text,'首版日报');assert.equal(versions[0].requirements[0].title,'首版');assert.equal(versions[0].confirmations[0].scenario,'首版');
 assert.equal(versions.at(-1).records[0].title,'覆盖版');const before=JSON.stringify(versions);save(f,'2026-10-15','次日');
 const reopened=new Store(f.store.dataDir)._project(f.id);assert.equal(JSON.stringify(reopened.dailyHistory['2026-10-14']),before);assert.equal(reopened.dailyHistory['2026-10-15'][0].requirements[0].title,'次日');assert.equal(reopened.records.filter(r=>r.date==='2026-10-14').length,1);assert.equal(f.store.verifyDailySaved(f.id,'2026-10-15').savedVerified,true);
});
test('已保存历史版本先于主档案完成时，主档案意外回退后可恢复，旧需求和手工内容不丢',t=>{
 const f=fixture(t),old=fs.readFileSync(f.store.statePath);save(f,'2026-10-14','已保存');fs.writeFileSync(f.store.statePath,old);
 const reopened=new Store(f.store.dataDir),p=reopened._project(f.id);assert.equal(p.records[0].title,'已保存');assert.equal(p.reports[0].text,'已保存日报');assert.equal(p.requirements[0].title,'已保存');assert.equal(p.requirementConfirmations[0].scenario,'已保存');assert.equal(reopened.verifyDailySaved(f.id,'2026-10-14').savedVerified,true);
});
test('主档案静默写失败不会提示成功，内存不展示未保存结果，独立版本能在重启恢复',t=>{
 const f=fixture(t),write=f.store._atomicWrite.bind(f.store);f.store._atomicWrite=(file,text)=>{if(file!==f.store.statePath)write(file,text);};
 assert.throws(()=>save(f,'2026-10-14','需恢复'),/回读核验/);assert.equal(f.store._project(f.id).records.length,0);
 const reopened=new Store(f.store.dataDir);assert.equal(reopened._project(f.id).records[0].title,'需恢复');assert.equal(reopened.verifyDailySaved(f.id,'2026-10-14').savedVerified,true);
});
test('历史版本文件写失败拒绝整次保存，不遗留假成功状态',t=>{
 const f=fixture(t),bytes=fs.readFileSync(f.store.statePath),write=f.store._atomicWrite.bind(f.store);f.store._atomicWrite=(file,text)=>{if(file.includes('历史版本'))throw Error('模拟磁盘故障');return write(file,text);};
 assert.throws(()=>save(f,'2026-10-14','未保存'),/模拟磁盘故障/);assert.deepEqual(fs.readFileSync(f.store.statePath),bytes);assert.equal(f.store._project(f.id).records.length,0);
});
test('旧档案及仅在导出文件中的当日成果迁移后保留，不从资料修改日期编造工作',t=>{
 const f=fixture(t),p=f.store._project(f.id),base=f.store.projectFolder(f.id);const st=JSON.parse(fs.readFileSync(f.store.statePath,'utf8'));delete st.historyFormatVersion;fs.writeFileSync(f.store.statePath,JSON.stringify(st));
 fs.mkdirSync(path.join(base,'工作记录'),{recursive:true});fs.mkdirSync(path.join(base,'日报'),{recursive:true});fs.writeFileSync(path.join(base,'工作记录','2026-10-16.md'),'# 项目\n\n## 已保存成果\n\n- 编号：auto-preserved\n- 确认：待确认，不纳入日报\n- 原因：有实际工作\n- 处理：完成处理\n- 结果：保存成功\n- 状态：已完成\n- 来源：原始会话\n');fs.writeFileSync(path.join(base,'日报','2026-10-16.md'),'当天已保存日报');
 const reopened=new Store(f.store.dataDir),saved=reopened._project(f.id);assert.equal(saved.records[0].id,'auto-preserved');assert.equal(saved.records[0].date,'2026-10-16');assert.equal(saved.records[0].action,'完成处理');assert.equal(saved.reports[0].text,'当天已保存日报');assert.equal(saved.dailyHistory['2026-10-16'][0].legacy,true);assert.equal(reopened.verifyDailySaved(f.id,'2026-10-16').savedVerified,true);
 f.store=reopened;save(f,'2026-10-16','本日增量');const updated=reopened._project(f.id);assert.ok(updated.records.some(row=>row.id==='auto-preserved'));assert.ok(updated.reports.find(row=>row.date==='2026-10-16').text.includes('已保存成果'));assert.ok(updated.reports.find(row=>row.date==='2026-10-16').text.includes('本日增量'));assert.equal(updated.dailyHistory['2026-10-16'][0].report.text,'当天已保存日报');
});
test('编辑旧日不会回滚项目当前需求，删除后重启不从旧导出文件复活',t=>{
 const f=fixture(t);save(f,'2026-10-14','旧日');save(f,'2026-10-15','当前日');save(f,'2026-10-14','旧日补充');assert.equal(f.store._project(f.id).requirements[0].title,'当前日');assert.equal(history.latest(f.store._project(f.id),'2026-10-14').requirements[0].title,'旧日补充');
 const record=f.store._project(f.id).records.find(row=>row.date==='2026-10-14');f.store.removeRecord(f.id,record.id);const p=new Store(f.store.dataDir)._project(f.id);assert.equal(p.records.filter(row=>row.date==='2026-10-14').length,0);assert.ok(p.dailyHistory['2026-10-14'].some(v=>v.records.length));assert.equal(p.dailyHistory['2026-10-14'].at(-1).records.length,0);
});
