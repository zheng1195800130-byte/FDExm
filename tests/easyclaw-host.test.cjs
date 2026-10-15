'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(){const {createEasyClawRuntime}=await import('../easyclaw/host-runtime.mjs');let login=0,launch=0,requests=[],locked=[];
 const scope={setInterval:()=>1,clearInterval:()=>{},easyclawAuth:{getSession:async()=>({authenticated:true,profile:{uid:'owner'}}),login:async()=>{login++;return {authenticated:true,profile:{uid:'owner'}};},request:async input=>{requests.push(input);return {status:200,body:JSON.stringify({ok:true,value:{revision:0,day:'2026-10-15'}})};}},EasyClawPython:{run:async()=>{launch++;return {result:true,data:{ready:true}};}}};
 return {scope,createEasyClawRuntime,make:()=>createEasyClawRuntime(scope,{onLocked:e=>locked.push(e)}),counts:()=>({login,launch}),requests,locked};}
test('Ticket 已有会话不重复登录，后端请求不发送页面 Profile 作为证明',async()=>{const f=await fixture(),r=f.make();await r.connect();assert.deepEqual(f.counts(),{login:0,launch:1});assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.requests[0].body).payload.uid,undefined);r.dispose();});
test('未认证只在用户触发后登录一次，缺少可信 Profile 停止',async()=>{const f=await fixture();f.scope.easyclawAuth.getSession=async()=>({authenticated:false});const r=f.make();await assert.rejects(r.connect(),/验证/);assert.equal(f.counts().login,0);await r.connect({login:true});assert.equal(f.counts().login,1);r.dispose();f.scope.easyclawAuth.getSession=async()=>({authenticated:true});await assert.rejects(f.make().connect(),/验证/);});
test('延迟注入的宿主桥可使用；普通浏览器不创建假身份和本地数据',async()=>{const f=await fixture(),auth=f.scope.easyclawAuth;delete f.scope.easyclawAuth;const r=f.make();await assert.rejects(r.connect(),/EasyClaw/);assert.equal(f.counts().launch,0);f.scope.easyclawAuth=auth;await r.connect();assert.equal(f.counts().launch,1);r.dispose();});
test('其他账号或过期会话导致页面清空私人内容，业务校验失败不冒充账号失效',async()=>{const f=await fixture(),r=f.make(),events=[];r.onChange(e=>events.push(e));await r.connect();f.scope.easyclawAuth.request=async()=>({status:400,body:{ok:false,error:'标题不能为空'}});await assert.rejects(r.request('record:save'),/标题/);assert.equal(f.locked.length,0);f.scope.easyclawAuth.request=async()=>({status:403,body:{ok:false,error:'账号无权访问'}});await assert.rejects(r.request('state'),/无权/);assert.equal(f.locked.length,1);assert.equal(events[0].accessDenied,true);r.dispose();});

test('真实宿主请求上限内拼接大档案，等待完成期间继续保持认证',async()=>{
 const f=await fixture(),r=f.make();await r.connect();let count=0;
 f.scope.setTimeout=callback=>{callback();return 1;};
 f.scope.easyclawAuth.request=async input=>{
  assert.ok(input.timeoutMs<=30000);const {action,payload}=JSON.parse(input.body);let value;
  if(action==='bridge:start')value={id:'job-1'};
  else if(count++===0)value={pending:true};
  else if(payload.offset===0)value={chunk:'{"ok":true,"value":"历史',next:20,done:false};
  else value={chunk:'日报"}',next:25,done:true};
  return {status:200,body:{ok:true,value}};
 };
 assert.equal(await r.request('state'),'历史日报');r.dispose();
});
