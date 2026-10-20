'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),asar=require('@electron/asar'),ignore=require('ignore');
const {unpackNativeApp,updatePublishIgnore}=require('../scripts/easyclaw-publish.cjs');
const ROOT=path.resolve(__dirname,'..','.test-tmp');
fs.mkdirSync(ROOT,{recursive:true});
function fixture(t){const root=fs.mkdtempSync(path.join(ROOT,'publish-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('发布布局保留全部依赖，备份旧包并支持重复同步',async t=>{
  const root=fixture(t),source=path.join(root,'source'),resources=path.join(root,'app','native','resources'),archive=path.join(resources,'app.asar'),backupDirectory=path.join(root,'backups');
  fs.mkdirSync(path.join(source,'desktop'),{recursive:true});fs.mkdirSync(path.join(source,'node_modules','fixture'),{recursive:true});fs.mkdirSync(resources,{recursive:true});
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'fde-desk',version:'0.0.1',main:'desktop/main.cjs'}));
  fs.writeFileSync(path.join(source,'desktop','main.cjs'),'require("fixture");');fs.writeFileSync(path.join(source,'node_modules','fixture','index.js'),'module.exports=42;');
  await asar.createPackage(source,archive);const original=fs.readFileSync(archive);
  assert.equal(unpackNativeApp({archive,resources,backupDirectory}).layout,'resources/app');
  assert.ok(!fs.existsSync(archive));assert.deepEqual(fs.readFileSync(path.join(backupDirectory,fs.readdirSync(backupDirectory)[0])),original);
  assert.equal(require(path.join(resources,'app','node_modules','fixture')),42);
  const savedArchive=path.join(backupDirectory,fs.readdirSync(backupDirectory)[0]);
  fs.writeFileSync(path.join(resources,'app','obsolete.txt'),'old');
  unpackNativeApp({archive:savedArchive,resources,backupDirectory});assert.ok(!fs.existsSync(path.join(resources,'app','obsolete.txt')));
  assert.deepEqual(fs.readdirSync(resources),['app']);
});

test('发布过滤保留嵌套运行依赖，同时排除个人数据和授权',t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'.easyclawignore'),'# Preserve release customizations\ncustom-exclude/\nnode_modules/\n');
  updatePublishIgnore(root);const once=fs.readFileSync(path.join(root,'.easyclawignore'),'utf8');updatePublishIgnore(root);
  assert.equal(fs.readFileSync(path.join(root,'.easyclawignore'),'utf8'),once);assert.ok(once.startsWith('# Preserve release customizations'));
  const filter=ignore().add(once);
  for(const file of ['client/node_modules/marked/lib/marked.esm.js','native/resources/app/node_modules/pdf-parse/node_modules/debug/src/index.js','native/resources/app/desktop/main.cjs'])assert.equal(filter.ignores(file),false,file);
  for(const file of ['native/resources/app.asar','native/resources/app.asar.unpacked/addon.node','node_modules/dev-only/index.js','data/store.json','accounts/owner/data/store.json','backups/old.json','native/resources/app/model-key.encrypted','native/resources/app/easyclaw-owner.json','.env','custom-exclude/a'])assert.equal(filter.ignores(file),true,file);
});

test('被宿主占用时只允许保留相同版本的本地旧包，发布仍排除旧包',async t=>{
  const root=fixture(t),source=path.join(root,'source'),resources=path.join(root,'app','native','resources'),backupDirectory=path.join(root,'backup');
  fs.mkdirSync(source);fs.mkdirSync(resources,{recursive:true});
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'fde-desk',main:'desktop/main.cjs',version:'0.0.1'}));
  const archive=path.join(resources,'app.asar');await asar.createPackage(source,archive);
  const unlink=fs.unlinkSync;fs.unlinkSync=file=>{if(file===archive)throw Object.assign(Error('locked'),{code:'EBUSY'});return unlink(file);};
  try{
    assert.equal(unpackNativeApp({archive,resources,backupDirectory}).retainedArchive,true);
    updatePublishIgnore(path.join(root,'app'));assert.ok(ignore().add(fs.readFileSync(path.join(root,'app','.easyclawignore'),'utf8')).ignores('native/resources/app.asar'));
    fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'fde-desk',main:'desktop/main.cjs',version:'0.0.2'}));
    const next=path.join(root,'next.asar');await asar.createPackage(source,next);
    assert.throws(()=>unpackNativeApp({archive:next,resources,backupDirectory}),/退出 EasyClaw/);
  }finally{fs.unlinkSync=unlink;}
});

test('不替换其他应用，也不在发布目录内保存旧包',async t=>{
  const root=fixture(t),source=path.join(root,'source'),resources=path.join(root,'app','native','resources');fs.mkdirSync(source);fs.mkdirSync(resources,{recursive:true});
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'other',main:'desktop/main.cjs'}));const archive=path.join(root,'other.asar');await asar.createPackage(source,archive);
  assert.throws(()=>unpackNativeApp({archive,resources,backupDirectory:path.join(root,'backup')}),/不是 FDE Desk/);assert.deepEqual(fs.readdirSync(resources),[]);
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({name:'fde-desk',main:'desktop/main.cjs'}));await asar.createPackage(source,path.join(resources,'app.asar'));
  assert.throws(()=>unpackNativeApp({archive:path.join(resources,'app.asar'),resources,backupDirectory:path.join(resources,'backup')}),/发布目录外/);
  assert.ok(fs.existsSync(path.join(resources,'app.asar')));
});
