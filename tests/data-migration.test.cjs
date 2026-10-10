'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {resolveDataDirectory}=require('../desktop/data-location.cjs');
const {prepareDataDirectory,manifest}=require('../desktop/data-migration.cjs');
const {Store}=require('../src/core/store.cjs');
const {identity}=require('../src/core/material-tags.cjs');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fde-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'code'),localAppData=path.join(dir,'local-app-data'),exe=path.join(root,'release','FDE Desk-win32-x64','FDE Desk.exe'),legacy=path.join(path.dirname(exe),'data');fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'test');
 const options={root,execPath:exe,isPackaged:true,localAppData,env:{}},target=resolveDataDirectory(options);
 return {dir,root,legacy,target,options};
}
test('源码与安装程序统一指向用户数据目录，显式隔离目录不触发迁移',t=>{
 const f=fixture(t);assert.equal(resolveDataDirectory({...f.options,isPackaged:false}),f.target);assert.equal(f.target,path.join(f.options.localAppData,'FDE Desk','data'));assert.equal(fs.existsSync(f.target),false);
 const explicit=path.join(f.dir,'isolated');assert.equal(prepareDataDirectory({...f.options,env:{FDE_DATA_DIR:explicit}}),explicit);assert.equal(fs.existsSync(explicit),false);assert.equal(fs.existsSync(f.target),false);
});
test('完整备份后迁移，保留原件/密钥/记录/图片，补充资料路径和标签及检查点同步改址',async t=>{
 const f=fixture(t),source=path.join(f.dir,'客户原件'),dev=path.join(f.dir,'开发');fs.mkdirSync(source);fs.mkdirSync(dev);fs.writeFileSync(path.join(source,'需求.md'),'原始需求');
 const store=new Store(f.legacy),p=store.createProject({name:'测试项目',sourceDir:source,devDir:dev});await store.scanProject(p.id);
 const incoming=path.join(f.dir,'补充.md');fs.writeFileSync(incoming,'补充资料');await store.addFiles(p.id,[incoming]);
 const copied=store.getState().projects[0].files.find(x=>x.kind==='补充资料');store.setMaterialTags(p.id,identity(copied.kind,copied.path),['重要']);
 store.setSettings({summaryPreset:{instructions:'简洁',reportExample:'项目甲：完成导入。'}});store.saveReport(p.id,'2026-10-10','保留手写日报');
 const state=JSON.parse(fs.readFileSync(store.statePath,'utf8'));state.projects[0].dailyDesk={fileCheckpoints:{[copied.id]:hash([copied.path,copied.mtime,copied.textPreview,copied.description])}};fs.writeFileSync(store.statePath,JSON.stringify(state));
 fs.writeFileSync(path.join(f.legacy,'model-key.encrypted'),Buffer.from([1,4,9,16]));const memo=path.join(f.legacy,'projects',p.id,'memo');fs.mkdirSync(memo,{recursive:true});fs.writeFileSync(path.join(memo,'image.png'),Buffer.from([7,8,9]));
 fs.mkdirSync(path.join(f.legacy,'runtime'));fs.writeFileSync(path.join(f.legacy,'runtime','cache'),'不用迁移');const before=manifest(f.legacy);
 assert.equal(prepareDataDirectory(f.options),f.target);assert.ok(JSON.stringify(manifest(f.legacy))===JSON.stringify(before),'旧数据逐字节不变');
 const next=new Store(f.target).getState(),project=next.projects[0],file=project.files.find(x=>x.id===copied.id);assert.ok(file.path.startsWith(f.target+path.sep));assert.equal(fs.readFileSync(file.path,'utf8'),'补充资料');assert.equal(project.sourceDir,source);assert.equal(project.devDir,dev);
 assert.equal(project.reports[0].text,'保留手写日报');assert.equal(next.settings.summaryPreset.instructions,'简洁');assert.deepEqual(fs.readFileSync(path.join(f.target,'model-key.encrypted')),Buffer.from([1,4,9,16]));assert.deepEqual(fs.readFileSync(path.join(f.target,'projects',p.id,'memo','image.png')),Buffer.from([7,8,9]));assert.equal(fs.existsSync(path.join(f.target,'runtime')),false);
 assert.equal(project.dailyDesk.fileCheckpoints[file.id],hash([file.path,file.mtime,file.textPreview,file.description]));assert.ok(Object.values(project.materialAnnotations).some(a=>a.manual&&a.tags.includes('重要')));
 const backups=fs.readdirSync(path.join(path.dirname(f.target),'backups'));assert.equal(backups.length,1);assert.ok(JSON.stringify(manifest(path.join(path.dirname(f.target),'backups',backups[0])))===JSON.stringify(before));
 assert.equal(prepareDataDirectory(f.options),f.target);assert.equal(fs.readdirSync(path.join(path.dirname(f.target),'backups')).length,1);
});
test('统一目录已有内容时不被旧安装的档案覆盖',t=>{
 const f=fixture(t);new Store(f.legacy);const existing=new Store(f.target);existing.setSettings({summaryPreset:{instructions:'我的规则'}});const before=fs.readFileSync(existing.statePath);prepareDataDirectory(f.options);assert.deepEqual(fs.readFileSync(existing.statePath),before);
});
test('多个有项目的旧档案拒绝自动选择，损坏旧档案也不变成空项目',t=>{
 const f=fixture(t),state={version:1,settings:{},projects:[{id:'test'}]};for(const dir of [f.legacy,path.join(f.root,'data')]){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'store.json'),JSON.stringify(state));}
 assert.throws(()=>prepareDataDirectory(f.options),/多个旧数据目录/);assert.equal(fs.existsSync(f.target),false);
 fs.unlinkSync(path.join(f.root,'data','store.json'));fs.writeFileSync(path.join(f.legacy,'store.json'),'{broken');assert.throws(()=>prepareDataDirectory(f.options),/旧数据无法确认完整性/);assert.equal(fs.existsSync(f.target),false);
});
test('有有效备份的损坏主档案迁移后交给 Store 恢复',t=>{
 const f=fixture(t);new Store(f.legacy);fs.writeFileSync(path.join(f.legacy,'store.json'),'{broken');assert.equal(prepareDataDirectory(f.options),f.target);assert.match(new Store(f.target).recoveryWarning,/备份/);assert.equal(fs.readFileSync(path.join(f.legacy,'store.json'),'utf8'),'{broken');
});
test('没有项目但有模型设置的旧档案也迁移，不丢失预设',t=>{
 const f=fixture(t),store=new Store(f.legacy);store.setSettings({summaryPreset:{instructions:'保留个人风格'}});prepareDataDirectory(f.options);assert.equal(new Store(f.target).getState().settings.summaryPreset.instructions,'保留个人风格');
});
