'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {readProfile,profileDirectory}=require('../desktop/easyclaw-profile.cjs');
const {provisionOwner}=require('../desktop/easyclaw-owner.cjs');
const {identityHash,EasyClawAccess,startLocalBridge}=require('../desktop/easyclaw-access.cjs');
function fixture(t){const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'easyclaw-profile-'));t.after(()=>{assert.ok(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
test('旧安装保持原端口和原授权位置，新安装只读取指定独立档案',t=>{
 const root=fixture(t);assert.deepEqual(readProfile(root),{applicationId:'',port:35639,origin:'http://127.0.0.1:35639'});
 fs.writeFileSync(path.join(root,'fde-easyclaw.json'),JSON.stringify({applicationId:'app-scope',port:35640}));const profile=readProfile(root);
 assert.equal(profile.origin,'http://127.0.0.1:35640');const data=profileDirectory(profile.applicationId,{env:{LOCALAPPDATA:root}});
 assert.equal(data,path.join(root,'FDE Desk/accounts/app-scope/data'));assert.equal(fs.existsSync(data),false);
});
test('独立档案拒绝目录穿越和无效端口，不退回原数据',t=>{
 const root=fixture(t);for(const id of ['../data','A:/private','',{},'app/scope'])assert.throws(()=>profileDirectory(id));
 fs.writeFileSync(path.join(root,'fde-easyclaw.json'),JSON.stringify({applicationId:'scope',port:0}));assert.throws(()=>readProfile(root),/端口/);
 fs.writeFileSync(path.join(root,'fde-easyclaw.json'),JSON.stringify({applicationId:'../data',port:35640}));assert.throws(()=>readProfile(root),/标识/);
});
test('当前账号新建独立授权，不复制原数据、不改绑原授权，重复安装保持原文件',t=>{
 const root=fixture(t),legacy=path.join(root,'FDE Desk/data'),scope=profileDirectory('app-scope',{env:{LOCALAPPDATA:root}}),identityFile=path.join(root,'profile.json');
 fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'store.json'),'original-private-data');const old=JSON.stringify({version:1,accountHash:identityHash('original-owner')});fs.writeFileSync(path.join(legacy,'easyclaw-owner.json'),old);
 fs.writeFileSync(identityFile,JSON.stringify({uid:'current-owner'}));provisionOwner({identityFile,dataDir:scope,allowEmpty:true});
 assert.equal(fs.readFileSync(path.join(legacy,'easyclaw-owner.json'),'utf8'),old);assert.equal(fs.readFileSync(path.join(legacy,'store.json'),'utf8'),'original-private-data');assert.equal(fs.existsSync(path.join(scope,'store.json')),false);
 const file=path.join(scope,'easyclaw-owner.json'),saved=fs.readFileSync(file);assert.equal(JSON.parse(saved).accountHash,identityHash('current-owner'));provisionOwner({identityFile,dataDir:scope,allowEmpty:true});assert.deepEqual(fs.readFileSync(file),saved);
 fs.writeFileSync(identityFile,JSON.stringify({uid:'other-owner'}));assert.throws(()=>provisionOwner({identityFile,dataDir:scope,allowEmpty:true}),/另一个账号/);assert.deepEqual(fs.readFileSync(file),saved);
});
test('旧档案授权仍要求已有档案，无效身份不能创建目录或自动替换授权',t=>{
 const root=fixture(t),identityFile=path.join(root,'profile.json'),dataDir=path.join(root,'missing');fs.writeFileSync(identityFile,JSON.stringify({uid:'mock-owner'}));
 assert.throws(()=>provisionOwner({identityFile,dataDir}),/未找到/);assert.equal(fs.existsSync(dataDir),false);
 fs.writeFileSync(identityFile,'{invalid');assert.throws(()=>provisionOwner({identityFile,dataDir,allowEmpty:true}),/无法读取/);assert.equal(fs.existsSync(dataDir),false);
 fs.writeFileSync(identityFile,JSON.stringify({uid:'mock-owner'}));fs.mkdirSync(dataDir);fs.writeFileSync(path.join(dataDir,'store.json'),'existing');assert.throws(()=>provisionOwner({identityFile,dataDir,allowEmpty:true}),/未自动认领/);assert.equal(fs.existsSync(path.join(dataDir,'easyclaw-owner.json')),false);
});
test('独立服务健康检查标识安装，不暴露路径；其他账号不能读取该独立档案',async t=>{
 const root=fixture(t);fs.writeFileSync(path.join(root,'easyclaw-owner.json'),JSON.stringify({version:1,accountHash:identityHash('owner')}));
 const access=new EasyClawAccess({dataDir:root,verify:async h=>identityHash(h==='Bearer fixture-owner'?'owner':'other')});
 const server=await startLocalBridge({access,port:0,applicationId:'app-scope',version:'test',events:()=>({}),dispatch:()=>({projects:[]})});t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
 assert.deepEqual(await(await fetch(origin+'/health')).json(),{application:'fde-desk-easyclaw',version:'test',applicationId:'app-scope'});
 const r=await fetch(origin+'/api',{method:'POST',headers:{Authorization:'Bearer fixture-other'},body:JSON.stringify({action:'state',payload:{uid:'owner'}})});assert.equal(r.status,403);assert.ok(!(await r.text()).includes(root));
});
