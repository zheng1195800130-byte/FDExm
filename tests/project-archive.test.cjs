'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/core/store.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fde-archive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const data=path.join(dir,'data'),store=new Store(data),projects=[];
 for(const name of ['甲项目','乙项目']){const sourceDir=path.join(dir,name,'资料'),devDir=path.join(dir,name,'开发');fs.mkdirSync(sourceDir,{recursive:true});fs.mkdirSync(devDir,{recursive:true});projects.push(store.createProject({name,sourceDir,devDir}));}
 return {store,data,projects};
}
test('项目归档保留完整业务记录、文件与关联，并持久保存和恢复',async t=>{
 const {store,data,projects:[a,b]}=fixture(t);fs.writeFileSync(path.join(a.sourceDir,'说明.md'),'隔离说明');await store.scanProject(a.id);store.bindCodexThread(a.id,{threadId:'test-thread'});store.saveReport(a.id,'2026-10-10','甲项目完成测试');store.saveReport(b.id,'2026-10-10','乙项目完成测试');store.setSettings({activeProjectId:a.id});
 const memo=path.join(store.projectFolder(a.id),'隔离备忘录.json');fs.writeFileSync(memo,'{"text":"隔离笔记"}');const before=store.getState().projects[0];
 const archived=store.setProjectArchived(a.id,true);assert.ok(archived.archivedAt);assert.equal(archived.archiveRevision,1);assert.equal(store.getState().settings.activeProjectId,b.id);
 for(const key of ['files','records','requirements','requirementConfirmations','reports','codex','sourceDir','devDir','stage','cycles'])assert.deepEqual(archived[key],before[key]);assert.equal(fs.readFileSync(memo,'utf8'),'{"text":"隔离笔记"}');
 assert.equal(store.setProjectArchived(a.id,true).archiveRevision,1);assert.throws(()=>store.setSettings({activeProjectId:a.id}),/归档/);assert.ok(!store.combinedReport('2026-10-10').text.includes('甲项目'));assert.match(store.combinedReport('2026-10-10').text,/乙项目/);
 const reloaded=new Store(data);assert.ok(reloaded.getState().projects[0].archivedAt);fs.rmSync(a.sourceDir,{recursive:true});const restored=reloaded.setProjectArchived(a.id,false);assert.equal(restored.archivedAt,'');assert.equal(restored.archiveRevision,2);assert.equal(reloaded.getState().settings.activeProjectId,a.id);assert.deepEqual(restored.reports,before.reports);assert.match(reloaded.combinedReport('2026-10-10').text,/甲项目/);
});
test('全部项目归档后清空当前选择，恢复任一项目即可重新关注',t=>{
 const {store,projects:[a,b]}=fixture(t);store.setProjectArchived(a.id,true);store.setProjectArchived(b.id,true);assert.equal(store.getState().settings.activeProjectId,'');assert.equal(store.getState().projects.length,2);assert.match(store.combinedReport('2026-10-10').text,/暂无/);store.setProjectArchived(a.id,false);assert.equal(store.getState().settings.activeProjectId,a.id);assert.ok(store.getState().projects[1].archivedAt);
 assert.throws(()=>store.setProjectArchived(a.id,'yes'),/无效/);assert.throws(()=>store.setProjectArchived('missing',true));
});
