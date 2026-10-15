'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {identityHash,accountId,verifyUser,EasyClawAccess,startLocalBridge,ISSUER}=require('../desktop/easyclaw-access.cjs');
function fixture(t){const base=path.resolve(__dirname,'../.test-tmp');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'easyclaw-access-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'easyclaw-owner.json'),JSON.stringify({version:1,accountHash:identityHash('owner')}));return dir;}
test('账号验证只调用正式 UserInfo，不相信页面自报身份，不保留令牌',async t=>{
 const dir=fixture(t);let now=1000,calls=0,revoked=0;
 const access=new EasyClawAccess({dataDir:dir,now:()=>now,onRevoke:()=>revoked++,verify:async header=>{calls++;return identityHash(header==='Bearer mock-owner'?'owner':'another');}});
 await access.authorize('Bearer mock-owner');assert.equal(access.allowed(),true);await access.authorize('Bearer mock-owner');assert.equal(calls,1);
 assert.ok(!JSON.stringify(access).includes('mock-owner'));
 await assert.rejects(access.authorize('Bearer mock-other'),/没有.*访问权限/);assert.equal(access.allowed(),false);assert.equal(revoked,1);
 await access.authorize('Bearer mock-owner');now+=21000;assert.equal(access.allowed(),false);
});
test('官方认证失败和网络中断时停止，不退回身份文件或匿名访问',async()=>{
 let calls=0;
 await assert.rejects(verifyUser('',async()=>{calls++;}),/先.*登录/);assert.equal(calls,0);
 await assert.rejects(verifyUser('Bearer mock',async()=>({ok:true,json:async()=>{throw new Error('invalid');}})),/结果无效/);
 const result=await verifyUser('Bearer mock',async(url,options)=>{assert.equal(url,ISSUER+'/api/v1/oidc/standard/userinfo');assert.equal(options.redirect,'error');return {ok:true,json:async()=>({uid:'owner',token:'not-returned'})};});assert.equal(result,identityHash('owner'));
 await assert.rejects(verifyUser('Bearer mock',async()=>{throw new Error('network');}),/暂不可用/);
 await assert.rejects(verifyUser('Bearer mock',async()=>({ok:false})),/登录已失效/);
 assert.throws(()=>accountId({uid:9007199254740992}),/无法确认/);
});
test('本地接口拒绝未登录、其他账号及伪造 profile，未授权不触发数据处理',async t=>{
 const dir=fixture(t),access=new EasyClawAccess({dataDir:dir,verify:async h=>{if(!h)throw Object.assign(new Error('请先登录'),{status:401});return identityHash(h==='Bearer mock-owner'?'owner':'other');}});let dispatches=0;
 const server=await startLocalBridge({access,version:'test',port:0,events:()=>({revision:1}),dispatch:async()=>{dispatches++;return {records:['private']};}});t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 let response=await fetch(origin+'/api',{method:'POST',body:JSON.stringify({action:'state',payload:{profile:{uid:'owner'}}})});assert.equal(response.status,401);assert.equal(dispatches,0);
 response=await fetch(origin+'/api',{method:'POST',headers:{Authorization:'Bearer mock-other'},body:JSON.stringify({action:'state',payload:{uid:'owner'}})});assert.equal(response.status,403);assert.equal(dispatches,0);assert.ok(!(await response.text()).includes('private'));
 response=await fetch(origin+'/api',{method:'POST',headers:{Authorization:'Bearer mock-owner'},body:JSON.stringify({action:'state'})});assert.equal(response.status,200);assert.equal((await response.json()).value.records[0],'private');assert.equal(dispatches,1);
 const health=await (await fetch(origin+'/health')).json();assert.deepEqual(Object.keys(health).sort(),['application','version']);
});
test('身份授权在长操作中失效后不返回已有私人结果',async t=>{
 const dir=fixture(t);let now=1;const access=new EasyClawAccess({dataDir:dir,now:()=>now,verify:async()=>identityHash('owner')});
 const server=await startLocalBridge({access,version:'test',port:0,events:()=>({}),dispatch:async()=>{now+=21000;return 'private-result';}});t.after(()=>new Promise(r=>server.close(r)));
 const r=await fetch('http://127.0.0.1:'+server.address().port+'/api',{method:'POST',headers:{Authorization:'Bearer mock-owner'},body:JSON.stringify({action:'state'})});assert.equal(r.status,401);assert.ok(!(await r.text()).includes('private-result'));
});

test('宿主分段读取超出 2 MiB 的档案，等待任务不阻塞；换账号废弃未读取结果',async t=>{
 const dir=fixture(t),access=new EasyClawAccess({dataDir:dir,verify:async h=>identityHash(h==='Bearer mock-owner'?'owner':'other')});
 let release;const finished=new Promise(r=>release=r);
 const server=await startLocalBridge({access,version:'test',port:0,events:()=>({revision:1}),dispatch:async()=>{await finished;return '历史资料'.repeat(400000);}});t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 const request=async(action,payload={},auth='mock-owner')=>{const r=await fetch(origin+'/api',{method:'POST',headers:{Authorization:'Bearer '+auth},body:JSON.stringify({action,payload})});return {status:r.status,...await r.json()};};
 const job=(await request('bridge:start',{action:'state'})).value;
 assert.deepEqual((await request('bridge:result',{id:job.id})).value,{pending:true});release();
 let offset=0,text='',chunks=0;for(;;){const r=await request('bridge:result',{id:job.id,offset});assert.equal(r.status,200);assert.ok(Buffer.byteLength(JSON.stringify(r))<2*1024*1024);const p=r.value;text+=p.chunk;offset=p.next;chunks++;if(p.done)break;}
 assert.ok(chunks>1);assert.equal(JSON.parse(text).value,'历史资料'.repeat(400000));
 const stale=(await request('bridge:start',{action:'state'})).value;
 assert.equal((await request('bridge:result',{id:stale.id},'mock-other')).status,403);
 assert.equal((await request('bridge:result',{id:stale.id})).status,409);
});
