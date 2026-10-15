'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/core/store.cjs');
function fixture(t){
  const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'store-sync-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const sourceDir=path.join(root,'source'),devDir=path.join(root,'dev');fs.mkdirSync(sourceDir);fs.mkdirSync(devDir);
  const store=new Store(path.join(root,'data')),project=store.createProject({name:'历史记录验收',sourceDir,devDir});
  return {root,store,id:project.id};
}
test('运行中重新读取本地新档案，工作、日报、需求与待确认事项一起更新，读取不改写档案',t=>{
  const {store,id}=fixture(t),writer=new Store(store.dataDir);
  writer.upsertRecord(id,{date:'2026-10-14',title:'昨天完成的工作',confirmed:true});
  writer.saveReport(id,'2026-10-14','昨天的日报正文');
  writer.upsertRequirement(id,{title:'昨天的业务要求'});
  writer.upsertRequirementConfirmation(id,{scenario:'昨天的业务场景',question:'待客户确认的问题'});
  const bytes=fs.readFileSync(store.statePath),backup=fs.readFileSync(store.backupPath);
  assert.equal(store.getState().projects[0].records.length,0);
  assert.equal(store.refreshFromDisk(),true);
  const p=store.getState().projects[0];assert.equal(p.records.length,1);assert.equal(p.reports[0].text,'昨天的日报正文');
  assert.equal(p.requirements.length,1);assert.equal(p.requirementConfirmations.length,1);
  assert.equal(store.refreshFromDisk(),false);assert.deepEqual(fs.readFileSync(store.statePath),bytes);assert.deepEqual(fs.readFileSync(store.backupPath),backup);
});
test('旧实例写入前发现外部更新时拒绝覆盖，保留新档案与备份并允许刷新后重试',t=>{
  const {store,id}=fixture(t),writer=new Store(store.dataDir);
  writer.saveReport(id,'2026-10-14','不能丢失的昨天日报');
  const bytes=fs.readFileSync(store.statePath),backup=fs.readFileSync(store.backupPath);
  assert.throws(()=>store.setSettings({alwaysOnTop:true}),/档案已.*更新/);
  assert.deepEqual(fs.readFileSync(store.statePath),bytes);assert.deepEqual(fs.readFileSync(store.backupPath),backup);
  assert.equal(store.getState().projects[0].reports[0].text,'不能丢失的昨天日报');
  store.setSettings({alwaysOnTop:true});assert.equal(new Store(store.dataDir).getState().projects[0].reports[0].text,'不能丢失的昨天日报');
});
test('运行中档案缺失或损坏时明确报错，不静默回退旧备份或覆盖原文件',t=>{
  const {store}=fixture(t);fs.writeFileSync(store.statePath,'{broken');const backup=fs.readFileSync(store.backupPath);
  assert.throws(()=>store.refreshFromDisk(),/本地档案.*读取/);
  assert.throws(()=>store.setSettings({alwaysOnTop:true}),/本地档案.*读取/);
  assert.equal(fs.readFileSync(store.statePath,'utf8'),'{broken');assert.deepEqual(fs.readFileSync(store.backupPath),backup);
  fs.unlinkSync(store.statePath);assert.throws(()=>store.refreshFromDisk(),/本地档案.*读取/);assert.equal(fs.existsSync(store.statePath),false);
});
test('刷新后拒绝在途旧项目对象提交，不让旧归档文件覆盖新历史',t=>{
  const {store,id}=fixture(t),oldProject=store._project(id),writer=new Store(store.dataDir);
  writer.saveReport(id,'2026-10-14','新的历史日报');store.refreshFromDisk();
  oldProject.reports=[];
  assert.throws(()=>store._commit(oldProject),/档案已更新/);
  assert.equal(fs.readFileSync(path.join(store.projectFolder(id),'日报','2026-10-14.md'),'utf8'),'新的历史日报');
});
test('启动恢复备份期间出现新的主档案时拒绝用旧备份覆盖',t=>{
  const {store,id}=fixture(t);store.saveReport(id,'2026-10-14','最新的完整日报');
  const latest=fs.readFileSync(store.statePath),backup=fs.readFileSync(store.backupPath),copy=fs.copyFileSync;
  fs.writeFileSync(store.statePath,'{broken');
  fs.copyFileSync=(from,to,...args)=>{const result=copy(from,to,...args);if(from===store.statePath)fs.writeFileSync(store.statePath,latest);return result;};
  try{assert.throws(()=>new Store(store.dataDir),/档案已.*更新/);}finally{fs.copyFileSync=copy;}
  assert.deepEqual(fs.readFileSync(store.statePath),latest);assert.deepEqual(fs.readFileSync(store.backupPath),backup);
});
